'use strict';

/**
 * scheduler.js — Scheduled Tasks / Cron Jobs per Bot
 * 
 * Users can schedule actions: restart bot, run script, 
 * clear logs, backup, or send webhook at specific intervals.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { Bots, getDb } = require('../database');
const { restartBot } = require('../utils/bot-engine');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const router = Router();

// Active cron jobs in memory
const activeJobs = new Map(); // jobId -> cron.ScheduledTask

// ─── CREATE SCHEDULED TASK ───────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const { bot_id, name, action, cron_expression, payload, enabled } = req.body;

  if (!bot_id || !name || !action || !cron_expression) {
    return res.status(400).json({ error: 'bot_id, name, action, and cron_expression required' });
  }

  // Validate cron expression
  if (!cron.validate(cron_expression)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  // Validate action type
  const validActions = ['restart', 'stop', 'clear_logs', 'backup', 'webhook', 'run_command'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
  }

  // Verify bot ownership
  const bot = Bots.findById(bot_id);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Bot not found or access denied' });
  }

  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO scheduled_tasks (id, bot_id, owner_id, name, action, cron_expression, payload, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, bot_id, req.user.id, name.slice(0, 100), action, cron_expression, JSON.stringify(payload || {}), enabled !== false ? 1 : 0);

  // Start the job if enabled
  if (enabled !== false) {
    startCronJob(id, bot_id, action, cron_expression, payload || {});
  }

  res.status(201).json({
    task: { id, bot_id, name, action, cron_expression, payload, enabled: enabled !== false },
    message: 'Scheduled task created'
  });
});

// ─── LIST TASKS FOR A BOT ────────────────────────────────────────────────────
router.get('/bot/:botId', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.botId);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const tasks = db.prepare('SELECT * FROM scheduled_tasks WHERE bot_id = ? ORDER BY created_at DESC').all(req.params.botId);

  res.json({
    tasks: tasks.map(t => ({
      ...t,
      payload: JSON.parse(t.payload || '{}'),
      enabled: !!t.enabled,
      is_running: activeJobs.has(t.id)
    }))
  });
});

// ─── UPDATE TASK ─────────────────────────────────────────────────────────────
router.put('/:id', authenticate, (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(req.params.id);
  if (!task || (task.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Task not found or access denied' });
  }

  const { name, cron_expression, payload, enabled } = req.body;

  if (cron_expression && !cron.validate(cron_expression)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  const updates = {};
  if (name !== undefined) updates.name = name.slice(0, 100);
  if (cron_expression !== undefined) updates.cron_expression = cron_expression;
  if (payload !== undefined) updates.payload = JSON.stringify(payload);
  if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  if (setClauses) {
    db.prepare(`UPDATE scheduled_tasks SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), task.id);
  }

  // Restart or stop the cron job
  stopCronJob(task.id);
  if ((enabled !== undefined ? enabled : task.enabled) && (cron_expression || task.cron_expression)) {
    startCronJob(task.id, task.bot_id, task.action, cron_expression || task.cron_expression, payload ? payload : JSON.parse(task.payload || '{}'));
  }

  res.json({ message: 'Task updated' });
});

// ─── DELETE TASK ─────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(req.params.id);
  if (!task || (task.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Task not found or access denied' });
  }

  stopCronJob(task.id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(task.id);
  res.json({ message: 'Task deleted' });
});

// ─── EXECUTE TASK MANUALLY ───────────────────────────────────────────────────
router.post('/:id/run', authenticate, (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(req.params.id);
  if (!task || (task.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Task not found or access denied' });
  }

  executeAction(task.bot_id, task.action, JSON.parse(task.payload || '{}'));
  db.prepare(`UPDATE scheduled_tasks SET last_run = datetime('now'), run_count = run_count + 1 WHERE id = ?`).run(task.id);

  res.json({ message: `Task "${task.name}" executed` });
});

// ─── CRON HELPERS ────────────────────────────────────────────────────────────
function startCronJob(jobId, botId, action, cronExpr, payload) {
  try {
    const job = cron.schedule(cronExpr, () => {
      executeAction(botId, action, payload);
      const db = getDb();
      try {
        db.prepare(`UPDATE scheduled_tasks SET last_run = datetime('now'), run_count = run_count + 1 WHERE id = ?`).run(jobId);
      } catch (_) {}
    }, { scheduled: true });
    activeJobs.set(jobId, job);
  } catch (e) {
    console.error(`[Scheduler] Failed to start job ${jobId}: ${e.message}`);
  }
}

function stopCronJob(jobId) {
  const job = activeJobs.get(jobId);
  if (job) {
    job.stop();
    activeJobs.delete(jobId);
  }
}

function executeAction(botId, action, payload) {
  try {
    switch (action) {
      case 'restart':
        restartBot(botId);
        break;
      case 'stop':
        const { stopBot } = require('../utils/bot-engine');
        stopBot(botId);
        break;
      case 'clear_logs':
        const { BotLogs } = require('../database');
        BotLogs.clear(botId);
        break;
      case 'webhook':
        if (payload.url) {
          const fetch = require('node-fetch');
          fetch(payload.url, {
            method: payload.method || 'POST',
            headers: { 'Content-Type': 'application/json', ...(payload.headers || {}) },
            body: JSON.stringify({ bot_id: botId, action: 'scheduled_webhook', timestamp: new Date().toISOString(), ...(payload.body || {}) })
          }).catch(e => console.error(`[Scheduler] Webhook failed: ${e.message}`));
        }
        break;
      default:
        break;
    }
  } catch (e) {
    console.error(`[Scheduler] Action ${action} failed for bot ${botId}: ${e.message}`);
  }
}

// ─── INIT: Restore active jobs from DB on startup ────────────────────────────
function initScheduler() {
  try {
    const db = getDb();
    const tasks = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1').all();
    for (const task of tasks) {
      startCronJob(task.id, task.bot_id, task.action, task.cron_expression, JSON.parse(task.payload || '{}'));
    }
    console.log(`[Scheduler] Restored ${tasks.length} active scheduled tasks`);
  } catch (e) {
    console.error(`[Scheduler] Init failed: ${e.message}`);
  }
}

module.exports = router;
module.exports.initScheduler = initScheduler;
