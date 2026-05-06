'use strict';

/**
 * event-bus.js — NovaSpark V13: Bot-to-Bot Communication (Event Bus)
 * 
 * Pub/sub messaging system that lets bots on the platform communicate.
 * Use cases:
 * - Bot A detects a new customer → Bot B sends a welcome message
 * - Bot A receives a payment → Bot B updates inventory
 * - Multi-bot workflows (pipeline processing)
 * 
 * Features:
 * - Named channels with topic-based routing
 * - Message persistence (last N messages per channel)
 * - Delivery confirmation
 * - Cross-user bot communication (with permission)
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { Bots, Notifications, getDb } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// In-memory pub/sub system
const channels = new Map(); // channelName -> { subscribers: Set<botId>, messages: [], config }
const botSubscriptions = new Map(); // botId -> Set<channelName>
const messageHistory = new Map(); // channelName -> [{ id, from, data, ts }]

const MAX_MESSAGES_PER_CHANNEL = 100;
const MAX_CHANNELS_PER_USER = 20;
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB

// ─── CREATE CHANNEL ─────────────────────────────────────────────────────────
router.post('/channels', authenticate, (req, res) => {
  try {
    const { name, description, isPublic } = req.body;

    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Channel name required (alphanumeric, dots, dashes, underscores only)' });
    }

    if (channels.has(name)) {
      return res.status(409).json({ error: 'Channel already exists' });
    }

    // Check limit
    const userChannels = [...channels.values()].filter(c => c.ownerId === req.user.id);
    if (userChannels.length >= MAX_CHANNELS_PER_USER) {
      return res.status(429).json({ error: `Maximum ${MAX_CHANNELS_PER_USER} channels per user` });
    }

    const channel = {
      name,
      description: description || '',
      ownerId: req.user.id,
      isPublic: !!isPublic,
      subscribers: new Set(),
      createdAt: Date.now()
    };

    channels.set(name, channel);
    messageHistory.set(name, []);

    res.status(201).json({
      success: true,
      channel: {
        name,
        description: channel.description,
        isPublic: channel.isPublic,
        subscribers: 0,
        createdAt: channel.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST CHANNELS ──────────────────────────────────────────────────────────
router.get('/channels', authenticate, (req, res) => {
  try {
    const result = [];
    for (const [name, channel] of channels) {
      if (channel.isPublic || channel.ownerId === req.user.id) {
        result.push({
          name,
          description: channel.description,
          isPublic: channel.isPublic,
          subscribers: channel.subscribers.size,
          owner: channel.ownerId === req.user.id,
          createdAt: channel.createdAt
        });
      }
    }
    res.json({ channels: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SUBSCRIBE BOT TO CHANNEL ───────────────────────────────────────────────
router.post('/channels/:channel/subscribe', authenticate, (req, res) => {
  try {
    const { channel: channelName } = req.params;
    const { botId } = req.body;

    if (!botId) return res.status(400).json({ error: 'botId required' });

    const channel = channels.get(channelName);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized for this bot' });
    }

    // Check permission for private channels
    if (!channel.isPublic && channel.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Cannot subscribe to private channel you do not own' });
    }

    channel.subscribers.add(botId);

    if (!botSubscriptions.has(botId)) botSubscriptions.set(botId, new Set());
    botSubscriptions.get(botId).add(channelName);

    res.json({
      success: true,
      message: `Bot "${bot.name}" subscribed to channel "${channelName}"`,
      subscribers: channel.subscribers.size
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UNSUBSCRIBE BOT FROM CHANNEL ───────────────────────────────────────────
router.post('/channels/:channel/unsubscribe', authenticate, (req, res) => {
  try {
    const { channel: channelName } = req.params;
    const { botId } = req.body;

    const channel = channels.get(channelName);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    channel.subscribers.delete(botId);
    if (botSubscriptions.has(botId)) {
      botSubscriptions.get(botId).delete(channelName);
    }

    res.json({ success: true, subscribers: channel.subscribers.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUBLISH MESSAGE TO CHANNEL ─────────────────────────────────────────────
router.post('/channels/:channel/publish', authenticate, (req, res) => {
  try {
    const { channel: channelName } = req.params;
    const { botId, event, data } = req.body;

    if (!botId || !event) {
      return res.status(400).json({ error: 'botId and event required' });
    }

    const channel = channels.get(channelName);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Size check
    const payload = JSON.stringify(data || {});
    if (payload.length > MAX_MESSAGE_SIZE) {
      return res.status(413).json({ error: `Message too large (max ${MAX_MESSAGE_SIZE / 1024}KB)` });
    }

    const message = {
      id: uuidv4(),
      channel: channelName,
      from: botId,
      fromName: bot.name,
      event,
      data: data || {},
      timestamp: Date.now(),
      deliveredTo: []
    };

    // Store in history
    const history = messageHistory.get(channelName) || [];
    history.push(message);
    if (history.length > MAX_MESSAGES_PER_CHANNEL) history.shift();
    messageHistory.set(channelName, history);

    // Deliver to all subscribers via WebSocket
    let delivered = 0;
    for (const subscriberBotId of channel.subscribers) {
      if (subscriberBotId === botId) continue; // Don't send to self

      const subscriberBot = Bots.findById(subscriberBotId);
      if (subscriberBot && global.wsBroadcast) {
        global.wsBroadcast(subscriberBot.owner_id, {
          type: 'event_bus_message',
          channel: channelName,
          message
        });
        message.deliveredTo.push(subscriberBotId);
        delivered++;
      }
    }

    res.json({
      success: true,
      messageId: message.id,
      delivered,
      totalSubscribers: channel.subscribers.size - 1 // Exclude sender
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET CHANNEL MESSAGE HISTORY ────────────────────────────────────────────
router.get('/channels/:channel/messages', authenticate, (req, res) => {
  try {
    const { channel: channelName } = req.params;
    const channel = channels.get(channelName);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (!channel.isPublic && channel.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, MAX_MESSAGES_PER_CHANNEL);
    const since = parseInt(req.query.since) || 0;

    const history = messageHistory.get(channelName) || [];
    const filtered = history.filter(m => m.timestamp > since).slice(-limit);

    res.json({ messages: filtered, total: history.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE CHANNEL ─────────────────────────────────────────────────────────
router.delete('/channels/:channel', authenticate, (req, res) => {
  try {
    const { channel: channelName } = req.params;
    const channel = channels.get(channelName);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (channel.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only channel owner can delete' });
    }

    // Clean up subscriptions
    for (const botId of channel.subscribers) {
      if (botSubscriptions.has(botId)) {
        botSubscriptions.get(botId).delete(channelName);
      }
    }

    channels.delete(channelName);
    messageHistory.delete(channelName);

    res.json({ success: true, message: `Channel "${channelName}" deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET BOT SUBSCRIPTIONS ──────────────────────────────────────────────────
router.get('/bots/:botId/subscriptions', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const subs = botSubscriptions.get(botId) || new Set();
    const result = [...subs].map(channelName => {
      const channel = channels.get(channelName);
      return channel ? {
        channel: channelName,
        subscribers: channel.subscribers.size,
        isPublic: channel.isPublic
      } : null;
    }).filter(Boolean);

    res.json({ subscriptions: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.channels = channels;
module.exports.publishEvent = function(channelName, botId, event, data) {
  // Programmatic publish (called from bot-engine or other modules)
  const channel = channels.get(channelName);
  if (!channel) return;
  const bot = Bots.findById(botId);
  if (!bot) return;

  const message = {
    id: uuidv4(),
    channel: channelName,
    from: botId,
    fromName: bot.name,
    event,
    data: data || {},
    timestamp: Date.now(),
    deliveredTo: []
  };

  const history = messageHistory.get(channelName) || [];
  history.push(message);
  if (history.length > MAX_MESSAGES_PER_CHANNEL) history.shift();
  messageHistory.set(channelName, history);

  for (const subscriberBotId of channel.subscribers) {
    if (subscriberBotId === botId) continue;
    const subscriberBot = Bots.findById(subscriberBotId);
    if (subscriberBot && global.wsBroadcast) {
      global.wsBroadcast(subscriberBot.owner_id, { type: 'event_bus_message', channel: channelName, message });
    }
  }
};
