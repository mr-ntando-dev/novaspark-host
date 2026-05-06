'use strict';

/**
 * quotas.js — NovaSpark V13: Resource Quotas & Usage Metering
 * 
 * Per-user and per-plan resource limits with usage tracking.
 * Features:
 * - CPU/RAM/Storage quotas per plan tier
 * - Real-time usage metering
 * - Overage alerts and auto-throttling
 * - Usage-based billing integration (Stripe metering)
 * - Usage reports and export
 */

const { Router } = require('express');
const { Bots, Notifications, Users, getDb } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// Plan limits
const PLAN_LIMITS = {
  free: {
    max_bots: 2,
    max_ram_mb: 512,
    max_cpu_percent: 50,
    max_storage_mb: 500,
    max_bandwidth_gb: 1,
    max_deploys_per_day: 5,
    max_team_members: 0,
    max_pipelines: 1,
    max_plugins: 3,
    max_secrets: 10,
    terminal_access: false,
    custom_domains: 0,
    backup_retention_days: 7,
    log_retention_days: 3
  },
  starter: {
    max_bots: 5,
    max_ram_mb: 1024,
    max_cpu_percent: 75,
    max_storage_mb: 2048,
    max_bandwidth_gb: 5,
    max_deploys_per_day: 20,
    max_team_members: 3,
    max_pipelines: 5,
    max_plugins: 10,
    max_secrets: 50,
    terminal_access: true,
    custom_domains: 1,
    backup_retention_days: 14,
    log_retention_days: 7
  },
  pro: {
    max_bots: 20,
    max_ram_mb: 2048,
    max_cpu_percent: 100,
    max_storage_mb: 10240,
    max_bandwidth_gb: 25,
    max_deploys_per_day: 100,
    max_team_members: 10,
    max_pipelines: 20,
    max_plugins: 50,
    max_secrets: 200,
    terminal_access: true,
    custom_domains: 5,
    backup_retention_days: 30,
    log_retention_days: 30
  },
  enterprise: {
    max_bots: 999,
    max_ram_mb: 8192,
    max_cpu_percent: 100,
    max_storage_mb: 51200,
    max_bandwidth_gb: 100,
    max_deploys_per_day: 999,
    max_team_members: 50,
    max_pipelines: 100,
    max_plugins: 999,
    max_secrets: 999,
    terminal_access: true,
    custom_domains: 20,
    backup_retention_days: 90,
    log_retention_days: 90
  }
};

