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
const {
  backupSessionToDb,
  restoreSessionFromDb,
  evictBotFromDisk,
  runDiskWatchdog
} = require('./storage-manager');

const BOTS_DIR = path.join(__dirname, '..', '..', 'data', 'bots');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// ─── MALICIOUS / FAKE PACKAGES ────────────────────────────────────────────────
// xsqlite3 is a non-existent npm package injected by supply-chain attacks.
// Its deeply-nested core0/.../coreN structure causes ERR_MODULE_NOT_FOUND on
// every launch. We must physically delete it from node_modules before starting.
const MALICIOUS_PACKAGES = ['xsqlite3'];

/**
 * Physically remove known malicious packages from a bot's node_modules directory.
 * Called at every bot start — catches already-installed packages that slipped
 * through the package.json stripper (e.g. installed in a previous deploy).
 */
function purgeMaliciousModules(botId, botDir) {
  const nmDir = path.join(botDir, 'node_modules');
  if (!fs.existsSync(nmDir)) return;
  for (const pkg of MALICIOUS_PACKAGES) {
    const pkgDir = path.join(nmDir, pkg);
    if (fs.existsSync(pkgDir)) {
      try {
        fs.rmSync(pkgDir, { recursive: true, force: true });
        BotLogs.add(botId, 'warn', `⚠️ Purged malicious package "${pkg}" from node_modules`);
      } catch (e) {
        BotLogs.add(botId, 'warn', `Failed to purge "${pkg}": ${e.message}`);
      }
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────
const processes = new Map(); // botId -> { proc, restartCount, lastRestart, backoffMs }

const BOT_WATCHDOG_INTERVAL = parseInt(process.env.BOT_WATCHDOG_INTERVAL_MS) || 120000;
const BOT_MAX_RAM_MB = parseInt(process.env.BOT_MAX_RAM_MB) || 512;
const BOT_RESTART_BACKOFF_BASE = 15000; // 15s minimum — prevents 440 session collisions
const BOT_RESTART_BACKOFF_MAX = 5 * 60 * 1000;
const BOT_MAX_RESTARTS = 9999;

// Fatal WhatsApp errors that should STOP auto-restart (restarting makes them worse)
const FATAL_WA_PATTERNS = [
  /440/,
  /connectionReplaced/i,
  /Stream Errored/i,
  /loggedOut/i,
  /Attempted to open a second protocol session/i,
];

// Noise patterns to suppress from WhatsApp/Baileys stderr
// NOTE: do NOT add qr/QR here — we need to detect and forward those to the dashboard
const NOISE_PATTERNS = [
  /waiting for messages/i,
  /waiting for connection/i,
  /reconnecting/i,
  /connection closed/i,
  /trying to reconnect/i,
  /keepAlive/i,
  /ping timeout/i,
  /socket closed/i,
];

// QR detection patterns (Baileys outputs QR as ASCII art or base64 data URLs)
const QR_PATTERNS = [
  /data:image\/png;base64,/i,
  /▄|█|▀/,  // block characters used in terminal QR art
];

// WebSocket broadcaster — injected by server.js after boot
let _wsBroadcast = null;
let _wsBroadcastAll = null;
function setWsBroadcast(broadcastFn, broadcastAllFn) {
  _wsBroadcast = broadcastFn;
  _wsBroadcastAll = broadcastAllFn;
}

function broadcastBotStatus(ownerId, botId, status, extra = {}) {
  if (_wsBroadcast) {
    try { _wsBroadcast(ownerId, { type: 'bot_status', botId, status, ...extra }); } catch (_) {}
  }
}

function broadcastBotLog(ownerId, botId, level, message) {
  if (_wsBroadcast) {
    try { _wsBroadcast(ownerId, { type: 'bot_log', botId, level, message, timestamp: new Date().toISOString() }); } catch (_) {}
  }
}

function broadcastBotQR(ownerId, botId, qrData) {
  if (_wsBroadcast) {
    try { _wsBroadcast(ownerId, { type: 'bot_qr', botId, qr: qrData }); } catch (_) {}
  }
}

/**
 * Known broken git dependencies and their working replacements.
 * These repos have been deleted/made private but are still referenced
 * by popular WhatsApp bot packages (baileys forks like angularsockets, etc.)
 *
 * When a dep resolves to a dead GitHub repo, npm install fails with:
 *   "npm error code 128 / An unknown git error occurred"
 * We rewrite these to working public forks BEFORE npm install runs.
 */
const BROKEN_DEP_REPLACEMENTS = {
  // alifalfrl/libsignal-node was deleted — use a maintained public fork
  'github:alifalfrl/libsignal-node': 'github:this-xys/libsignal-node',
  'git+ssh://git@github.com/alifalfrl/libsignal-node.git': 'github:this-xys/libsignal-node',
  'git://github.com/alifalfrl/libsignal-node.git': 'github:this-xys/libsignal-node',
  'https://github.com/alifalfrl/libsignal-node': 'github:this-xys/libsignal-node',
};

/**
 * Patch broken git dependencies in package.json AND in any already-installed
 * nested package.json files (e.g. node_modules/angularsockets/package.json)
 * before running npm install. This prevents install failures from dead GitHub repos.
 */
function patchBrokenDeps(botId, botDir) {
  const targets = [path.join(botDir, 'package.json')];

  // Also check package-lock.json (npm uses it to resolve git deps)
  const lockPath = path.join(botDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) targets.push(lockPath);

  let patched = false;
  for (const filePath of targets) {
    if (!fs.existsSync(filePath)) continue;
    try {
      let content = fs.readFileSync(filePath, 'utf8');
      let modified = content;

      for (const [broken, replacement] of Object.entries(BROKEN_DEP_REPLACEMENTS)) {
        if (modified.includes(broken)) {
          modified = modified.split(broken).join(replacement);
          patched = true;
        }
      }

      // Catch any remaining references to alifalfrl's deleted repos via regex
      modified = modified.replace(
        /github:alifalfrl\/libsignal-node/g,
        'github:this-xys/libsignal-node'
      );
      modified = modified.replace(
        /git\+ssh:\/\/git@github\.com\/alifalfrl\/libsignal-node(\.git)?/g,
        'github:this-xys/libsignal-node'
      );
      modified = modified.replace(
        /ssh:\/\/git@github\.com\/alifalfrl\/libsignal-node(\.git)?/g,
        'github:this-xys/libsignal-node'
      );

      if (modified !== content) {
        fs.writeFileSync(filePath, modified, 'utf8');
        patched = true;
      }
    } catch (e) {
      BotLogs.add(botId, 'warn', `Failed to patch ${path.basename(filePath)}: ${e.message}`);
    }
  }

  if (patched) {
    BotLogs.add(botId, 'info', 'Patched broken git dependencies (dead repos replaced with working forks)');
  }

  // Strip known malicious / non-existent packages from the bot's package.json
  // xsqlite3 is a fake package (not on npm) used in supply-chain attacks.
  // Its deeply-nested core0/core1/.../coreN structure causes ERR_MODULE_NOT_FOUND crashes.
  const MALICIOUS_PACKAGES = ['xsqlite3'];
  const pkgPathM = path.join(botDir, 'package.json');
  if (fs.existsSync(pkgPathM)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPathM, 'utf8'));
      let stripped = false;
      for (const bad of MALICIOUS_PACKAGES) {
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          if (pkg[section] && pkg[section][bad]) {
            delete pkg[section][bad];
            stripped = true;
            BotLogs.add(botId, 'warn', `⚠️ Removed malicious/fake package "${bad}" from ${section}`);
          }
        }
      }
      if (stripped) {
        fs.writeFileSync(pkgPathM, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        BotLogs.add(botId, 'info', 'Saved cleaned package.json (malicious packages removed)');
      }
    } catch (e) {
      BotLogs.add(botId, 'warn', `Failed to strip malicious packages: ${e.message}`);
    }
  }

  // IMPORTANT: The broken dep comes from angularsockets (a baileys fork).
  // npm resolves transitive deps from the registry first, THEN tries git deps.
  // We need to add an npm override to force the replacement at install time
  // since the broken ref is inside angularsockets, not in the user's package.json.
  const pkgPath = path.join(botDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      // Add npm "overrides" to force the broken transitive dep to use our fork
      if (!pkg.overrides) pkg.overrides = {};
      pkg.overrides['libsignal'] = 'github:this-xys/libsignal-node';

      // For yarn compatibility, also add "resolutions"
      if (!pkg.resolutions) pkg.resolutions = {};
      pkg.resolutions['libsignal'] = 'github:this-xys/libsignal-node';

      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      BotLogs.add(botId, 'info', 'Added npm override for broken transitive dep: libsignal -> this-xys/libsignal-node');
    } catch (e) {
      BotLogs.add(botId, 'warn', `Failed to add overrides: ${e.message}`);
    }
  }
}

