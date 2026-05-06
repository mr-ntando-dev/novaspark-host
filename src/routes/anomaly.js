'use strict';

/**
 * anomaly.js — NovaSpark V13: AI-Powered Anomaly Detection
 * 
 * Intelligent monitoring that detects:
 * - Unusual crash patterns (crash loops, time-correlated crashes)
 * - Memory leaks (steadily increasing memory usage)
 * - Traffic spikes and drops
 * - Error rate anomalies
 * - Performance degradation
 * 
 * Uses statistical analysis (z-score, moving averages, trend detection)
 * to auto-flag issues and send alerts before bots go down.
 */

const { Router } = require('express');
const { Bots, BotLogs, Notifications, getDb } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// In-memory metrics store (per bot, sliding window)
const metricsStore = new Map(); // botId -> { cpu: [], ram: [], errors: [], restarts: [], timestamps: [] }
const anomalyAlerts = new Map(); // botId -> [{ type, severity, message, detectedAt, resolved }]

const WINDOW_SIZE = 60; // Keep 60 data points (at 1min intervals = 1hr of data)
const Z_SCORE_THRESHOLD = 2.5; // Standard deviations before flagging
const MEMORY_LEAK_THRESHOLD = 5; // Consecutive increases to flag a leak
const CRASH_LOOP_THRESHOLD = 5; // Restarts in 10 minutes = crash loop
const ERROR_RATE_THRESHOLD = 0.5; // 50% error rate = anomaly

// ─── RECORD METRICS (called by bot-engine every 60s) ────────────────────────
function recordMetrics(botId, metrics) {
  if (!metricsStore.has(botId)) {
    metricsStore.set(botId, {
      cpu: [], ram: [], errors: [], restarts: [],
      timestamps: [], responseTime: []
    });
  }

  const store = metricsStore.get(botId);
  store.cpu.push(metrics.cpu || 0);
  store.ram.push(metrics.ram || 0);
  store.errors.push(metrics.errors || 0);
  store.restarts.push(metrics.restarts || 0);
  store.responseTime.push(metrics.responseTime || 0);
  store.timestamps.push(Date.now());

  // Sliding window
  if (store.cpu.length > WINDOW_SIZE) {
    store.cpu.shift();
    store.ram.shift();
    store.errors.shift();
    store.restarts.shift();
    store.responseTime.shift();
    store.timestamps.shift();
  }

  // Run detection
  detectAnomalies(botId, store);
}

// ─── STATISTICAL HELPERS ────────────────────────────────────────────────────
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = mean(arr);
  const variance = arr.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function zScore(value, arr) {
  const sd = stdDev(arr);
  if (sd === 0) return 0;
  return (value - mean(arr)) / sd;
}

function isIncreasingTrend(arr, minPoints = 5) {
  if (arr.length < minPoints) return false;
  const recent = arr.slice(-minPoints);
  let increases = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) increases++;
  }
  return increases >= minPoints - 1;
}

function movingAverage(arr, window = 5) {
  if (arr.length < window) return mean(arr);
  const slice = arr.slice(-window);
  return mean(slice);
}

