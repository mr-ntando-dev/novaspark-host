'use strict';

/**
 * terminal.js — NovaSpark V13: Live Web Terminal
 * 
 * WebSocket-based terminal access to bot containers.
 * Users can execute commands in their bot's working directory in real-time.
 * Includes command history, output streaming, and safety guards.
 */

const { Router } = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Bots, BotLogs, AuditLog } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// Active terminal sessions: botId -> { proc, output[], startedAt }
const terminalSessions = new Map();

// Blocked commands for safety
const BLOCKED_COMMANDS = [
  'rm -rf /', 'rm -rf /*', 'mkfs', 'dd if=/dev/zero',
  'shutdown', 'reboot', 'halt', 'poweroff',
  ':(){:|:&};:', 'fork bomb', '> /dev/sda'
];

const BOTS_DIR = path.join(__dirname, '..', '..', 'data', 'bots');

// ─── START TERMINAL SESSION ─────────────────────────────────────────────────
router.post('/:botId/start', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);

    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    if (bot.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const botDir = path.join(BOTS_DIR, botId);
    if (!fs.existsSync(botDir)) {
      return res.status(400).json({ error: 'Bot directory not found. Deploy the bot first.' });
    }

    // Kill existing session if any
    if (terminalSessions.has(botId)) {
      const existing = terminalSessions.get(botId);
      try { existing.proc.kill(); } catch (_) {}
      terminalSessions.delete(botId);
    }

    // Spawn a shell session in the bot's directory
    const shell = spawn('sh', ['-i'], {
      cwd: botDir,
      env: {
        ...process.env,
        HOME: botDir,
        USER: 'novaspark',
        TERM: 'xterm-256color',
        PS1: `\\[\\033[1;36m\\]novaspark@${bot.name}\\[\\033[0m\\]:\\w$ `
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const session = {
      proc: shell,
      output: [],
      startedAt: Date.now(),
      botId,
      ownerId: bot.owner_id
    };

    shell.stdout.on('data', (data) => {
      const text = data.toString();
      session.output.push({ type: 'stdout', text, ts: Date.now() });
      // Keep only last 500 lines
      if (session.output.length > 500) session.output.shift();
      // Broadcast via WebSocket
      if (global.wsBroadcast) {
        global.wsBroadcast(bot.owner_id, {
          type: 'terminal_output',
          botId,
          data: text,
          stream: 'stdout'
        });
      }
    });

    shell.stderr.on('data', (data) => {
      const text = data.toString();
      session.output.push({ type: 'stderr', text, ts: Date.now() });
      if (session.output.length > 500) session.output.shift();
      if (global.wsBroadcast) {
        global.wsBroadcast(bot.owner_id, {
          type: 'terminal_output',
          botId,
          data: text,
          stream: 'stderr'
        });
      }
    });

    shell.on('close', (code) => {
      terminalSessions.delete(botId);
      if (global.wsBroadcast) {
        global.wsBroadcast(bot.owner_id, {
          type: 'terminal_closed',
          botId,
          exitCode: code
        });
      }
    });

    terminalSessions.set(botId, session);
    AuditLog.record(req.user.id, 'terminal_start', botId);
    BotLogs.add(botId, 'info', `Terminal session started by ${req.user.username}`);

    res.json({
      success: true,
      message: 'Terminal session started',
      sessionId: botId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EXECUTE COMMAND ────────────────────────────────────────────────────────
router.post('/:botId/exec', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const { command } = req.body;

    if (!command) return res.status(400).json({ error: 'Command required' });

    const session = terminalSessions.get(botId);
    if (!session) return res.status(400).json({ error: 'No active terminal session. Start one first.' });

    // Verify ownership
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Safety check
    const cmdLower = command.toLowerCase().trim();
    for (const blocked of BLOCKED_COMMANDS) {
      if (cmdLower.includes(blocked)) {
        return res.status(403).json({ error: `Blocked command: "${blocked}" is not allowed` });
      }
    }

    // Write command to stdin
    session.proc.stdin.write(command + '\n');
    AuditLog.record(req.user.id, 'terminal_exec', botId, { command });

    res.json({ success: true, message: 'Command sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET OUTPUT BUFFER ──────────────────────────────────────────────────────
router.get('/:botId/output', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const session = terminalSessions.get(botId);
    if (!session) return res.json({ active: false, output: [] });

    const since = parseInt(req.query.since) || 0;
    const filtered = session.output.filter(o => o.ts > since);

    res.json({
      active: true,
      startedAt: session.startedAt,
      output: filtered
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STOP TERMINAL SESSION ──────────────────────────────────────────────────
router.post('/:botId/stop', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const session = terminalSessions.get(botId);
    if (!session) return res.json({ success: true, message: 'No active session' });

    try { session.proc.kill(); } catch (_) {}
    terminalSessions.delete(botId);
    AuditLog.record(req.user.id, 'terminal_stop', botId);

    res.json({ success: true, message: 'Terminal session ended' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST ACTIVE SESSIONS ───────────────────────────────────────────────────
router.get('/sessions', authenticate, (req, res) => {
  const sessions = [];
  for (const [botId, session] of terminalSessions) {
    if (session.ownerId === req.user.id || req.user.role === 'admin') {
      sessions.push({
        botId,
        startedAt: session.startedAt,
        outputLines: session.output.length
      });
    }
  }
  res.json({ sessions });
});

module.exports = router;
module.exports.terminalSessions = terminalSessions;
