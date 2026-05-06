'use strict';

const { Router } = require('express');
const { Bots, BotLogs, Users, Notifications, Backups } = require('../database');
const { authenticate } = require('../middleware/auth');
const { startBot, stopBot, restartBot, getBotInfo, cloneRepo, deleteBotFiles } = require('../utils/bot-engine');
const { Alerts } = require('../utils/discord-alerts');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

const router = Router();

// Plan limits
const PLAN_LIMITS = {
  free: 1, starter: 2, basic: 3, pro: 10, business: 25, enterprise: 9999
};

// ─── LIST MY BOTS ────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const bots = Bots.findByOwner(req.user.id).map(b => getBotInfo(b.id) || b);
  res.json({ bots, count: bots.length });
});

// ─── GET SINGLE BOT ──────────────────────────────────────────────────────────
router.get('/:id', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json({ bot: getBotInfo(bot.id) || bot });
});

// ─── CREATE BOT ──────────────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const { name, description, repo_url, branch, entry_point, env_vars, auto_restart, server_tier } = req.body;

  if (!name) return res.status(400).json({ error: 'Bot name required' });

  // Check plan limits
  const limit = PLAN_LIMITS[req.user.plan] || 1;
  const currentCount = Bots.countByOwner(req.user.id);
  if (currentCount >= limit) {
    return res.status(403).json({
      error: `Plan limit reached (${limit} bot${limit > 1 ? 's' : ''}). Upgrade your plan.`,
      current: currentCount,
      limit
    });
  }

  const bot = Bots.create({
    owner_id: req.user.id,
    name: name.slice(0, 50),
    description: (description || '').slice(0, 200),
    repo_url: repo_url || null,
    branch: branch || 'main',
    entry_point: entry_point || 'index.js',
    env_vars: env_vars || {},
    server_tier: server_tier || 'basic',
    auto_restart: auto_restart !== undefined ? auto_restart : 1
  });

  res.status(201).json({ bot, message: 'Bot created' });
});

// ─── UPDATE BOT ──────────────────────────────────────────────────────────────
router.put('/:id', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const allowed = ['name', 'description', 'repo_url', 'branch', 'entry_point', 'auto_restart', 'env_vars'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates[key] = key === 'env_vars' ? JSON.stringify(req.body[key]) : req.body[key];
    }
  }

  const updated = Bots.update(req.params.id, updates);
  res.json({ bot: updated });
});

// ─── DELETE BOT ──────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Stop if running
  stopBot(req.params.id);
  // Delete files
  deleteBotFiles(req.params.id);
  // Delete from DB
  Bots.delete(req.params.id);

  res.json({ message: 'Bot deleted' });
});

// ─── START BOT ───────────────────────────────────────────────────────────────
router.post('/:id/start', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const result = startBot(req.params.id);
    Alerts.botStarted(bot.name, req.user.username);
    res.json({ message: 'Bot started', ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── STOP BOT ────────────────────────────────────────────────────────────────
router.post('/:id/stop', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const result = stopBot(req.params.id);
  res.json({ message: 'Bot stopped', ...result });
});

// ─── RESTART BOT ─────────────────────────────────────────────────────────────
router.post('/:id/restart', authenticate, async (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const result = await restartBot(req.params.id);
  res.json({ message: 'Bot restarted', ...result });
});

// ─── DEPLOY (clone/pull + start) ─────────────────────────────────────────────
router.post('/:id/deploy', authenticate, async (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!bot.repo_url) return res.status(400).json({ error: 'No repository URL configured' });

  try {
    // Stop if running
    try { stopBot(req.params.id); } catch (_) {}

    // Clone/pull
    Bots.update(req.params.id, { status: 'deploying' });
    cloneRepo(req.params.id, bot.repo_url, bot.branch || 'main');

    // Start
    const result = startBot(req.params.id);
    Notifications.create(bot.owner_id, 'success', 'Bot Deployed', `${bot.name} was deployed successfully.`);
    res.json({ message: 'Deployed successfully', ...result });
  } catch (e) {
    Bots.update(req.params.id, { status: 'failed' });
    BotLogs.add(req.params.id, 'error', `Deploy failed: ${e.message}`);
    res.status(400).json({ error: `Deploy failed: ${e.message}` });
  }
});

// ─── BOT LOGS ────────────────────────────────────────────────────────────────
router.get('/:id/logs', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs = BotLogs.getRecent(req.params.id, limit);
  res.json({ logs });
});

router.delete('/:id/logs', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  BotLogs.clear(req.params.id);
  res.json({ message: 'Logs cleared' });
});

// ─── BACKUP BOT ──────────────────────────────────────────────────────────────
router.post('/:id/backup', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const botDir = path.join(require('../utils/bot-engine').BOTS_DIR, req.params.id);
  if (!fs.existsSync(botDir)) return res.status(400).json({ error: 'No bot files to backup' });

  try {
    const zip = new AdmZip();
    zip.addLocalFolder(botDir, bot.name);
    const backupDir = path.join(__dirname, '..', '..', 'data', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const filename = `${bot.name}-${Date.now()}.zip`;
    const filepath = path.join(backupDir, filename);
    zip.writeZip(filepath);

    const stats = fs.statSync(filepath);
    Backups.create({ bot_id: req.params.id, owner_id: req.user.id, filename, size_bytes: stats.size });

    res.json({ message: 'Backup created', filename, size_bytes: stats.size });
  } catch (e) {
    res.status(500).json({ error: `Backup failed: ${e.message}` });
  }
});

