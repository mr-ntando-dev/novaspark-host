'use strict';

/**
 * bot-engine.js — NovaSpark V11 Bot Process Manager
 *
 * Handles cloning repos, spawning bot processes, watchdog health checks,
 * auto-restart with exponential backoff, and resource monitoring.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Bots, BotLogs, Notifications, Users } = require('../database');

const BOTS_DIR = path.join(__dirname, '..', '..', 'data', 'bots');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// In-memory process registry
const processes = new Map(); // botId -> { proc, restartCount, lastRestart, backoffMs }

const BOT_WATCHDOG_INTERVAL = parseInt(process.env.BOT_WATCHDOG_INTERVAL_MS) || 120000;
const BOT_MAX_RAM_MB = parseInt(process.env.BOT_MAX_RAM_MB) || 512;
const BOT_RESTART_BACKOFF_BASE = 3000;
const BOT_RESTART_BACKOFF_MAX = 5 * 60 * 1000;
const BOT_MAX_RESTARTS = 9999;

// Noise patterns to suppress from WhatsApp/Baileys stderr
const NOISE_PATTERNS = [
  /waiting for messages/i,
  /waiting for connection/i,
  /qr code/i,
  /reconnecting/i,
  /connection closed/i,
  /trying to reconnect/i,
  /keepAlive/i,
  /ping timeout/i,
  /socket closed/i,
];

/**
 * Clone a bot repository
 */
