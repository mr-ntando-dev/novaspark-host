'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fetch = require('node-fetch');
const chalk = require('chalk');

const { Users, Bots, BotLogs, Notifications, AuditLog, getDb } = require('./src/database');
const { securityHeaders, globalLimiter } = require('./src/middleware/security');
const { startWatchdog, getRunningBots, setWsBroadcast } = require('./src/utils/bot-engine');
const { Alerts } = require('./src/utils/discord-alerts');

// Routes
const authRoutes = require('./src/routes/auth');
const botRoutes = require('./src/routes/bots');
const economyRoutes = require('./src/routes/economy');
const adminRoutes = require('./src/routes/admin');
const notificationRoutes = require('./src/routes/notifications');
const repoConfigRoutes = require('./src/routes/repo-config');
const analyticsRoutes = require('./src/routes/analytics');
const teamsRoutes = require('./src/routes/teams');
const schedulerRoutes = require('./src/routes/scheduler');
const marketplaceRoutes = require('./src/routes/marketplace');
const webhooksRoutes = require('./src/routes/webhooks');
const domainsRoutes = require('./src/routes/domains');
const backupsRoutes = require('./src/routes/backups');
const versioningRoutes = require('./src/routes/versioning');

// V13 Routes
const terminalRoutes = require('./src/routes/terminal');
const anomalyRoutes = require('./src/routes/anomaly');
const eventBusRoutes = require('./src/routes/event-bus');
const pluginsRoutes = require('./src/routes/plugins');
const vaultRoutes = require('./src/routes/vault');
const pipelinesRoutes = require('./src/routes/pipelines');
const statusPagesRoutes = require('./src/routes/status-pages');
const quotasRoutes = require('./src/routes/quotas');
const rateLimiterRoutes = require('./src/routes/rate-limiter');
const regionsRoutes = require('./src/routes/regions');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || '';
const PING_INTERVAL_MS = 14 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Security
app.use(securityHeaders);
app.use(cors({ origin: true, credentials: true }));
app.use(globalLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Trust proxy (Render)
app.set('trust proxy', 1);

// ─────────────────────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/bots', botRoutes);
app.use('/api/economy', economyRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/repo-config', repoConfigRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/scheduler', schedulerRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/domains', domainsRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/versions', versioningRoutes);

// V13 API Routes
app.use('/api/terminal', terminalRoutes);
app.use('/api/anomaly', anomalyRoutes);
app.use('/api/event-bus', eventBusRoutes);
app.use('/api/plugins', pluginsRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/pipelines', pipelinesRoutes);
app.use('/api/status-pages', statusPagesRoutes);
app.use('/api/quotas', quotasRoutes);
app.use('/api/rate-limiter', rateLimiterRoutes);
app.use('/api/regions', regionsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  const running = getRunningBots();
  res.json({
    status: 'ok',
    version: '13.0.0',
    uptime: process.uptime(),
    running_bots: running.length,
    features: [
      'analytics', 'teams', 'scheduler', 'marketplace', 'webhooks', 'domains', 'backups', 'versioning',
      'terminal', 'anomaly-detection', 'event-bus', 'plugins', 'vault', 'pipelines', 'status-pages', 'quotas', 'rate-limiter', 'regions'
    ],
    timestamp: new Date().toISOString()
  });
});

// ─── GLOBAL ERROR HANDLER (prevents server crash on unhandled route errors) ──
app.use((err, req, res, _next) => {
  try {
    console.error('[Express Error]', err.stack || err.message || err);
    if (res.headersSent) return;
    res.status(err.status || 500).json({
      error: process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message || 'Internal server error'
    });
  } catch (handlerErr) {
    // Even the error handler crashed — still don't bring down the server
    console.error('[Express Error Handler Failure]', handlerErr);
    try { res.status(500).end(); } catch (_) {}
  }
});

// Catch-all: serve index.html for SPA routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER (real-time updates)
// ─────────────────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Map(); // userId -> Set<ws>

wss.on('connection', (ws, req) => {
  let userId = null;
  let msgCount = 0;
  const msgResetInterval = setInterval(() => { msgCount = 0; }, 10000);

  ws.on('message', (msg) => {
    try {
      // Rate limit: max 30 messages per 10 seconds per connection
      msgCount++;
      if (msgCount > 30) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limited' }));
        return;
      }

      const data = JSON.parse(msg);
      if (data.type === 'auth' && data.userId) {
        userId = data.userId;
        if (!wsClients.has(userId)) wsClients.set(userId, new Set());
        wsClients.get(userId).add(ws);
        ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket authenticated' }));
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    clearInterval(msgResetInterval);
    if (userId && wsClients.has(userId)) {
      wsClients.get(userId).delete(ws);
      if (wsClients.get(userId).size === 0) wsClients.delete(userId);
    }
  });

  ws.on('error', () => {
    clearInterval(msgResetInterval);
  });
});

// Broadcast to specific user
function wsBroadcast(userId, payload) {
  const clients = wsClients.get(userId);
  if (!clients) return;
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// Broadcast to all connected clients
function wsBroadcastAll(payload) {
  const msg = JSON.stringify(payload);
  for (const [, clients] of wsClients) {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}

// Make broadcast available globally
global.wsBroadcast = wsBroadcast;
global.wsBroadcastAll = wsBroadcastAll;

// Inject WebSocket broadcaster into bot-engine so bots can push live updates
setWsBroadcast(wsBroadcast, wsBroadcastAll);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
async function bootstrapAdmin() {
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'novaspark2025';

  const existing = Users.findByUsername(adminUsername);
  if (!existing) {
    const hashed = await bcrypt.hash(adminPassword, 12);
    Users.create({
      username: adminUsername,
      password: hashed,
      role: 'admin',
      plan: 'enterprise',
      coins: 99999
    });
    console.log(chalk.green(`[Boot] Admin account created: ${adminUsername}`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON JOBS
// ─────────────────────────────────────────────────────────────────────────────

// Keep-alive ping (prevents Render free tier spin-down)
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/api/health`);
    } catch (_) {}
  }, PING_INTERVAL_MS);
}

// Daily: prune old logs, check plan expiry
cron.schedule('0 3 * * *', () => {
  console.log(chalk.blue('[Cron] Running daily maintenance...'));

  // Prune logs older than 7 days
  BotLogs.prune(7);

  // Check plan expiry
  const db = getDb();
  const expiringSoon = db.prepare(`
    SELECT * FROM users WHERE plan != 'free' AND plan_expires_at IS NOT NULL
    AND plan_expires_at < datetime('now', '+3 days') AND plan_expires_at > datetime('now')
  `).all();

  for (const user of expiringSoon) {
    const daysLeft = Math.ceil((new Date(user.plan_expires_at) - Date.now()) / (1000 * 60 * 60 * 24));
    Notifications.create(user.id, 'warning', 'Plan Expiring Soon', `Your ${user.plan} plan expires in ${daysLeft} day(s). Renew to keep your bots running.`);
    Alerts.planExpiring(user.username, user.plan, daysLeft);
  }

  // Downgrade expired plans
  const expired = db.prepare(`
    SELECT * FROM users WHERE plan != 'free' AND plan_expires_at IS NOT NULL
    AND plan_expires_at < datetime('now')
  `).all();

  for (const user of expired) {
    Users.update(user.id, { plan: 'free', plan_expires_at: null });
    Notifications.create(user.id, 'warning', 'Plan Expired', 'Your plan has expired. You have been moved to the Free tier.');
  }

  console.log(chalk.blue(`[Cron] Maintenance complete. ${expiringSoon.length} expiring, ${expired.length} downgraded.`));
});

// Every 2 min: memory pressure relief
setInterval(() => {
  try {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    if (heapUsedMB > 400) {
      console.warn(chalk.yellow(`[Memory] High heap usage: ${heapUsedMB}MB — attempting GC hint`));
      if (global.gc) global.gc();
    }
    if (rssMB > 900) {
      console.error(chalk.red(`[Memory] RSS dangerously high: ${rssMB}MB — forcing GC`));
      if (global.gc) global.gc();
    }
  } catch (_) {}
}, 120000);

// Every 5 min: broadcast system stats via WebSocket
cron.schedule('*/5 * * * *', async () => {
  try {
    const si = require('systeminformation');
    const [cpu, mem] = await Promise.all([si.currentLoad(), si.mem()]);
    const running = getRunningBots();

    wsBroadcastAll({
      type: 'system_stats',
      data: {
        cpu_load: Math.round(cpu.currentLoad * 100) / 100,
        ram_percent: Math.round((mem.used / mem.total) * 100),
        running_bots: running.length,
        timestamp: Date.now()
      }
    });
  } catch (_) {}
});

// Every 10 min: run disk watchdog to prevent disk full
cron.schedule('*/10 * * * *', () => {
  try {
    const { runDiskWatchdog } = require('./src/utils/storage-manager');
    runDiskWatchdog();
  } catch (_) {}
});

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log('');
  console.log(chalk.bold.magenta('  ╔══════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.magenta('  ║         NOVASPARK V13  ⚡  ONLINE                  ║'));
  console.log(chalk.bold.magenta('  ║         Advanced Bot Hosting Platform               ║'));
  console.log(chalk.bold.magenta('  ╚══════════════════════════════════════════════════════╝'));
  console.log('');
  console.log(chalk.cyan(`  🌐 Server:      http://localhost:${PORT}`));
  console.log(chalk.cyan(`  🔌 WebSocket:   ws://localhost:${PORT}/ws`));
  console.log(chalk.cyan(`  💾 Database:    SQLite (WAL mode)`));
  console.log(chalk.cyan(`  🏥 Health:      /api/health`));
  console.log(chalk.cyan(`  📊 V12 Core:    Analytics, Teams, Scheduler, Marketplace`));
  console.log(chalk.cyan(`                  Webhooks, Domains, Backups, Versioning`));
  console.log(chalk.cyan(`  🚀 V13 New:     Terminal, AI Anomaly Detection, Event Bus`));
  console.log(chalk.cyan(`                  Plugins, Vault, CI/CD Pipelines, Status Pages`));
  console.log(chalk.cyan(`                  Resource Quotas, Rate Limiter, Geo Regions`));
  console.log('');

  await bootstrapAdmin();
  startWatchdog();

  // Initialize scheduled tasks from DB
  const { initScheduler } = require('./src/routes/scheduler');
  initScheduler();

  Alerts.systemAlert('NovaSpark V13 started successfully.');
  console.log(chalk.green('  ✅ All systems nominal. Ready to host bots.\n'));

  // V13: Start anomaly detection metrics collection (every 60s)
  const { recordMetrics } = require('./src/routes/anomaly');
  setInterval(() => {
    try {
      const si = require('systeminformation');
      const running = getRunningBots();
      for (const botId of running) {
        const bot = Bots.findById(botId);
        if (bot) {
          si.currentLoad().then(cpu => {
            recordMetrics(botId, {
              cpu: cpu.currentLoad || 0,
              ram: bot.max_ram_mb || 0,
              errors: 0,
              restarts: bot.restart_count || 0,
              responseTime: 0
            });
          }).catch(() => {});
        }
      }
    } catch (_) {}
  }, 60000);
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN (handled below with existing SIGTERM handler)
// ─────────────────────────────────────────────────────────────────────────────

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n[Shutdown] SIGTERM received, shutting down...'));
  const { stopWatchdog, processes } = require('./src/utils/bot-engine');
  stopWatchdog();
  // Stop all bots
  for (const [botId] of processes) {
    try { require('./src/utils/bot-engine').stopBot(botId); } catch (_) {}
  }
  server.close(() => process.exit(0));
});

// ─────────────────────────────────────────────────────────────────────────────
// BULLETPROOF CRASH PROTECTION — server should NEVER go down
// ─────────────────────────────────────────────────────────────────────────────
let _uncaughtCount = 0;
const CRASH_WINDOW_MS = 60000;
const MAX_CRASHES_PER_WINDOW = 20;
let _crashWindowStart = Date.now();

process.on('uncaughtException', (err) => {
  console.error(chalk.red('[UncaughtException]'), err.stack || err.message || err);
  Alerts.systemAlert(`Uncaught exception: ${err.message}`);

  // Track crash frequency — only force-exit if truly spiraling
  const now = Date.now();
  if (now - _crashWindowStart > CRASH_WINDOW_MS) {
    _uncaughtCount = 0;
    _crashWindowStart = now;
  }
  _uncaughtCount++;
  if (_uncaughtCount >= MAX_CRASHES_PER_WINDOW) {
    console.error(chalk.red(`[Fatal] ${MAX_CRASHES_PER_WINDOW} uncaught exceptions in ${CRASH_WINDOW_MS/1000}s — force restarting.`));
    process.exit(1); // Let process manager (Render/pm2) restart us
  }
  // Otherwise: swallow and keep running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('[UnhandledRejection]'), reason);
  // Never crash on unhandled promise rejections
});

// Prevent V8 from killing the process on memory warnings
process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') return; // harmless
  console.warn(chalk.yellow(`[Warning] ${warning.name}: ${warning.message}`));
});