// ─── ENV VARS (secure) ───────────────────────────────────────────────────────
router.get('/:id/env', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  let envVars = {};
  try { envVars = JSON.parse(bot.env_vars || '{}'); } catch (_) {}
  // Mask values
  const masked = Object.fromEntries(
    Object.entries(envVars).map(([k, v]) => [k, v.length > 4 ? v.slice(0, 2) + '***' + v.slice(-2) : '***'])
  );
  res.json({ env_vars: masked });
});

router.put('/:id/env', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { env_vars } = req.body;
  if (typeof env_vars !== 'object') return res.status(400).json({ error: 'env_vars must be an object' });

  Bots.update(req.params.id, { env_vars: JSON.stringify(env_vars) });
  res.json({ message: 'Environment variables updated' });
});

// ─── SET SESSION ID ──────────────────────────────────────────────────────────
// Shortcut: set SESSION_ID in env vars AND immediately decode + write creds.json
// into the bot's session folder. Supports NovaSpark~, LEVANTER~, SUBZERO~ prefixes
// and raw base64. The bot will use the new session next time it starts.
router.post('/:id/session-id', authenticate, async (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { session_id } = req.body;
  if (!session_id || typeof session_id !== 'string' || session_id.trim().length < 10) {
    return res.status(400).json({ error: 'session_id is required and must be a valid encoded session string' });
  }

  // Save SESSION_ID into the bot's env vars
  let envVars = {};
  try { envVars = JSON.parse(bot.env_vars || '{}'); } catch (_) {}
  envVars['SESSION_ID'] = session_id.trim();
  Bots.update(req.params.id, { env_vars: JSON.stringify(envVars) });

  // If bot files exist, immediately decode and write creds.json
  const { BOTS_DIR, setWsBroadcast: _unused, ...botEngine } = require('../utils/bot-engine');
  const botDir = path.join(BOTS_DIR, req.params.id);
  if (fs.existsSync(botDir)) {
    try {
      let b64 = session_id.trim().replace(/^[A-Z_a-z]+~/i, '');
      let decoded;
      try {
        const buf = Buffer.from(b64, 'base64');
        try {
          const zlib = require('zlib');
          decoded = zlib.gunzipSync(buf).toString('utf8');
        } catch (_) {
          decoded = buf.toString('utf8');
        }
      } catch (_) {}

      if (decoded) {
        let creds;
        try { creds = JSON.parse(decoded); } catch (_) {}
        if (creds && (creds.me || creds.noiseKey || creds.signedIdentityKey || creds.registrationId)) {
          const sessionDir = bot.session_dir
            ? path.join(botDir, bot.session_dir)
            : path.join(botDir, 'auth_info_baileys');
          if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
          fs.writeFileSync(path.join(sessionDir, 'creds.json'), decoded, 'utf8');
          BotLogs.add(req.params.id, 'info', 'SESSION_ID decoded and written to creds.json — restart bot to connect');
          return res.json({ message: 'Session ID saved and decoded. Restart your bot to connect without QR scan.', decoded: true });
        }
      }
    } catch (e) {
      BotLogs.add(req.params.id, 'warn', `SESSION_ID set but decode failed: ${e.message}`);
    }
  }

  res.json({ message: 'Session ID saved. It will be decoded automatically on next bot start.', decoded: false });
});

// ─── EXPORT SESSION ID ───────────────────────────────────────────────────────
// Generate a SESSION_ID string from the bot's current creds.json so the user
// can copy it for use in other bots or as a backup.
router.get('/:id/session-id', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { BOTS_DIR } = require('../utils/bot-engine');
  const botDir = path.join(BOTS_DIR, req.params.id);
  const sessionDirs = [
    bot.session_dir ? path.join(botDir, bot.session_dir) : null,
    path.join(botDir, 'auth_info_baileys'),
    path.join(botDir, 'session'),
    path.join(botDir, '.session'),
    path.join(botDir, 'auth'),
  ].filter(Boolean);

  for (const sessionDir of sessionDirs) {
    const credsPath = path.join(sessionDir, 'creds.json');
    if (fs.existsSync(credsPath)) {
      try {
        const creds = fs.readFileSync(credsPath, 'utf8');
        const b64 = Buffer.from(creds).toString('base64');
        const sessionId = `NovaSpark~${b64}`;
        return res.json({
          session_id: sessionId,
          message: 'Copy this SESSION_ID and paste it into your next bot deployment. Keep it secret — it gives full WhatsApp access.'
        });
      } catch (e) {
        return res.status(500).json({ error: `Could not read session: ${e.message}` });
      }
    }
  }

  res.status(404).json({ error: 'No active session found. Bot must be connected (run + scanned QR) before you can export a session ID.' });
});

module.exports = router;