function cloneRepo(botId, repoUrl, branch = 'main') {
  const botDir = path.join(BOTS_DIR, botId);
  if (fs.existsSync(botDir)) {
    // Pull latest
    try {
      execSync(`cd "${botDir}" && git pull origin ${branch}`, { timeout: 60000, stdio: 'pipe' });
      BotLogs.add(botId, 'info', `Pulled latest from ${branch}`);
    } catch (e) {
      BotLogs.add(botId, 'warn', `Git pull failed, re-cloning: ${e.message}`);
      fs.rmSync(botDir, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(botDir)) {
    try {
      execSync(`git clone --depth 1 --branch ${branch} "${repoUrl}" "${botDir}"`, { timeout: 120000, stdio: 'pipe' });
      BotLogs.add(botId, 'info', `Cloned ${repoUrl} (${branch})`);
    } catch (e) {
      BotLogs.add(botId, 'error', `Clone failed: ${e.message}`);
      throw new Error(`Failed to clone repository: ${e.message}`);
    }
  }

  // Write env vars into config files (settings.js, config.env, etc.) for bots that don't read process.env
  const bot = Bots.findById(botId);
  if (bot) {
    writeConfigFiles(botId, botDir, bot);
  }

  // Install dependencies — detect yarn vs npm
  const pkgPath = path.join(botDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const yarnLock = path.join(botDir, 'yarn.lock');
    const installCmd = fs.existsSync(yarnLock)
      ? `cd "${botDir}" && npx yarn install --network-concurrency 1 --ignore-engines`
      : `cd "${botDir}" && npm install --production`;
    try {
      execSync(installCmd, { timeout: 180000, stdio: 'pipe' });
      BotLogs.add(botId, 'info', `Dependencies installed (${fs.existsSync(yarnLock) ? 'yarn' : 'npm'})`);
    } catch (e) {
      BotLogs.add(botId, 'warn', `Install warning: ${e.message}`);
    }
  }

  return botDir;
}

/**
 * Write environment variables into bot-specific config files.
 * Many WhatsApp bots (SubZero, etc.) read config from a JS/JSON file
 * instead of process.env. This function detects common patterns and
 * writes the user's env vars into the appropriate config file.
 */
function writeConfigFiles(botId, botDir, bot) {
  let envVars = {};
  try { envVars = JSON.parse(bot.env_vars || '{}'); } catch (_) {}
  if (!envVars || Object.keys(envVars).length === 0) return;

  // Pattern 1: settings.js (SubZero-style) — module.exports = { KEY: "value", ... }
  const settingsPath = path.join(botDir, 'settings.js');
  if (fs.existsSync(settingsPath)) {
    try {
      const original = fs.readFileSync(settingsPath, 'utf8');
      let modified = original;

      for (const [key, value] of Object.entries(envVars)) {
        // Match patterns like:  SESSION_ID: "...",  or  SESSION_ID: '...',
        const regex = new RegExp(`(${key}\\s*:\\s*)(['"\`])([^'"\`]*)\\2`, 'g');
        if (regex.test(modified)) {
          modified = modified.replace(
            new RegExp(`(${key}\\s*:\\s*)(['"\`])([^'"\`]*)\\2`, 'g'),
            `$1$2${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}$2`
          );
        }
      }

      if (modified !== original) {
        fs.writeFileSync(settingsPath, modified, 'utf8');
        BotLogs.add(botId, 'info', 'Wrote config to settings.js');
      }
    } catch (e) {
      BotLogs.add(botId, 'warn', `Failed to write settings.js: ${e.message}`);
    }
  }

  // Pattern 2: config.env file (Levanter-style) — KEY=value per line
  const configEnvPath = path.join(botDir, 'config.env');
  // Always write config.env if .env or config.env.example exists (bot reads from config.env)
  const configEnvExample = path.join(botDir, 'config.env.example');
  if (fs.existsSync(configEnvExample) || fs.existsSync(configEnvPath)) {
    try {
      const lines = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
      fs.writeFileSync(configEnvPath, lines.join('\n') + '\n', 'utf8');
      BotLogs.add(botId, 'info', 'Wrote config to config.env');
    } catch (e) {
      BotLogs.add(botId, 'warn', `Failed to write config.env: ${e.message}`);
    }
  }

  // Pattern 3: .env file — always write as a fallback for bots using dotenv
  const envFilePath = path.join(botDir, '.env');
  try {
    const lines = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(envFilePath, lines.join('\n') + '\n', 'utf8');
    BotLogs.add(botId, 'info', 'Wrote .env file');
  } catch (e) {
    BotLogs.add(botId, 'warn', `Failed to write .env: ${e.message}`);
  }
}

/**
 * Start a bot process (isolated — failures here never crash the platform)
 */
function startBot(botId) {
  const bot = Bots.findById(botId);
  if (!bot) throw new Error('Bot not found');
  if (processes.has(botId)) throw new Error('Bot already running');

  const botDir = path.join(BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) {
    if (!bot.repo_url) throw new Error('No repository configured');
    cloneRepo(botId, bot.repo_url, bot.branch || 'main');
  }

  // Always write config files on start (in case env vars were updated)
  writeConfigFiles(botId, botDir, bot);

  const entryPoint = bot.entry_point || 'index.js';
  const entryPath = path.join(botDir, entryPoint);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry point not found: ${entryPoint}`);
  }

  // Parse env vars
  let envVars = {};
  try { envVars = JSON.parse(bot.env_vars || '{}'); } catch (_) {}

  // Determine max RAM for this bot (from DB or global default)
  const maxRam = bot.max_ram_mb || BOT_MAX_RAM_MB;

  let proc;
  try {
    proc = spawn('node', [`--max-old-space-size=${maxRam}`, entryPoint], {
      cwd: botDir,
      env: {
        ...process.env,
        ...envVars,
        NODE_ENV: 'production',
        BOT_ID: botId,
        BOT_NAME: bot.name,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
  } catch (spawnErr) {
    BotLogs.add(botId, 'error', `Failed to spawn process: ${spawnErr.message}`);
    Bots.update(botId, { status: 'failed' });
    throw new Error(`Failed to spawn bot process: ${spawnErr.message}`);
  }

  // Guard: if spawn returned but process immediately errored
  if (!proc || !proc.pid) {
    BotLogs.add(botId, 'error', 'Process spawn returned no PID');
    Bots.update(botId, { status: 'failed' });
    throw new Error('Bot process failed to start (no PID)');
  }

  const record = { proc, restartCount: 0, lastRestart: Date.now(), backoffMs: BOT_RESTART_BACKOFF_BASE };
  processes.set(botId, record);

  // Capture stdout (wrapped in try/catch — bot stdout should NEVER crash the platform)
  proc.stdout.on('data', (data) => {
    try {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        BotLogs.add(botId, 'info', line.slice(0, 500));
      }
    } catch (_) { /* swallow */ }
  });

  // Capture stderr (filter noise, wrapped in try/catch)
  proc.stderr.on('data', (data) => {
    try {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        const isNoise = NOISE_PATTERNS.some(p => p.test(line));
        if (!isNoise) {
          BotLogs.add(botId, 'error', line.slice(0, 500));
        }
      }
    } catch (_) { /* swallow */ }
  });

  // Guard: if child process errors on its own handle (e.g. EACCES, ENOENT)
  proc.on('error', (err) => {
    try {
      BotLogs.add(botId, 'error', `Process error: ${err.message}`);
      processes.delete(botId);
      Bots.update(botId, { status: 'crashed', pid: null });
    } catch (_) {}
  });

  // Handle exit
  proc.on('exit', (code, signal) => {
    processes.delete(botId);
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    BotLogs.add(botId, 'warn', `Process exited (${reason})`);

    // Update DB
    Bots.update(botId, { status: 'crashed', pid: null });

    // Auto-restart logic
    const freshBot = Bots.findById(botId);
    if (freshBot && freshBot.auto_restart && record.restartCount < BOT_MAX_RESTARTS) {
      const backoff = Math.min(record.backoffMs * Math.pow(1.5, record.restartCount), BOT_RESTART_BACKOFF_MAX);
      BotLogs.add(botId, 'info', `Auto-restarting in ${Math.round(backoff / 1000)}s (attempt ${record.restartCount + 1})`);

      setTimeout(() => {
        try {
          startBot(botId);
          const newRecord = processes.get(botId);
          if (newRecord) {
            newRecord.restartCount = record.restartCount + 1;
          }
          Bots.update(botId, { total_restarts: (freshBot.total_restarts || 0) + 1 });
        } catch (e) {
          BotLogs.add(botId, 'error', `Auto-restart failed: ${e.message}`);
          Bots.update(botId, { status: 'crashed' });
        }
      }, backoff);
    }
  });

  // Update DB
  Bots.update(botId, {
    status: 'running',
    pid: proc.pid,
    start_time: new Date().toISOString(),
    last_health_check: new Date().toISOString(),
    health_status: 'healthy'
  });

  BotLogs.add(botId, 'info', `Bot started (PID: ${proc.pid})`);
  return { pid: proc.pid, status: 'running' };
}

/**
 * Stop a bot process
 */
function stopBot(botId) {
  const record = processes.get(botId);
  if (!record) {
    Bots.update(botId, { status: 'stopped', pid: null });
    return { status: 'stopped' };
  }

  // Disable auto-restart for this stop
  const bot = Bots.findById(botId);
  record.restartCount = BOT_MAX_RESTARTS; // prevent auto-restart on kill

  try {
    record.proc.kill('SIGTERM');
    // Force kill after 5s
    setTimeout(() => {
      try { record.proc.kill('SIGKILL'); } catch (_) {}
    }, 5000);
  } catch (_) {}

  processes.delete(botId);
  Bots.update(botId, { status: 'stopped', pid: null });
  BotLogs.add(botId, 'info', 'Bot stopped by user');

  return { status: 'stopped' };
}

/**
 * Restart a bot
 */
function restartBot(botId) {
  stopBot(botId);
  // Small delay to let process die
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        const result = startBot(botId);
        resolve(result);
      } catch (e) {
        resolve({ status: 'error', message: e.message });
      }
    }, 2000);
  });
}

/**
 * Get bot runtime info
 */
function getBotInfo(botId) {
  const record = processes.get(botId);
  const bot = Bots.findById(botId);
  if (!bot) return null;

  const isRunning = !!record;
  let uptimeSeconds = 0;
  if (isRunning && bot.start_time) {
    uptimeSeconds = Math.floor((Date.now() - new Date(bot.start_time).getTime()) / 1000);
  }

  return {
    ...bot,
    is_running: isRunning,
    pid: record ? record.proc.pid : null,
    uptime_seconds: uptimeSeconds,
    restart_count: record ? record.restartCount : 0
  };
}

/**
 * Get all running bots
 */
function getRunningBots() {
  const running = [];
  for (const [botId, record] of processes) {
    running.push({ botId, pid: record.proc.pid, restartCount: record.restartCount });
  }
  return running;
}

/**
 * Watchdog — check all running bots
 */
function runWatchdog() {
  for (const [botId, record] of processes) {
    try {
      // Check if process is still alive
      process.kill(record.proc.pid, 0);
      Bots.update(botId, { last_health_check: new Date().toISOString(), health_status: 'healthy' });
    } catch (e) {
      // Process is dead but we didn't get exit event
      BotLogs.add(botId, 'error', 'Watchdog: process not responding');
      processes.delete(botId);
      Bots.update(botId, { status: 'crashed', pid: null, health_status: 'dead' });
    }
  }
}

/**
 * Delete bot files
 */
function deleteBotFiles(botId) {
  const botDir = path.join(BOTS_DIR, botId);
  if (fs.existsSync(botDir)) {
    fs.rmSync(botDir, { recursive: true, force: true });
  }
}

/**
 * Start the watchdog interval
 */
let watchdogInterval = null;
function startWatchdog() {
  if (watchdogInterval) return;
  watchdogInterval = setInterval(runWatchdog, BOT_WATCHDOG_INTERVAL);
  console.log(`[Watchdog] Running every ${BOT_WATCHDOG_INTERVAL / 1000}s`);
}

function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

module.exports = {
  cloneRepo,
  startBot,
  stopBot,
  restartBot,
  getBotInfo,
  getRunningBots,
  deleteBotFiles,
  startWatchdog,
  stopWatchdog,
  processes,
  BOTS_DIR
};
