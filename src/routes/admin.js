'use strict';

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { Users, Bots, BotLogs, RedemptionCodes, Notifications, AuditLog, Transactions } = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getRunningBots, stopBot, startBot } = require('../utils/bot-engine');
const { Alerts } = require('../utils/discord-alerts');
const si = require('systeminformation');
const { v4: uuidv4 } = require('uuid');

const router = Router();

// All admin routes require authentication + admin role
router.use(authenticate, requireAdmin);

// ─── SYSTEM STATS ────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const [cpu, mem, osInfo, time] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.osInfo(),
    si.time()
  ]);

  const userCount = Users.count();
  const runningBots = getRunningBots();

  res.json({
    system: {
      platform: osInfo.platform,
      distro: osInfo.distro,
      hostname: osInfo.hostname,
      uptime: time.uptime,
      cpu_load: Math.round(cpu.currentLoad * 100) / 100,
      ram_total: mem.total,
      ram_used: mem.used,
      ram_free: mem.free,
      ram_percent: Math.round((mem.used / mem.total) * 100)
    },
    app: {
      total_users: userCount,
      running_bots: runningBots.length,
      total_bots: Bots.listAll(99999).length
    }
  });
});

// ─── USER MANAGEMENT ─────────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const users = Users.list(limit, offset).map(u => {
    const { password, two_fa_secret, ...safe } = u;
    return safe;
  });
  res.json({ users, total: Users.count() });
});

router.post('/users', async (req, res) => {
  const { username, password, role, plan, coins } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  if (Users.findByUsername(username)) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const hashed = await bcrypt.hash(password, 12);
  const user = Users.create({ username, password: hashed, role: role || 'user', plan: plan || 'free', coins: coins || 0 });
  AuditLog.record(req.user.id, 'admin_create_user', user.id, { username, role, plan });

  const { password: _, two_fa_secret: __, ...safe } = user;
  res.status(201).json({ user: safe });
});

router.put('/users/:id', (req, res) => {
  const target = Users.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const allowed = ['role', 'plan', 'coins', 'is_banned', 'ban_reason', 'has_vip_access', 'plan_expires_at'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const user = Users.update(req.params.id, updates);
  AuditLog.record(req.user.id, 'admin_update_user', req.params.id, updates);

  const { password, two_fa_secret, ...safe } = user;
  res.json({ user: safe });
});

router.delete('/users/:id', (req, res) => {
  const target = Users.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });

  // Stop all bots belonging to user
  const userBots = Bots.findByOwner(req.params.id);
  for (const bot of userBots) {
    stopBot(bot.id);
  }

  Users.delete(req.params.id);
  AuditLog.record(req.user.id, 'admin_delete_user', req.params.id, { username: target.username });

  res.json({ message: 'User deleted' });
});

// ─── PLAN MANAGEMENT ─────────────────────────────────────────────────────────
router.post('/users/:id/set-plan', (req, res) => {
  const { plan, days } = req.body;
  const target = Users.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const updates = { plan: plan || target.plan };
  if (days) {
    const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    updates.plan_expires_at = expiry;
  }

  Users.update(req.params.id, updates);
  Notifications.create(req.params.id, 'info', 'Plan Updated', `Your plan has been set to ${updates.plan}.`);
  AuditLog.record(req.user.id, 'admin_set_plan', req.params.id, { plan, days });

  res.json({ message: 'Plan updated', plan: updates.plan, expires: updates.plan_expires_at });
});

// ─── COIN MANAGEMENT ─────────────────────────────────────────────────────────
router.post('/users/:id/add-coins', (req, res) => {
  const { amount, reason } = req.body;
  if (!amount || typeof amount !== 'number') return res.status(400).json({ error: 'Amount required' });

  const target = Users.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  Users.addCoins(req.params.id, amount, reason || 'Admin grant');
  Notifications.create(req.params.id, 'reward', 'Coins Added!', `Admin added ${amount} coins. Reason: ${reason || 'N/A'}`);
  AuditLog.record(req.user.id, 'admin_add_coins', req.params.id, { amount, reason });

  res.json({ message: 'Coins added', new_balance: Users.findById(req.params.id).coins });
});

// ─── REDEMPTION CODES ────────────────────────────────────────────────────────
router.get('/codes', (req, res) => {
  const codes = RedemptionCodes.list();
  res.json({ codes });
});

router.post('/codes', (req, res) => {
  const { type, value, max_uses, expires_days, custom_code } = req.body;
  if (!value) return res.status(400).json({ error: 'Value required' });

  const code = custom_code || `NS-${uuidv4().slice(0, 8).toUpperCase()}`;
  const expiresAt = expires_days ? new Date(Date.now() + expires_days * 24 * 60 * 60 * 1000).toISOString() : null;

  const created = RedemptionCodes.create({
    code,
    type: type || 'coins',
    value,
    max_uses: max_uses || 1,
    expires_at: expiresAt,
    created_by: req.user.id
  });

  AuditLog.record(req.user.id, 'admin_create_code', code, { type, value, max_uses });
  res.status(201).json({ code: created });
});

// ─── ALL BOTS (admin view) ───────────────────────────────────────────────────
router.get('/bots', (req, res) => {
  const bots = Bots.listAll();
  const running = getRunningBots();
  res.json({ bots, running_count: running.length, total: bots.length });
});

router.post('/bots/:id/stop', (req, res) => {
  const result = stopBot(req.params.id);
  AuditLog.record(req.user.id, 'admin_stop_bot', req.params.id);
  res.json({ message: 'Bot stopped', ...result });
});

router.post('/bots/:id/start', (req, res) => {
  try {
    const result = startBot(req.params.id);
    AuditLog.record(req.user.id, 'admin_start_bot', req.params.id);
    res.json({ message: 'Bot started', ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── BROADCAST NOTIFICATION ──────────────────────────────────────────────────
router.post('/broadcast', (req, res) => {
  const { title, message, type } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });

  const allUsers = Users.list(99999);
  for (const user of allUsers) {
    Notifications.create(user.id, type || 'info', title, message);
  }

  AuditLog.record(req.user.id, 'admin_broadcast', null, { title, recipients: allUsers.length });
  res.json({ message: 'Broadcast sent', recipients: allUsers.length });
});

// ─── AUDIT LOG ───────────────────────────────────────────────────────────────
router.get('/audit-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs = AuditLog.getRecent(limit);
  res.json({ logs });
});

// ─── STORAGE INFO ────────────────────────────────────────────────────────────
router.get('/storage', (req, res) => {
  try {
    const { getFullStorageInfo, cleanupStoppedBots } = require('../utils/storage-manager');
    const info = getFullStorageInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FORCE CLEANUP ───────────────────────────────────────────────────────────
router.post('/storage/cleanup', (req, res) => {
  try {
    const { cleanupStoppedBots, getFullStorageInfo } = require('../utils/storage-manager');
    const result = cleanupStoppedBots();
    const info = getFullStorageInfo();
    res.json({ ...result, storage: info, message: `Evicted ${result.evicted} stopped bot(s), freed ${Math.round(result.freed_bytes / 1024 / 1024)}MB` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
