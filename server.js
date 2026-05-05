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
const { startWatchdog, getRunningBots } = require('./src/utils/bot-engine');
const { Alerts } = require('./src/utils/discord-alerts');

// Routes
const authRoutes = require('./src/routes/auth');
const botRoutes = require('./src/routes/bots');
const economyRoutes = require('./src/routes/economy');
const adminRoutes = require('./src/routes/admin');
const notificationRoutes = require('./src/routes/notifications');

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

// Health check
app.get('/api/health', (req, res) => {
  const running = getRunningBots();
  res.json({
    status: 'ok',
    version: '11.0.0',
    uptime: process.uptime(),
    running_bots: running.length,
    timestamp: new Date().toISOString()
  });
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

  ws.on('message', (msg) => {
    try {
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
    if (userId && wsClients.has(userId)) {
      wsClients.get(userId).delete(ws);
      if (wsClients.get(userId).size === 0) wsClients.delete(userId);
    }
  });

  ws.on('error', () => {});
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

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log('');
  console.log(chalk.bold.magenta('  ╔══════════════════════════════════════════════╗'));
  console.log(chalk.bold.magenta('  ║          NOVASPARK V11  ⚡  ONLINE          ║'));
  console.log(chalk.bold.magenta('  ╚══════════════════════════════════════════════╝'));
  console.log('');
  console.log(chalk.cyan(`  🌐 Server:    http://localhost:${PORT}`));
  console.log(chalk.cyan(`  🔌 WebSocket: ws://localhost:${PORT}/ws`));
  console.log(chalk.cyan(`  💾 Database:  SQLite (WAL mode)`));
  console.log(chalk.cyan(`  🏥 Health:    /api/health`));
  console.log('');

  await bootstrapAdmin();
  startWatchdog();

  Alerts.systemAlert('NovaSpark V11 started successfully.');
  console.log(chalk.green('  ✅ All systems nominal. Ready to host bots.\n'));
});

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

process.on('uncaughtException', (err) => {
  console.error(chalk.red('[Fatal]'), err);
  Alerts.systemAlert(`Uncaught exception: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  console.error(chalk.red('[Rejection]'), reason);
});
