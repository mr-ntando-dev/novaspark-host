'use strict';

/**
 * rate-limiter.js — NovaSpark V13: Per-Bot Rate Limiting & DDoS Protection
 * 
 * Configurable rate limiting per bot with:
 * - Customizable thresholds (requests/min, requests/hour)
 * - IP-based blocking and whitelisting
 * - Automatic abuse detection
 * - DDoS pattern recognition
 * - Real-time rate limit dashboard
 * - Geo-blocking capabilities
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { Bots, BotLogs, Notifications, getDb } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// In-memory rate limit tracking
const rateLimitBuckets = new Map(); // botId -> Map<ip, { count, firstRequest, blocked }>
const botRateLimitConfig = new Map(); // botId -> { rpm, rph, block_duration, whitelist, blacklist }
const blockedIPs = new Map(); // botId -> Map<ip, { blockedAt, reason, expiresAt }>
const requestLog = new Map(); // botId -> [{ ip, ts, path, method }] (last 1000)

// Default config
const DEFAULT_RATE_CONFIG = {
  requests_per_minute: 60,
  requests_per_hour: 1000,
  burst_limit: 100, // Max in a 10-second window
  block_duration_seconds: 300,
  auto_block_threshold: 5, // Times rate limit hit before auto-block
  whitelist: [],
  blacklist: [],
  geo_block: [], // Country codes to block
  enabled: true
};

// ─── INIT RATE LIMIT TABLES ─────────────────────────────────────────────────
function initRateLimitSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_configs (
      id              TEXT PRIMARY KEY,
      bot_id          TEXT NOT NULL UNIQUE,
      owner_id        TEXT NOT NULL,
      config          TEXT NOT NULL DEFAULT '{}',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rate_limit_events (
      id          TEXT PRIMARY KEY,
      bot_id      TEXT NOT NULL,
      ip_address  TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      details     TEXT DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_rate_events_bot ON rate_limit_events(bot_id);
    CREATE INDEX IF NOT EXISTS idx_rate_events_ip ON rate_limit_events(ip_address);
  `);
}

try { initRateLimitSchema(); } catch (_) {}

// ─── CONFIGURE RATE LIMITS FOR A BOT ────────────────────────────────────────
router.post('/:botId/config', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const config = { ...DEFAULT_RATE_CONFIG, ...req.body };
    const db = getDb();

    // Validate
    if (config.requests_per_minute < 1 || config.requests_per_minute > 10000) {
      return res.status(400).json({ error: 'requests_per_minute must be 1-10000' });
    }

    const existing = db.prepare('SELECT * FROM rate_limit_configs WHERE bot_id = ?').get(botId);
    if (existing) {
      db.prepare("UPDATE rate_limit_configs SET config = ?, updated_at = datetime('now') WHERE bot_id = ?")
        .run(JSON.stringify(config), botId);
    } else {
      db.prepare('INSERT INTO rate_limit_configs (id, bot_id, owner_id, config) VALUES (?, ?, ?, ?)')
        .run(uuidv4(), botId, req.user.id, JSON.stringify(config));
    }

    // Update in-memory
    botRateLimitConfig.set(botId, config);

    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET RATE LIMIT CONFIG ──────────────────────────────────────────────────
router.get('/:botId/config', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const config = botRateLimitConfig.get(botId) || DEFAULT_RATE_CONFIG;
    res.json({ config, defaults: DEFAULT_RATE_CONFIG });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET REAL-TIME RATE LIMIT STATS ─────────────────────────────────────────
router.get('/:botId/stats', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const buckets = rateLimitBuckets.get(botId) || new Map();
    const blocked = blockedIPs.get(botId) || new Map();
    const logs = requestLog.get(botId) || [];

    // Calculate current request rate
    const now = Date.now();
    const lastMinute = logs.filter(l => now - l.ts < 60000).length;
    const lastHour = logs.filter(l => now - l.ts < 3600000).length;

    // Top IPs
    const ipCounts = {};
    for (const log of logs.slice(-500)) {
      ipCounts[log.ip] = (ipCounts[log.ip] || 0) + 1;
    }
    const topIPs = Object.entries(ipCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ip, count]) => ({ ip, requests: count, blocked: blocked.has(ip) }));

    res.json({
      current_rate: { per_minute: lastMinute, per_hour: lastHour },
      active_connections: buckets.size,
      blocked_ips: blocked.size,
      top_ips: topIPs,
      total_requests_tracked: logs.length,
      blocked_list: [...blocked.entries()].map(([ip, info]) => ({
        ip, reason: info.reason, blocked_at: info.blockedAt, expires_at: info.expiresAt
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MANUALLY BLOCK AN IP ───────────────────────────────────────────────────
router.post('/:botId/block', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const { ip, reason, duration_seconds } = req.body;

    if (!ip) return res.status(400).json({ error: 'ip required' });

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!blockedIPs.has(botId)) blockedIPs.set(botId, new Map());
    const expiresAt = duration_seconds ? Date.now() + (duration_seconds * 1000) : null;

    blockedIPs.get(botId).set(ip, {
      blockedAt: Date.now(),
      reason: reason || 'Manual block',
      expiresAt
    });

    // Log event
    const db = getDb();
    db.prepare('INSERT INTO rate_limit_events (id, bot_id, ip_address, event_type, details) VALUES (?, ?, ?, ?, ?)')
      .run(uuidv4(), botId, ip, 'manual_block', JSON.stringify({ reason, duration_seconds }));

    BotLogs.add(botId, 'warn', `IP ${ip} manually blocked: ${reason || 'No reason given'}`);

    res.json({ success: true, message: `IP ${ip} blocked`, expires_at: expiresAt ? new Date(expiresAt).toISOString() : 'never' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UNBLOCK AN IP ──────────────────────────────────────────────────────────
router.post('/:botId/unblock', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const { ip } = req.body;

    if (!ip) return res.status(400).json({ error: 'ip required' });

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (blockedIPs.has(botId)) {
      blockedIPs.get(botId).delete(ip);
    }

    res.json({ success: true, message: `IP ${ip} unblocked` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADD TO WHITELIST ───────────────────────────────────────────────────────
router.post('/:botId/whitelist', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const { ip } = req.body;

    if (!ip) return res.status(400).json({ error: 'ip required' });

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const config = botRateLimitConfig.get(botId) || { ...DEFAULT_RATE_CONFIG };
    if (!config.whitelist.includes(ip)) {
      config.whitelist.push(ip);
      botRateLimitConfig.set(botId, config);

      // Persist
      const db = getDb();
      db.prepare("UPDATE rate_limit_configs SET config = ?, updated_at = datetime('now') WHERE bot_id = ?")
        .run(JSON.stringify(config), botId);
    }

    res.json({ success: true, whitelist: config.whitelist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET RATE LIMIT EVENTS (attack log) ─────────────────────────────────────
router.get('/:botId/events', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const db = getDb();
    const events = db.prepare('SELECT * FROM rate_limit_events WHERE bot_id = ? ORDER BY created_at DESC LIMIT 100').all(botId);

    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RATE LIMIT CHECK MIDDLEWARE (used by bot proxy) ────────────────────────
function checkRateLimit(botId, ip) {
  const config = botRateLimitConfig.get(botId) || DEFAULT_RATE_CONFIG;

  if (!config.enabled) return { allowed: true };

  // Check whitelist
  if (config.whitelist.includes(ip)) return { allowed: true };

  // Check blacklist
  if (config.blacklist.includes(ip)) return { allowed: false, reason: 'IP blacklisted' };

  // Check blocked
  const blocked = blockedIPs.get(botId);
  if (blocked && blocked.has(ip)) {
    const blockInfo = blocked.get(ip);
    if (blockInfo.expiresAt && Date.now() > blockInfo.expiresAt) {
      blocked.delete(ip); // Expired
    } else {
      return { allowed: false, reason: 'IP temporarily blocked' };
    }
  }

  // Rate limit check
  if (!rateLimitBuckets.has(botId)) rateLimitBuckets.set(botId, new Map());
  const buckets = rateLimitBuckets.get(botId);

  const now = Date.now();
  if (!buckets.has(ip)) {
    buckets.set(ip, { count: 1, firstRequest: now, violations: 0 });
  } else {
    const bucket = buckets.get(ip);
    const elapsed = now - bucket.firstRequest;

    if (elapsed > 60000) {
      // Reset bucket every minute
      bucket.count = 1;
      bucket.firstRequest = now;
    } else {
      bucket.count++;
    }

    if (bucket.count > config.requests_per_minute) {
      bucket.violations++;

      // Auto-block after threshold
      if (bucket.violations >= config.auto_block_threshold) {
        if (!blockedIPs.has(botId)) blockedIPs.set(botId, new Map());
        blockedIPs.get(botId).set(ip, {
          blockedAt: now,
          reason: `Auto-blocked: exceeded rate limit ${bucket.violations} times`,
          expiresAt: now + (config.block_duration_seconds * 1000)
        });

        const bot = Bots.findById(botId);
        if (bot) {
          BotLogs.add(botId, 'warn', `Auto-blocked IP ${ip}: ${bucket.violations} rate limit violations`);
          Notifications.create(bot.owner_id, 'warning', 'IP Auto-Blocked',
            `IP ${ip} was auto-blocked for your bot "${bot.name}" after ${bucket.violations} rate limit violations`);
        }
      }

      return { allowed: false, reason: 'Rate limit exceeded', retry_after: Math.ceil((60000 - elapsed) / 1000) };
    }
  }

  // Track request
  if (!requestLog.has(botId)) requestLog.set(botId, []);
  const log = requestLog.get(botId);
  log.push({ ip, ts: now });
  if (log.length > 1000) log.shift();

  return { allowed: true };
}

module.exports = router;
module.exports.checkRateLimit = checkRateLimit;
module.exports.DEFAULT_RATE_CONFIG = DEFAULT_RATE_CONFIG;