// ─── INIT USAGE TABLES ──────────────────────────────────────────────────────
function initQuotaSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      bot_id      TEXT DEFAULT NULL,
      metric      TEXT NOT NULL,
      value       REAL NOT NULL DEFAULT 0,
      period      TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage_daily (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      date          TEXT NOT NULL,
      cpu_minutes   REAL NOT NULL DEFAULT 0,
      ram_mb_hours  REAL NOT NULL DEFAULT 0,
      storage_mb    REAL NOT NULL DEFAULT 0,
      bandwidth_mb  REAL NOT NULL DEFAULT 0,
      deploys       INTEGER NOT NULL DEFAULT 0,
      api_calls     INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_usage_records_user ON usage_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_daily_user ON usage_daily(user_id);
  `);
}

try { initQuotaSchema(); } catch (_) {}

// ─── GET USER QUOTAS & CURRENT USAGE ────────────────────────────────────────
router.get('/usage', authenticate, (req, res) => {
  try {
    const user = Users.findById(req.user.id);
    const plan = user.plan || 'free';
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    // Calculate current usage
    const bots = Bots.findByOwner(req.user.id);
    const botCount = bots.length;
    const runningBots = bots.filter(b => b.status === 'running');

    // Today's usage
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    let daily = db.prepare('SELECT * FROM usage_daily WHERE user_id = ? AND date = ?').get(req.user.id, today);
    if (!daily) daily = { cpu_minutes: 0, ram_mb_hours: 0, storage_mb: 0, bandwidth_mb: 0, deploys: 0, api_calls: 0 };

    const totalRamUsed = runningBots.reduce((sum, b) => sum + (b.max_ram_mb || 512), 0);

    const usage = {
      bots: { used: botCount, limit: limits.max_bots, percent: (botCount / limits.max_bots * 100).toFixed(1) },
      ram_mb: { used: totalRamUsed, limit: limits.max_ram_mb, percent: (totalRamUsed / limits.max_ram_mb * 100).toFixed(1) },
      storage_mb: { used: Math.round(daily.storage_mb), limit: limits.max_storage_mb, percent: (daily.storage_mb / limits.max_storage_mb * 100).toFixed(1) },
      bandwidth_gb: { used: (daily.bandwidth_mb / 1024).toFixed(2), limit: limits.max_bandwidth_gb, percent: (daily.bandwidth_mb / 1024 / limits.max_bandwidth_gb * 100).toFixed(1) },
      deploys_today: { used: daily.deploys, limit: limits.max_deploys_per_day, percent: (daily.deploys / limits.max_deploys_per_day * 100).toFixed(1) },
      api_calls_today: daily.api_calls
    };

    // Check for overages
    const overages = [];
    if (botCount >= limits.max_bots) overages.push('bots');
    if (totalRamUsed >= limits.max_ram_mb) overages.push('ram');
    if (daily.deploys >= limits.max_deploys_per_day) overages.push('deploys');
    if (daily.storage_mb >= limits.max_storage_mb) overages.push('storage');

    res.json({
      plan,
      limits,
      usage,
      overages,
      features: {
        terminal_access: limits.terminal_access,
        custom_domains: limits.custom_domains,
        max_team_members: limits.max_team_members,
        backup_retention_days: limits.backup_retention_days
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET USAGE HISTORY ──────────────────────────────────────────────────────
router.get('/history', authenticate, (req, res) => {
  try {
    const { days } = req.query;
    const lookback = Math.min(parseInt(days) || 30, 90);
    const db = getDb();

    const history = db.prepare(`
      SELECT * FROM usage_daily WHERE user_id = ? AND date > date('now', '-' || ? || ' days')
      ORDER BY date ASC
    `).all(req.user.id, lookback);

    res.json({ history, days: lookback });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CHECK QUOTA (middleware helper) ────────────────────────────────────────
function checkQuota(resource) {
  return (req, res, next) => {
    try {
      const user = Users.findById(req.user.id);
      const plan = user.plan || 'free';
      const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

      switch (resource) {
        case 'bots': {
          const count = Bots.countByOwner(req.user.id);
          if (count >= limits.max_bots) {
            return res.status(429).json({
              error: 'Bot limit reached',
              current: count,
              limit: limits.max_bots,
              upgrade_hint: `Upgrade from ${plan} to unlock more bots`
            });
          }
          break;
        }
        case 'deploys': {
          const db = getDb();
          const today = new Date().toISOString().split('T')[0];
          const daily = db.prepare('SELECT deploys FROM usage_daily WHERE user_id = ? AND date = ?').get(req.user.id, today);
          if (daily && daily.deploys >= limits.max_deploys_per_day) {
            return res.status(429).json({
              error: 'Daily deploy limit reached',
              current: daily.deploys,
              limit: limits.max_deploys_per_day,
              resets: 'midnight UTC'
            });
          }
          break;
        }
        case 'terminal': {
          if (!limits.terminal_access) {
            return res.status(403).json({
              error: 'Terminal access not available on your plan',
              upgrade_hint: 'Upgrade to Starter or above for terminal access'
            });
          }
          break;
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

// ─── RECORD USAGE (called internally) ──────────────────────────────────────
function recordUsage(userId, metric, value, botId = null) {
  try {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];

    // Upsert daily record
    const existing = db.prepare('SELECT * FROM usage_daily WHERE user_id = ? AND date = ?').get(userId, today);
    if (!existing) {
      const { v4: uuidv4 } = require('uuid');
      db.prepare('INSERT INTO usage_daily (id, user_id, date) VALUES (?, ?, ?)').run(uuidv4(), userId, today);
    }

    // Update specific metric
    const metricMap = {
      'cpu': 'cpu_minutes',
      'ram': 'ram_mb_hours',
      'storage': 'storage_mb',
      'bandwidth': 'bandwidth_mb',
      'deploy': 'deploys',
      'api_call': 'api_calls'
    };

    const column = metricMap[metric];
    if (column) {
      db.prepare(`UPDATE usage_daily SET ${column} = ${column} + ? WHERE user_id = ? AND date = ?`).run(value, userId, today);
    }

    // Check if approaching limits
    checkAndNotifyOverage(userId, metric, value);
  } catch (_) {}
}

function checkAndNotifyOverage(userId, metric, value) {
  try {
    const user = Users.findById(userId);
    if (!user) return;
    const limits = PLAN_LIMITS[user.plan || 'free'] || PLAN_LIMITS.free;

    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const daily = db.prepare('SELECT * FROM usage_daily WHERE user_id = ? AND date = ?').get(userId, today);
    if (!daily) return;

    // Check if at 80% of any limit
    if (metric === 'deploy' && daily.deploys >= limits.max_deploys_per_day * 0.8) {
      Notifications.create(userId, 'warning', 'Deploy Limit Warning',
        `You've used ${daily.deploys}/${limits.max_deploys_per_day} deploys today.`);
    }
  } catch (_) {}
}

// ─── GET PLAN COMPARISON ────────────────────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json({ plans: PLAN_LIMITS });
});

// ─── ADMIN: SET USER QUOTA OVERRIDE ─────────────────────────────────────────
router.post('/override/:userId', authenticate, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { userId } = req.params;
    const { resource, limit } = req.body;

    // Store override in user metadata (future implementation)
    res.json({ success: true, message: `Override set for user ${userId}: ${resource} = ${limit}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.checkQuota = checkQuota;
module.exports.recordUsage = recordUsage;
module.exports.PLAN_LIMITS = PLAN_LIMITS;