// ─── ANOMALY DETECTION ENGINE ───────────────────────────────────────────────
function detectAnomalies(botId, store) {
  const alerts = anomalyAlerts.get(botId) || [];
  const now = Date.now();

  // 1. Memory Leak Detection
  if (store.ram.length >= MEMORY_LEAK_THRESHOLD) {
    if (isIncreasingTrend(store.ram, MEMORY_LEAK_THRESHOLD)) {
      const avgIncrease = (store.ram[store.ram.length - 1] - store.ram[store.ram.length - MEMORY_LEAK_THRESHOLD]) / MEMORY_LEAK_THRESHOLD;
      if (avgIncrease > 5) { // More than 5MB per interval
        addAlert(botId, alerts, {
          type: 'memory_leak',
          severity: 'warning',
          message: `Memory leak detected: RAM increasing by ~${Math.round(avgIncrease)}MB per minute. Current: ${store.ram[store.ram.length - 1]}MB`,
          suggestion: 'Check for unclosed connections, growing arrays, or event listener leaks.',
          detectedAt: now
        });
      }
    }
  }

  // 2. Crash Loop Detection
  if (store.restarts.length >= 10) {
    const recentRestarts = store.restarts.slice(-10).reduce((s, v) => s + v, 0);
    if (recentRestarts >= CRASH_LOOP_THRESHOLD) {
      addAlert(botId, alerts, {
        type: 'crash_loop',
        severity: 'critical',
        message: `Crash loop detected: ${recentRestarts} restarts in the last 10 minutes. Bot may be in a fatal state.`,
        suggestion: 'Check logs for recurring errors. Consider stopping auto-restart and debugging manually.',
        detectedAt: now
      });
    }
  }

  // 3. CPU Spike Detection (z-score)
  if (store.cpu.length >= 10) {
    const latestCpu = store.cpu[store.cpu.length - 1];
    const cpuZ = zScore(latestCpu, store.cpu.slice(0, -1));
    if (cpuZ > Z_SCORE_THRESHOLD && latestCpu > 80) {
      addAlert(botId, alerts, {
        type: 'cpu_spike',
        severity: 'warning',
        message: `CPU spike: ${latestCpu.toFixed(1)}% (${cpuZ.toFixed(1)} standard deviations above normal)`,
        suggestion: 'Check for infinite loops, heavy computation, or traffic surges.',
        detectedAt: now
      });
    }
  }

  // 4. Error Rate Anomaly
  if (store.errors.length >= 5) {
    const recentErrors = store.errors.slice(-5).reduce((s, v) => s + v, 0);
    const totalLogs = 5; // 5 intervals
    const errorRate = recentErrors / Math.max(totalLogs, 1);
    if (errorRate > ERROR_RATE_THRESHOLD) {
      addAlert(botId, alerts, {
        type: 'high_error_rate',
        severity: 'warning',
        message: `High error rate: ${(errorRate * 100).toFixed(0)}% of recent activity is errors (${recentErrors} errors in 5 minutes)`,
        suggestion: 'Check logs for the root cause. Common issues: API rate limits, invalid configs, network failures.',
        detectedAt: now
      });
    }
  }

  // 5. Performance Degradation (response time trend)
  if (store.responseTime.length >= 10) {
    const recent = movingAverage(store.responseTime, 5);
    const historical = movingAverage(store.responseTime.slice(0, -5), 5);
    if (historical > 0 && recent > historical * 3) {
      addAlert(botId, alerts, {
        type: 'performance_degradation',
        severity: 'info',
        message: `Response time degradation: ${Math.round(recent)}ms (was ~${Math.round(historical)}ms). 3x slower than baseline.`,
        suggestion: 'Check for resource contention, large payloads, or database bottlenecks.',
        detectedAt: now
      });
    }
  }

  // 6. Sudden Death (bot was running fine, then 0 metrics)
  if (store.cpu.length >= 5) {
    const lastThree = store.cpu.slice(-3);
    const prevThree = store.cpu.slice(-6, -3);
    if (mean(prevThree) > 10 && mean(lastThree) === 0) {
      addAlert(botId, alerts, {
        type: 'sudden_death',
        severity: 'critical',
        message: 'Bot appears to have stopped unexpectedly. No CPU activity detected after being active.',
        suggestion: 'Check if the process crashed without triggering auto-restart. Inspect error logs.',
        detectedAt: now
      });
    }
  }

  anomalyAlerts.set(botId, alerts);
}

function addAlert(botId, alerts, alert) {
  // Dedup: don't add same type within 5 minutes
  const recent = alerts.find(a => a.type === alert.type && (Date.now() - a.detectedAt) < 300000);
  if (recent) return;

  alert.id = `${botId}-${alert.type}-${Date.now()}`;
  alert.resolved = false;
  alerts.push(alert);

  // Keep only last 50 alerts per bot
  if (alerts.length > 50) alerts.shift();

  // Send notification
  const bot = Bots.findById(botId);
  if (bot) {
    const severityEmoji = { critical: '🔴', warning: '🟡', info: '🔵' };
    Notifications.create(bot.owner_id, alert.severity === 'critical' ? 'error' : 'warning',
      `${severityEmoji[alert.severity] || '⚪'} Anomaly: ${alert.type.replace(/_/g, ' ')}`,
      alert.message
    );

    // Broadcast via WebSocket
    if (global.wsBroadcast) {
      global.wsBroadcast(bot.owner_id, {
        type: 'anomaly_detected',
        botId,
        alert
      });
    }
  }
}