/**
 * Read novaspark.config.json from a bot directory (if present).
 * Returns parsed config or {} if missing/invalid.
 */
function readBotConfig(botDir) {
  const configPath = path.join(botDir, 'novaspark.config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * Apply novaspark.config.json hints to the bot record in the DB.
 * Only updates fields that are not already manually set by the user.
 */
function applyBotConfig(botId, botDir) {
  const cfg = readBotConfig(botDir);
  if (!cfg || Object.keys(cfg).length === 0) return;

  const bot = Bots.findById(botId);
  if (!bot) return;

  const updates = {};
  // Only apply entry_point from config if the bot still has the default value
  if (cfg.entry_point && bot.entry_point === 'index.js') {
    updates.entry_point = cfg.entry_point;
  }
  if (cfg.session_dir) {
    // Store session_dir so startBot knows which folder to treat as persistent
    updates.session_dir = cfg.session_dir;
  }
  // Auto-restart is globally disabled — ignore config file's auto_restart setting
  // if (cfg.auto_restart !== undefined && bot.auto_restart === 1) {
  //   updates.auto_restart = cfg.auto_restart ? 1 : 0;
  // }
  if (cfg.max_ram_mb && !bot.max_ram_mb) {
    updates.max_ram_mb = cfg.max_ram_mb;
  }

  if (Object.keys(updates).length > 0) {
    Bots.update(botId, updates);
    BotLogs.add(botId, 'info', `Applied novaspark.config.json: ${JSON.stringify(updates)}`);
  }
}

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

  // Apply novaspark.config.json hints (entry_point, session_dir, etc.)
  applyBotConfig(botId, botDir);

  // Write env vars into config files (settings.js, config.env, etc.) for bots that don't read process.env
  const bot = Bots.findById(botId);
  if (bot) {
    writeConfigFiles(botId, botDir, bot);
  }

  // Install dependencies — detect yarn vs npm
  const pkgPath = path.join(botDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const yarnLock = path.join(botDir, 'yarn.lock');

    // Force git to use HTTPS instead of SSH (many bot deps reference private GitHub repos via SSH)
    try {
      execSync('git config --global url."https://github.com/".insteadOf ssh://git@github.com/', { timeout: 5000, stdio: 'pipe' });
      execSync('git config --global url."https://github.com/".insteadOf git@github.com:', { timeout: 5000, stdio: 'pipe' });
    } catch (_) {}

    // Patch known broken/dead git dependencies before npm install
    patchBrokenDeps(botId, botDir);

    // Delete stale package-lock.json — it may have hardcoded references to dead git repos
    // that override our package.json patches. npm will regenerate it on install.
    const stalelock = path.join(botDir, 'package-lock.json');
    if (fs.existsSync(stalelock)) {
      try {
        fs.unlinkSync(stalelock);
        BotLogs.add(botId, 'info', 'Removed stale package-lock.json (will regenerate)');
      } catch (_) {}
    }

    const installCmd = fs.existsSync(yarnLock)
      ? `cd "${botDir}" && npx yarn install --network-concurrency 1 --ignore-engines`
      : `cd "${botDir}" && npm install --production --legacy-peer-deps`;
    try {
      execSync(installCmd, { timeout: 300000, stdio: 'pipe' });
      BotLogs.add(botId, 'info', `Dependencies installed (${fs.existsSync(yarnLock) ? 'yarn' : 'npm'})`);
    } catch (e) {
      // If install fails, try once more without --production (some bots need devDeps for build)
      BotLogs.add(botId, 'warn', `First install attempt failed: ${e.message.slice(0, 200)}`);
      try {
        const retryCmd = fs.existsSync(yarnLock)
          ? `cd "${botDir}" && npx yarn install --ignore-engines`
          : `cd "${botDir}" && npm install --legacy-peer-deps --force`;
        execSync(retryCmd, { timeout: 300000, stdio: 'pipe' });
        BotLogs.add(botId, 'info', 'Dependencies installed (retry succeeded)');
      } catch (e2) {
        BotLogs.add(botId, 'error', `Install failed: ${e2.message.slice(0, 300)}`);
        throw new Error(`Failed to install dependencies: ${e2.message.slice(0, 200)}`);
      }
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

  // Pattern 4: config/config.js or lib/config.js (module.exports = { KEY: "value" })
  const nestedConfigs = [
    path.join(botDir, 'config', 'config.js'),
    path.join(botDir, 'lib', 'config.js'),
    path.join(botDir, 'src', 'config.js'),
    path.join(botDir, 'config.js'),
  ];
  for (const cfgPath of nestedConfigs) {
    if (fs.existsSync(cfgPath)) {
      try {
        const original = fs.readFileSync(cfgPath, 'utf8');
        let modified = original;
        for (const [key, value] of Object.entries(envVars)) {
          const regex = new RegExp(`(${key}\\s*:\\s*)(['"\`])([^'"\`]*)\\2`, 'g');
          if (regex.test(modified)) {
            modified = modified.replace(
              new RegExp(`(${key}\\s*:\\s*)(['"\`])([^'"\`]*)\\2`, 'g'),
              `$1$2${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}$2`
            );
          }
        }
        if (modified !== original) {
          fs.writeFileSync(cfgPath, modified, 'utf8');
          BotLogs.add(botId, 'info', `Wrote config to ${path.relative(botDir, cfgPath)}`);
        }
      } catch (e) {
        BotLogs.add(botId, 'warn', `Failed to write ${path.relative(botDir, cfgPath)}: ${e.message}`);
      }
    }
  }

  // Pattern 5: novaspark.config.json declares a custom config_file — write there too
  const nsCfg = readBotConfig(botDir);
  if (nsCfg.config_file && nsCfg.config_format) {
    const customPath = path.join(botDir, nsCfg.config_file);
    if (fs.existsSync(customPath)) {
      try {
        const original = fs.readFileSync(customPath, 'utf8');
        let modified = original;
        for (const [key, value] of Object.entries(envVars)) {
          const regex = new RegExp(`(${key}\\s*:\\s*)(['"\`])([^'"\`]*)\\2`, 'g');
          if (regex.test(modified)) {
            modified = modified.replace(
              new RegExp(`(${key}\\s*:\\s*)(['"\`])([^'"\`]*)\\2`, 'g'),
              `$1$2${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}$2`
            );
          }
        }
        if (modified !== original) {
          fs.writeFileSync(customPath, modified, 'utf8');
          BotLogs.add(botId, 'info', `Wrote config to custom config_file: ${nsCfg.config_file}`);
        }
      } catch (e) {
        BotLogs.add(botId, 'warn', `Failed to write custom config_file: ${e.message}`);
      }
    }
  }
}

/**
 * Session persistence helpers — backup and restore WhatsApp auth session folders.
 * Many bots use auth_info_baileys/, session/, .session/, or a custom folder.
 */
const SESSIONS_DIR = path.join(__dirname, '..', '..', 'data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function getSessionDir(bot, botDir) {
  // Check novaspark.config.json first, then DB field, then fallback scan
  const nsCfg = readBotConfig(botDir);
  if (nsCfg.session_dir) return path.join(botDir, nsCfg.session_dir);
  if (bot.session_dir) return path.join(botDir, bot.session_dir);

  // Auto-detect common session folder names
  const candidates = ['auth_info_baileys', 'session', '.session', 'auth', 'baileys_auth_info', 'sessions'];
  for (const name of candidates) {
    const p = path.join(botDir, name);
    if (fs.existsSync(p)) return p;
  }
  // Default to auth_info_baileys (most common Baileys default)
  return path.join(botDir, 'auth_info_baileys');
}

function restoreSession(botId, botDir, bot) {
  const sessionBackup = path.join(SESSIONS_DIR, `${botId}.json`);
  const targetDir = getSessionDir(bot, botDir);

  // ── Priority 1: Decode SESSION_ID env var into creds.json ────────────────
  // Many Baileys bots encode creds.json as base64 in SESSION_ID (or SESSION).
  // We decode it here and write creds.json BEFORE the bot starts, so it
  // connects without a QR scan even on first deploy.
  let envVars = {};
  try { envVars = JSON.parse(bot.env_vars || '{}'); } catch (_) {}

  const rawSession = envVars['SESSION_ID'] || envVars['SESSION'] || envVars['CREDS'] || '';
  if (rawSession && rawSession.trim().length > 20) {
    try {
      // Strip known bot-specific prefixes
      // NovaSpark-Bot uses "NovaSpark!" (exclamation), also support "~" and other variants
      let b64 = rawSession.trim()
        .replace(/^NovaSpark!/i, '')
        .replace(/^NovaSpark~/i, '')
        .replace(/^KnightBot!/i, '')
        .replace(/^LEVANTER~/i, '')
        .replace(/^SUBZERO~/i, '')
        .replace(/^[A-Z][A-Za-z0-9_-]+[!~]/g, ''); // any other "PREFIX!" or "PREFIX~"

      // Try to decode as base64
      let decoded;
      try {
        const buf = Buffer.from(b64, 'base64');
        // Try gzip first — NovaSpark-Bot uses gzip+base64
        try {
          const zlib = require('zlib');
          decoded = zlib.gunzipSync(buf).toString('utf8');
        } catch (_) {
          // Plain base64 fallback
          decoded = buf.toString('utf8');
        }
      } catch (_) {}

      if (decoded) {
        let creds;
        try { creds = JSON.parse(decoded); } catch (_) {}

        if (creds && (creds.me || creds.noiseKey || creds.signedIdentityKey || creds.registrationId)) {
          // Valid Baileys creds.json structure — write it
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(path.join(targetDir, 'creds.json'), decoded, 'utf8');
          BotLogs.add(botId, 'info', 'Decoded SESSION_ID into creds.json — bot will connect without QR scan');
          return; // Skip backup restore, session ID takes priority
        }

        // Maybe it's a zip of the full session folder
        try {
          const AdmZip = require('adm-zip');
          const buf = Buffer.from(b64, 'base64');
          const zip = new AdmZip(buf);
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          zip.extractAllTo(targetDir, true);
          BotLogs.add(botId, 'info', 'Extracted SESSION_ID zip into session folder — bot will connect without QR scan');
          return;
        } catch (_) {}

        BotLogs.add(botId, 'warn', 'SESSION_ID set but could not decode to valid creds — will fall back to QR or session backup');
      }
    } catch (e) {
      BotLogs.add(botId, 'warn', `SESSION_ID decode error: ${e.message}`);
    }
  }

  // ── Priority 2: Restore from previous session backup ─────────────────────
  if (!fs.existsSync(sessionBackup)) return;

  try {
    const files = JSON.parse(fs.readFileSync(sessionBackup, 'utf8'));
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(targetDir, filename), content, 'utf8');
    }
    BotLogs.add(botId, 'info', `Restored WhatsApp session (${Object.keys(files).length} files) — bot should connect without QR scan`);
  } catch (e) {
    BotLogs.add(botId, 'warn', `Session restore failed: ${e.message}`);
  }
}

function backupSession(botId, botDir, bot) {
  const targetDir = getSessionDir(bot, botDir);
  if (!fs.existsSync(targetDir)) return;

  try {
    const files = {};
    const entries = fs.readdirSync(targetDir);
    for (const entry of entries) {
      const entryPath = path.join(targetDir, entry);
      const stat = fs.statSync(entryPath);
      // Only backup files, not subdirs; skip large files (>500KB)
      if (stat.isFile() && stat.size < 512 * 1024) {
        files[entry] = fs.readFileSync(entryPath, 'utf8');
      }
    }
    if (Object.keys(files).length > 0) {
      fs.writeFileSync(path.join(SESSIONS_DIR, `${botId}.json`), JSON.stringify(files), 'utf8');
    }
  } catch (_) {}
}

/**
 * Start a bot process (isolated — failures here never crash the platform)
 */
function startBot(botId) {
  const bot = Bots.findById(botId);
  if (!bot) throw new Error('Bot not found');
  if (processes.has(botId)) throw new Error('Bot already running');

  // Run disk watchdog before starting — free space if needed
  try { runDiskWatchdog(); } catch (_) {}

  const botDir = path.join(BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) {
    if (!bot.repo_url) throw new Error('No repository configured');
    cloneRepo(botId, bot.repo_url, bot.branch || 'main');
  }

  // Restore session from internal DB storage (in case folder was evicted)
  try { restoreSessionFromDb(botId); } catch (_) {}

  // Restore saved WhatsApp session (avoids QR scan on restart)
  restoreSession(botId, botDir, bot);

  // Always write config files on start (in case env vars were updated)
  writeConfigFiles(botId, botDir, bot);

  const entryPoint = bot.entry_point || 'index.js';
  const entryPath = path.join(botDir, entryPoint);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry point not found: ${entryPoint}`);
  }

  // Purge malicious packages from node_modules before every launch
  // (catches packages already on disk from previous deploys)
  try { purgeMaliciousModules(botId, botDir); } catch (_) {}

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
      const raw = data.toString();
      const lines = raw.split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Detect fatal WhatsApp 440/connectionReplaced in stdout too
        const isFatalWA = FATAL_WA_PATTERNS.some(p => p.test(line));
        if (isFatalWA) {
          BotLogs.add(botId, 'error', `[WA 440] Session conflict detected: ${line.slice(0, 300)}`);
          BotLogs.add(botId, 'error', 'Another WhatsApp session is active on this number. Delete session files and re-scan QR to fix.');
          broadcastBotStatus(bot.owner_id, botId, 'error_440', {
            message: 'WhatsApp session conflict (440). Delete session and re-scan QR code.'
          });
          broadcastBotLog(bot.owner_id, botId, 'error', '[WA 440] Session replaced - delete session and re-scan QR');
          // Kill process and prevent restart — bot will keep reconnecting internally otherwise
          record.restartCount = BOT_MAX_RESTARTS;
          try { record.proc.kill('SIGTERM'); } catch (_) {}
          continue;
        }
        // Detect base64 QR codes (Baileys outputs data:image/png;base64,... to stdout)
        if (line.includes('data:image/png;base64,')) {
          const match = line.match(/(data:image\/png;base64,[A-Za-z0-9+/=]+)/);
          if (match) {
            BotLogs.add(botId, 'info', '[QR CODE] Scan this QR code in WhatsApp to connect your bot');
            broadcastBotQR(bot.owner_id, botId, match[1]);
            continue;
          }
        }
        BotLogs.add(botId, 'info', line.slice(0, 500));
        broadcastBotLog(bot.owner_id, botId, 'info', line.slice(0, 500));
      }
    } catch (_) { /* swallow */ }
  });

  // Capture stderr (filter noise, wrapped in try/catch)
  proc.stderr.on('data', (data) => {
    try {
      const raw = data.toString();
      const lines = raw.split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Detect ASCII QR art (block characters) in stderr
        if (QR_PATTERNS[1].test(line)) {
          // It's a QR code ASCII art line — log it but don't broadcast as error
          BotLogs.add(botId, 'info', line.slice(0, 500));
          broadcastBotLog(bot.owner_id, botId, 'qr', line.slice(0, 500));
          continue;
        }
        // Detect base64 QR in stderr too
        if (line.includes('data:image/png;base64,')) {
          const match = line.match(/(data:image\/png;base64,[A-Za-z0-9+/=]+)/);
          if (match) {
            BotLogs.add(botId, 'info', '[QR CODE] Scan this QR code in WhatsApp to connect your bot');
            broadcastBotQR(bot.owner_id, botId, match[1]);
            continue;
          }
        }
        // Detect fatal WhatsApp 440/connectionReplaced — stop auto-restart immediately
        const isFatalWA = FATAL_WA_PATTERNS.some(p => p.test(line));
        if (isFatalWA) {
          BotLogs.add(botId, 'error', `[WA 440] Session conflict detected: ${line.slice(0, 300)}`);
          BotLogs.add(botId, 'error', 'Another WhatsApp session is active on this number. Delete session files and re-scan QR to fix.');
          broadcastBotStatus(bot.owner_id, botId, 'error_440', {
            message: 'WhatsApp session conflict (440). Delete session and re-scan QR code.'
          });
          broadcastBotLog(bot.owner_id, botId, 'error', '[WA 440] Session replaced - delete session and re-scan QR');
          // Kill process and prevent restart — bot's internal reconnect loop makes it worse
          record.restartCount = BOT_MAX_RESTARTS;
          try { record.proc.kill('SIGTERM'); } catch (_) {}
          continue;
        }
        const isNoise = NOISE_PATTERNS.some(p => p.test(line));
        if (!isNoise) {
          BotLogs.add(botId, 'error', line.slice(0, 500));
          broadcastBotLog(bot.owner_id, botId, 'error', line.slice(0, 500));
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
    // Capture restart state BEFORE deleting from map
    const currentRestartCount = record.restartCount;
    const currentBackoffMs = record.backoffMs;

    // Backup session before marking as crashed (preserve auth across restarts)
    try { backupSession(botId, botDir, bot); } catch (_) {}
    // Also backup to internal DB storage (survives disk eviction)
    try { backupSessionToDb(botId); } catch (_) {}

    processes.delete(botId);
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    BotLogs.add(botId, 'warn', `Process exited (${reason})`);
    broadcastBotStatus(bot.owner_id, botId, 'crashed', { reason });

    // Update DB
    Bots.update(botId, { status: 'crashed', pid: null });

    // Auto-restart DISABLED — bots never restart on their own.
    // If a bot crashes, it stays crashed until manually started by the user.
    BotLogs.add(botId, 'info', 'Auto-restart is disabled. Start the bot manually when ready.');
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
  broadcastBotStatus(bot.owner_id, botId, 'running', { pid: proc.pid });
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

  // Backup session to internal DB before killing (preserves WhatsApp auth)
  try { backupSessionToDb(botId); } catch (_) {}

  try {
    record.proc.kill('SIGTERM');
    // Force kill after 5s, then evict folder to free disk
    setTimeout(() => {
      try { record.proc.kill('SIGKILL'); } catch (_) {}
      // Evict bot folder from disk after process is fully dead (free space)
      setTimeout(() => {
        try { evictBotFromDisk(botId); } catch (_) {}
      }, 2000);
    }, 5000);
  } catch (_) {}

  processes.delete(botId);
  Bots.update(botId, { status: 'stopped', pid: null });
  BotLogs.add(botId, 'info', 'Bot stopped by user (session saved, folder will be cleaned)');
  const stoppedBot = Bots.findById(botId);
  if (stoppedBot) broadcastBotStatus(stoppedBot.owner_id, botId, 'stopped');

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
 * NOTE: Only marks bots as dead if the exit event hasn't already handled it.
 * We do NOT trigger auto-restart here — the exit handler owns that logic.
 * This prevents double-restart races.
 */
function runWatchdog() {
  for (const [botId, record] of processes) {
    try {
      // Check if process is still alive (signal 0 = existence check only)
      process.kill(record.proc.pid, 0);
      Bots.update(botId, { last_health_check: new Date().toISOString(), health_status: 'healthy' });
    } catch (e) {
      // Process is dead but exit event may not have fired yet — just clean up state.
      // Do NOT attempt another restart here; the exit handler will handle it.
      BotLogs.add(botId, 'warn', `Watchdog: PID ${record.proc.pid} is gone — cleaning up state`);
      processes.delete(botId);
      Bots.update(botId, { status: 'crashed', pid: null, health_status: 'dead' });
      // The proc's exit event will still fire and handle auto-restart via the closure
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
  setWsBroadcast,
  processes,
  BOTS_DIR
};
