'use strict';

/**
 * analytics.js — Bot Analytics & Metrics
 * 
 * Provides CPU, RAM, uptime charts data, request counts,
 * error rates, and historical performance metrics per bot.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { Bots, BotLogs, getDb } = require('../database');
const { getBotInfo } = require('../utils/bot-engine');

const router = Router();

// ─── GET BOT METRICS (real-time snapshot) ────────────────────────────────────
router.get('/:botId/metrics', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const info = getBotInfo(bot.id);
  const now = Date.now();
  const startTime = bot.start_time ? new Date(bot.start_time).getTime() : null;
  const uptimeMs = startTime && bot.status === 'running' ? now - startTime : 0;

  res.json({
    bot_id: bot.id,
    status: bot.status,
    uptime_ms: uptimeMs,
    uptime_formatted: formatUptime(uptimeMs),
    memory: info ? info.memory : null,
    cpu: info ? info.cpu : null,
    restart_count: bot.total_restarts || 0,
    health_status: bot.health_status || 'unknown',
    last_health_check: bot.last_health_check,
    server_tier: bot.server_tier,
    max_ram_mb: bot.max_ram_mb
  });
});

// ─── GET BOT ANALYTICS (historical data) ────────────────────────────────────
router.get('/:botId/analytics', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const period = req.query.period || '24h';
  const since = getPeriodStart(period);

  // Get log counts by level
  const logStats = db.prepare(`
    SELECT level, COUNT(*) as count 
    FROM bot_logs 
    WHERE bot_id = ? AND created_at >= ?
    GROUP BY level
  `).all(bot.id, since);

  // Get hourly activity
  const hourlyActivity = db.prepare(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as count
    FROM bot_logs
    WHERE bot_id = ? AND created_at >= ?
    GROUP BY hour
    ORDER BY hour
  `).all(bot.id, since);

  // Get error rate
  const totalLogs = logStats.reduce((sum, s) => sum + s.count, 0);
  const errorLogs = logStats.filter(s => s.level === 'error' || s.level === 'stderr').reduce((sum, s) => sum + s.count, 0);
  const errorRate = totalLogs > 0 ? ((errorLogs / totalLogs) * 100).toFixed(1) : 0;

  // Get recent crashes
  const crashes = db.prepare(`
    SELECT created_at, message 
    FROM bot_logs 
    WHERE bot_id = ? AND level = 'error' AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(bot.id, since);

  res.json({
    bot_id: bot.id,
    period,
    log_stats: logStats,
    hourly_activity: hourlyActivity,
    error_rate: parseFloat(errorRate),
    total_logs: totalLogs,
    recent_crashes: crashes,
    uptime_percentage: calculateUptimePercentage(bot),
    deploy_count: bot.total_restarts || 0
  });
});

// ─── GET ACCOUNT-WIDE ANALYTICS ──────────────────────────────────────────────
router.get('/overview', authenticate, (req, res) => {
  const bots = Bots.findByOwner(req.user.id);
  const db = getDb();
  const since = getPeriodStart('7d');

  const overview = {
    total_bots: bots.length,
    running_bots: bots.filter(b => b.status === 'running').length,
    stopped_bots: bots.filter(b => b.status === 'stopped').length,
    errored_bots: bots.filter(b => b.status === 'error' || b.status === 'crashed').length,
    total_uptime_seconds: bots.reduce((sum, b) => sum + (b.uptime_seconds || 0), 0),
    total_restarts: bots.reduce((sum, b) => sum + (b.total_restarts || 0), 0),
    bots_summary: bots.map(b => ({
      id: b.id,
      name: b.name,
      status: b.status,
      uptime_seconds: b.uptime_seconds || 0,
      health_status: b.health_status
    }))
  };

  res.json(overview);
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function formatUptime(ms) {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (sec > 0 || parts.length === 0) parts.push(`${sec}s`);
  return parts.join(' ');
}

function getPeriodStart(period) {
  const now = new Date();
  switch (period) {
    case '1h': now.setHours(now.getHours() - 1); break;
    case '6h': now.setHours(now.getHours() - 6); break;
    case '24h': now.setDate(now.getDate() - 1); break;
    case '7d': now.setDate(now.getDate() - 7); break;
    case '30d': now.setDate(now.getDate() - 30); break;
    default: now.setDate(now.getDate() - 1);
  }
  return now.toISOString();
}

function calculateUptimePercentage(bot) {
  if (!bot.created_at) return 100;
  const created = new Date(bot.created_at).getTime();
  const now = Date.now();
  const totalSeconds = (now - created) / 1000;
  if (totalSeconds <= 0) return 100;
  const uptimePercent = ((bot.uptime_seconds || 0) / totalSeconds) * 100;
  return Math.min(100, parseFloat(uptimePercent.toFixed(2)));
}

module.exports = router;