// ─── API ROUTES ─────────────────────────────────────────────────────────────

// Get anomaly alerts for a bot
router.get('/:botId/alerts', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const alerts = anomalyAlerts.get(botId) || [];
    const active = alerts.filter(a => !a.resolved);
    const resolved = alerts.filter(a => a.resolved);

    res.json({ active, resolved, total: alerts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get health score for a bot (0-100)
router.get('/:botId/health-score', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const store = metricsStore.get(botId);
    const alerts = anomalyAlerts.get(botId) || [];
    const activeAlerts = alerts.filter(a => !a.resolved);

    let score = 100;

    // Deduct for active alerts
    for (const alert of activeAlerts) {
      if (alert.severity === 'critical') score -= 25;
      else if (alert.severity === 'warning') score -= 10;
      else score -= 5;
    }

    // Deduct for high resource usage
    if (store && store.cpu.length > 0) {
      const avgCpu = mean(store.cpu.slice(-5));
      const avgRam = mean(store.ram.slice(-5));
      if (avgCpu > 80) score -= 15;
      else if (avgCpu > 60) score -= 5;
      if (avgRam > 450) score -= 10;
    }

    // Deduct for bot not running
    if (bot.status !== 'running') score -= 20;

    score = Math.max(0, Math.min(100, score));

    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

    res.json({
      score,
      grade,
      activeAlerts: activeAlerts.length,
      status: bot.status,
      lastCheck: store ? store.timestamps[store.timestamps.length - 1] : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve/dismiss an alert
router.post('/:botId/alerts/:alertId/resolve', authenticate, (req, res) => {
  try {
    const { botId, alertId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const alerts = anomalyAlerts.get(botId) || [];
    const alert = alerts.find(a => a.id === alertId);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    alert.resolved = true;
    alert.resolvedAt = Date.now();

    res.json({ success: true, alert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get metrics history (raw data for charts)
router.get('/:botId/metrics-history', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const store = metricsStore.get(botId);
    if (!store) return res.json({ data: null, message: 'No metrics collected yet' });

    res.json({
      data: {
        cpu: store.cpu,
        ram: store.ram,
        errors: store.errors,
        restarts: store.restarts,
        responseTime: store.responseTime,
        timestamps: store.timestamps
      },
      windowSize: WINDOW_SIZE,
      dataPoints: store.cpu.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get anomaly summary across all bots (dashboard overview)
router.get('/overview', authenticate, (req, res) => {
  try {
    const userBots = Bots.findByOwner(req.user.id);
    const overview = [];

    for (const bot of userBots) {
      const alerts = anomalyAlerts.get(bot.id) || [];
      const active = alerts.filter(a => !a.resolved);
      const store = metricsStore.get(bot.id);

      overview.push({
        botId: bot.id,
        botName: bot.name,
        status: bot.status,
        activeAlerts: active.length,
        criticalAlerts: active.filter(a => a.severity === 'critical').length,
        latestCpu: store ? store.cpu[store.cpu.length - 1] : null,
        latestRam: store ? store.ram[store.ram.length - 1] : null
      });
    }

    const totalAlerts = overview.reduce((s, b) => s + b.activeAlerts, 0);
    const criticalCount = overview.reduce((s, b) => s + b.criticalAlerts, 0);

    res.json({
      bots: overview,
      summary: {
        totalBots: userBots.length,
        totalActiveAlerts: totalAlerts,
        criticalAlerts: criticalCount,
        healthyBots: overview.filter(b => b.activeAlerts === 0 && b.status === 'running').length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.recordMetrics = recordMetrics;
module.exports.metricsStore = metricsStore;
module.exports.anomalyAlerts = anomalyAlerts;
