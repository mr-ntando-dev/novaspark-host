'use strict';

/**
 * plugins.js — NovaSpark V13: Plugin System with Hot-Reload
 * 
 * Dynamically load/unload bot plugins without restarting.
 * Plugins are JS modules that extend bot functionality:
 * - auto-moderation, welcome messages, analytics hooks, etc.
 * 
 * Features:
 * - Hot-reload: update plugin code without bot restart
 * - Plugin marketplace integration
 * - Per-bot plugin configuration
 * - Plugin health monitoring
 * - Sandboxed execution context
 */

const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Bots, BotLogs, Notifications, getDb } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

const BOTS_DIR = path.join(__dirname, '..', '..', 'data', 'bots');
const PLUGINS_DIR = path.join(__dirname, '..', '..', 'data', 'plugins');
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });

// Active plugins: botId -> Map<pluginId, { module, config, status }>
const activePlugins = new Map();

// Built-in plugin templates
const BUILTIN_PLUGINS = [
  {
    id: 'auto-welcome',
    name: 'Auto Welcome',
    description: 'Sends a customizable welcome message to new users who message the bot',
    version: '1.0.0',
    category: 'engagement',
    config_schema: {
      message: { type: 'string', default: 'Welcome! How can I help you today?', description: 'Welcome message text' },
      delay_ms: { type: 'number', default: 1000, description: 'Delay before sending (ms)' },
      only_first_time: { type: 'boolean', default: true, description: 'Only greet first-time users' }
    }
  },
  {
    id: 'auto-moderation',
    name: 'Auto Moderation',
    description: 'Filters spam, banned words, and excessive messages automatically',
    version: '1.0.0',
    category: 'moderation',
    config_schema: {
      banned_words: { type: 'array', default: [], description: 'List of banned words/phrases' },
      max_messages_per_min: { type: 'number', default: 10, description: 'Rate limit per user per minute' },
      action: { type: 'string', default: 'warn', description: 'Action on violation: warn, mute, kick' },
      log_violations: { type: 'boolean', default: true, description: 'Log all violations' }
    }
  },
  {
    id: 'scheduled-messages',
    name: 'Scheduled Messages',
    description: 'Send recurring or one-time messages to groups/users on a schedule',
    version: '1.0.0',
    category: 'automation',
    config_schema: {
      schedules: { type: 'array', default: [], description: 'Array of { cron, target, message }' },
      timezone: { type: 'string', default: 'UTC', description: 'Timezone for cron expressions' }
    }
  },
  {
    id: 'analytics-tracker',
    name: 'Analytics Tracker',
    description: 'Tracks message volume, active users, popular commands, and response times',
    version: '1.0.0',
    category: 'analytics',
    config_schema: {
      track_commands: { type: 'boolean', default: true, description: 'Track command usage' },
      track_users: { type: 'boolean', default: true, description: 'Track unique active users' },
      report_interval: { type: 'string', default: 'daily', description: 'Report frequency: hourly, daily, weekly' }
    }
  },
  {
    id: 'webhook-forwarder',
    name: 'Webhook Forwarder',
    description: 'Forward specific bot events to external webhooks (Zapier, Make, n8n)',
    version: '1.0.0',
    category: 'integration',
    config_schema: {
      webhook_url: { type: 'string', default: '', description: 'Target webhook URL' },
      events: { type: 'array', default: ['message', 'command'], description: 'Events to forward' },
      include_metadata: { type: 'boolean', default: true, description: 'Include sender info in payload' }
    }
  },
  {
    id: 'anti-crash',
    name: 'Anti-Crash Shield',
    description: 'Wraps bot events in error boundaries to prevent crashes from unhandled errors',
    version: '1.0.0',
    category: 'stability',
    config_schema: {
      auto_heal: { type: 'boolean', default: true, description: 'Attempt to recover from errors automatically' },
      notify_owner: { type: 'boolean', default: true, description: 'Send notification on caught errors' },
      max_errors_before_alert: { type: 'number', default: 5, description: 'Error threshold before alerting' }
    }
  }
];

