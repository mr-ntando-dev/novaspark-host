'use strict';

/**
 * backups.js — Automated Backups with One-Click Restore
 * 
 * Provides automated backup scheduling, manual backup triggers,
 * and one-click restore functionality for bot data and configurations.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { Bots, getDb } = require('../database');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const router = Router();
const BOTS_DIR = path.join(__dirname, '..', '..', 'data', 'bots');
const BACKUPS_DIR = path.join(__dirname, '..', '..', 'data', 'backups');
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ─── CREATE BACKUP ───────────────────────────────────────────────────────────
router.post('/:botId', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.botId);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Bot not found or access denied' });
  }

  const { label } = req.body;
  const botDir = path.join(BOTS_DIR, bot.id);

  if (!fs.existsSync(botDir)) {
    return res.status(400).json({ error: 'No bot files to backup (not yet deployed)' });
  }

  try {
    const id = uuidv4();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${bot.id}_${timestamp}.zip`;
    const backupPath = path.join(BACKUPS_DIR, filename);

    // Create zip of bot directory (exclude node_modules)
    const zip = new AdmZip();
    addDirectoryToZip(zip, botDir, '', ['node_modules', '.git']);

    // Also backup bot config from DB
    const configBackup = {
      bot_id: bot.id,
      name: bot.name,
      description: bot.description,
      repo_url: bot.repo_url,
      branch: bot.branch,
      entry_point: bot.entry_point,
      env_vars: bot.env_vars,
      server_tier: bot.server_tier,
      auto_restart: bot.auto_restart,
      max_ram_mb: bot.max_ram_mb,
      backed_up_at: new Date().toISOString()
    };
    zip.addFile('_novaspark_config.json', Buffer.from(JSON.stringify(configBackup, null, 2)));

    zip.writeZip(backupPath);

    const stats = fs.statSync(backupPath);
    const db = getDb();

    db.prepare(`
      INSERT INTO bot_backups (id, bot_id, owner_id, label, filename, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(id, bot.id, req.user.id, (label || `Backup ${timestamp}`).slice(0, 100), filename, stats.size);

    // Keep only last 10 backups per bot
    const oldBackups = db.prepare(`
      SELECT * FROM bot_backups WHERE bot_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 10
    `).all(bot.id);
    for (const old of oldBackups) {
      const oldPath = path.join(BACKUPS_DIR, old.filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      db.prepare('DELETE FROM bot_backups WHERE id = ?').run(old.id);
    }

    res.status(201).json({
      backup: { id, label: label || `Backup ${timestamp}`, filename, size_bytes: stats.size },
      message: 'Backup created successfully'
    });
  } catch (e) {
    res.status(500).json({ error: `Backup failed: ${e.message}` });
  }
});

// ─── LIST BACKUPS ────────────────────────────────────────────────────────────
router.get('/:botId', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.botId);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const backups = db.prepare('SELECT * FROM bot_backups WHERE bot_id = ? ORDER BY created_at DESC').all(bot.id);

  res.json({
    backups: backups.map(b => ({
      ...b,
      size_formatted: formatBytes(b.size_bytes),
      exists: fs.existsSync(path.join(BACKUPS_DIR, b.filename))
    }))
  });
});

// ─── RESTORE FROM BACKUP ─────────────────────────────────────────────────────
router.post('/:botId/restore/:backupId', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.botId);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const backup = db.prepare('SELECT * FROM bot_backups WHERE id = ? AND bot_id = ?').get(req.params.backupId, bot.id);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  const backupPath = path.join(BACKUPS_DIR, backup.filename);
  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: 'Backup file missing from disk' });
  }

  try {
    const botDir = path.join(BOTS_DIR, bot.id);

    // Stop bot if running
    if (bot.status === 'running') {
      const { stopBot } = require('../utils/bot-engine');
      stopBot(bot.id);
    }

    // Clear current bot directory
    if (fs.existsSync(botDir)) {
      fs.rmSync(botDir, { recursive: true, force: true });
    }
    fs.mkdirSync(botDir, { recursive: true });

    // Extract backup
    const zip = new AdmZip(backupPath);
    zip.extractAllTo(botDir, true);

    // Restore config from backup if present
    const configPath = path.join(botDir, '_novaspark_config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // Restore env vars
      if (config.env_vars) {
        Bots.update(bot.id, { env_vars: typeof config.env_vars === 'string' ? config.env_vars : JSON.stringify(config.env_vars) });
      }
      fs.unlinkSync(configPath); // Remove meta file from bot dir
    }

    res.json({ message: 'Backup restored successfully. You may need to reinstall dependencies and restart the bot.' });
  } catch (e) {
    res.status(500).json({ error: `Restore failed: ${e.message}` });
  }
});

// ─── DELETE BACKUP ───────────────────────────────────────────────────────────
router.delete('/:botId/backup/:backupId', authenticate, (req, res) => {
  const db = getDb();
  const backup = db.prepare('SELECT * FROM bot_backups WHERE id = ? AND bot_id = ?').get(req.params.backupId, req.params.botId);
  if (!backup) return res.status(404).json({ error: 'Backup not found' });

  const bot = Bots.findById(req.params.botId);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const backupPath = path.join(BACKUPS_DIR, backup.filename);
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  db.prepare('DELETE FROM bot_backups WHERE id = ?').run(backup.id);

  res.json({ message: 'Backup deleted' });
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function addDirectoryToZip(zip, dirPath, zipPath, excludeDirs) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      addDirectoryToZip(zip, fullPath, entryZipPath, excludeDirs);
    } else {
      zip.addLocalFile(fullPath, zipPath || undefined);
    }
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

module.exports = router;
