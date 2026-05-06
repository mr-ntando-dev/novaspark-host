'use strict';

/**
 * webhooks.js — Webhook Integrations
 * 
 * Users can configure webhook endpoints to receive notifications
 * about bot events: status changes, crashes, deploys, health checks.
 * Supports Discord, Slack, and custom HTTP endpoints.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { Bots, getDb } = require('../database');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const router = Router();

const WEBHOOK_EVENTS = [
  'bot.started', 'bot.stopped', 'bot.crashed', 'bot.deployed',
  'bot.restarted', 'bot.health_degraded', 'bot.memory_high',
  'deploy.success', 'deploy.failed'
];

// ─── CREATE WEBHOOK ──────────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const { bot_id, name, url, events, type, secret } = req.body;

  if (!url || !name) return res.status(400).json({ error: 'name and url required' });
  if (!url.startsWith('http')) return res.status(400).json({ error: 'URL must start with http/https' });

  const validType = ['custom', 'discord', 'slack'].includes(type) ? type : 'custom';
  const validEvents = (events || WEBHOOK_EVENTS).filter(e => WEBHOOK_EVENTS.includes(e));
  if (validEvents.length === 0) return res.status(400).json({ error: 'At least one valid event required' });

  // If bot_id specified, verify ownership
  if (bot_id) {
    const bot = Bots.findById(bot_id);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Bot not found or access denied' });
    }
  }

  const db = getDb();
  const id = uuidv4();
  const webhookSecret = secret || generateWebhookSecret();

  db.prepare(`
    INSERT INTO webhooks (id, owner_id, bot_id, name, url, type, events, secret, enabled, failure_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, datetime('now'))
  `).run(id, req.user.id, bot_id || null, name.slice(0, 100), url, validType, JSON.stringify(validEvents), webhookSecret);

  res.status(201).json({
    webhook: { id, name, url, type: validType, events: validEvents, secret: webhookSecret, enabled: true },
    message: 'Webhook created'
  });
});

// ─── LIST MY WEBHOOKS ────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const webhooks = db.prepare('SELECT * FROM webhooks WHERE owner_id = ? ORDER BY created_at DESC').all(req.user.id);

  res.json({
    webhooks: webhooks.map(w => ({
      ...w,
      events: JSON.parse(w.events || '[]'),
      enabled: !!w.enabled,
      secret: '••••' + w.secret.slice(-4)
    }))
  });
});

// ─── UPDATE WEBHOOK ──────────────────────────────────────────────────────────
router.put('/:id', authenticate, (req, res) => {
  const db = getDb();
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  const { name, url, events, enabled } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.slice(0, 100);
  if (url !== undefined) updates.url = url;
  if (events !== undefined) updates.events = JSON.stringify(events.filter(e => WEBHOOK_EVENTS.includes(e)));
  if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  if (setClauses) {
    db.prepare(`UPDATE webhooks SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), webhook.id);
  }

  res.json({ message: 'Webhook updated' });
});

// ─── DELETE WEBHOOK ──────────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhook.id);
  res.json({ message: 'Webhook deleted' });
});

// ─── TEST WEBHOOK ────────────────────────────────────────────────────────────
router.post('/:id/test', authenticate, async (req, res) => {
  const db = getDb();
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  try {
    const payload = buildPayload(webhook.type, {
      event: 'test',
      bot_id: webhook.bot_id || 'test-bot-id',
      bot_name: 'Test Bot',
      message: 'This is a test webhook from NovaSpark',
      timestamp: new Date().toISOString()
    });

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NovaSpark-Signature': webhook.secret },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      res.json({ message: 'Test webhook sent successfully', status: response.status });
    } else {
      res.status(502).json({ error: `Webhook returned ${response.status}`, body: await response.text().catch(() => '') });
    }
  } catch (e) {
    res.status(502).json({ error: `Failed to reach webhook: ${e.message}` });
  }
});

// ─── DELIVERY FUNCTION (called by bot-engine) ────────────────────────────────
async function deliverWebhook(ownerId, botId, event, data) {
  const db = getDb();
  const webhooks = db.prepare(`
    SELECT * FROM webhooks 
    WHERE owner_id = ? AND enabled = 1 AND (bot_id IS NULL OR bot_id = ?)
  `).all(ownerId, botId);

  for (const webhook of webhooks) {
    const events = JSON.parse(webhook.events || '[]');
    if (!events.includes(event)) continue;

    try {
      const payload = buildPayload(webhook.type, { event, bot_id: botId, ...data, timestamp: new Date().toISOString() });

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NovaSpark-Signature': webhook.secret },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        db.prepare('UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?').run(webhook.id);
        // Disable after 10 consecutive failures
        if (webhook.failure_count >= 9) {
          db.prepare('UPDATE webhooks SET enabled = 0 WHERE id = ?').run(webhook.id);
        }
      } else {
        // Reset failure count on success
        if (webhook.failure_count > 0) {
          db.prepare('UPDATE webhooks SET failure_count = 0 WHERE id = ?').run(webhook.id);
        }
      }

      db.prepare('UPDATE webhooks SET last_triggered = datetime(\'now\') WHERE id = ?').run(webhook.id);
    } catch (e) {
      db.prepare('UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?').run(webhook.id);
    }
  }
}

// ─── FORMAT PAYLOADS ─────────────────────────────────────────────────────────
function buildPayload(type, data) {
  switch (type) {
    case 'discord':
      return {
        embeds: [{
          title: `🤖 NovaSpark: ${data.event}`,
          description: data.message || `Bot event: ${data.event}`,
          color: data.event.includes('crash') || data.event.includes('failed') ? 0xff4444 : 0x6366f1,
          fields: [
            { name: 'Bot', value: data.bot_name || data.bot_id || 'Unknown', inline: true },
            { name: 'Event', value: data.event, inline: true }
          ],
          timestamp: data.timestamp
        }]
      };
    case 'slack':
      return {
        text: `NovaSpark: ${data.event}`,
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `*🤖 NovaSpark Bot Event*\n*Event:* ${data.event}\n*Bot:* ${data.bot_name || data.bot_id}\n*Time:* ${data.timestamp}` }
        }]
      };
    default:
      return data;
  }
}

function generateWebhookSecret() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let secret = 'whsec_';
  for (let i = 0; i < 32; i++) secret += chars[Math.floor(Math.random() * chars.length)];
  return secret;
}

module.exports = router;
module.exports.deliverWebhook = deliverWebhook;