// ─── LIST AVAILABLE PLUGINS ─────────────────────────────────────────────────
router.get('/available', authenticate, (req, res) => {
  try {
    const { category } = req.query;
    let plugins = [...BUILTIN_PLUGINS];

    // Add custom plugins from disk
    const customDir = path.join(PLUGINS_DIR, 'custom');
    if (fs.existsSync(customDir)) {
      const customs = fs.readdirSync(customDir).filter(f => f.endsWith('.json'));
      for (const file of customs) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(customDir, file), 'utf-8'));
          plugins.push({ ...meta, custom: true });
        } catch (_) {}
      }
    }

    if (category) {
      plugins = plugins.filter(p => p.category === category);
    }

    res.json({ plugins, total: plugins.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── INSTALL PLUGIN TO BOT ──────────────────────────────────────────────────
router.post('/:botId/install', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const { pluginId, config } = req.body;

    if (!pluginId) return res.status(400).json({ error: 'pluginId required' });

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const pluginMeta = BUILTIN_PLUGINS.find(p => p.id === pluginId);
    if (!pluginMeta) return res.status(404).json({ error: 'Plugin not found' });

    // Create plugin config file in bot's directory
    const botPluginsDir = path.join(BOTS_DIR, botId, 'plugins');
    if (!fs.existsSync(botPluginsDir)) fs.mkdirSync(botPluginsDir, { recursive: true });

    const pluginConfig = {
      id: pluginId,
      name: pluginMeta.name,
      version: pluginMeta.version,
      enabled: true,
      config: config || Object.fromEntries(
        Object.entries(pluginMeta.config_schema).map(([k, v]) => [k, v.default])
      ),
      installedAt: new Date().toISOString(),
      lastReload: null
    };

    fs.writeFileSync(
      path.join(botPluginsDir, `${pluginId}.json`),
      JSON.stringify(pluginConfig, null, 2)
    );

    // Track in memory
    if (!activePlugins.has(botId)) activePlugins.set(botId, new Map());
    activePlugins.get(botId).set(pluginId, {
      config: pluginConfig,
      status: 'installed',
      loadedAt: Date.now()
    });

    BotLogs.add(botId, 'info', `Plugin "${pluginMeta.name}" installed`);

    res.status(201).json({
      success: true,
      message: `Plugin "${pluginMeta.name}" installed successfully`,
      plugin: pluginConfig
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST INSTALLED PLUGINS FOR BOT ─────────────────────────────────────────
router.get('/:botId', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const botPluginsDir = path.join(BOTS_DIR, botId, 'plugins');
    if (!fs.existsSync(botPluginsDir)) return res.json({ plugins: [] });

    const plugins = fs.readdirSync(botPluginsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(botPluginsDir, f), 'utf-8'));
        } catch (_) { return null; }
      })
      .filter(Boolean);

    res.json({ plugins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UPDATE PLUGIN CONFIG ───────────────────────────────────────────────────
router.put('/:botId/:pluginId', authenticate, (req, res) => {
  try {
    const { botId, pluginId } = req.params;
    const { config, enabled } = req.body;

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const pluginFile = path.join(BOTS_DIR, botId, 'plugins', `${pluginId}.json`);
    if (!fs.existsSync(pluginFile)) {
      return res.status(404).json({ error: 'Plugin not installed' });
    }

    const pluginData = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));
    if (config) pluginData.config = { ...pluginData.config, ...config };
    if (enabled !== undefined) pluginData.enabled = enabled;
    pluginData.lastReload = new Date().toISOString();

    fs.writeFileSync(pluginFile, JSON.stringify(pluginData, null, 2));

    // Update in-memory
    if (activePlugins.has(botId) && activePlugins.get(botId).has(pluginId)) {
      activePlugins.get(botId).get(pluginId).config = pluginData;
    }

    BotLogs.add(botId, 'info', `Plugin "${pluginData.name}" config updated (hot-reload)`);

    res.json({ success: true, plugin: pluginData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HOT-RELOAD PLUGIN ──────────────────────────────────────────────────────
router.post('/:botId/:pluginId/reload', authenticate, (req, res) => {
  try {
    const { botId, pluginId } = req.params;

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const pluginFile = path.join(BOTS_DIR, botId, 'plugins', `${pluginId}.json`);
    if (!fs.existsSync(pluginFile)) {
      return res.status(404).json({ error: 'Plugin not installed' });
    }

    const pluginData = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));
    pluginData.lastReload = new Date().toISOString();
    fs.writeFileSync(pluginFile, JSON.stringify(pluginData, null, 2));

    // Notify bot via WebSocket to reload plugin
    if (global.wsBroadcast) {
      global.wsBroadcast(bot.owner_id, {
        type: 'plugin_reload',
        botId,
        pluginId,
        config: pluginData.config
      });
    }

    BotLogs.add(botId, 'info', `Plugin "${pluginData.name}" hot-reloaded`);

    res.json({ success: true, message: `Plugin "${pluginData.name}" reloaded`, reloadedAt: pluginData.lastReload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UNINSTALL PLUGIN ───────────────────────────────────────────────────────
router.delete('/:botId/:pluginId', authenticate, (req, res) => {
  try {
    const { botId, pluginId } = req.params;

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const pluginFile = path.join(BOTS_DIR, botId, 'plugins', `${pluginId}.json`);
    if (!fs.existsSync(pluginFile)) {
      return res.status(404).json({ error: 'Plugin not installed' });
    }

    const pluginData = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));
    fs.unlinkSync(pluginFile);

    // Remove from memory
    if (activePlugins.has(botId)) {
      activePlugins.get(botId).delete(pluginId);
    }

    BotLogs.add(botId, 'info', `Plugin "${pluginData.name}" uninstalled`);

    res.json({ success: true, message: `Plugin "${pluginData.name}" uninstalled` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.activePlugins = activePlugins;
module.exports.BUILTIN_PLUGINS = BUILTIN_PLUGINS;
