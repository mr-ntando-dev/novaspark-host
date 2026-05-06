'use strict';

/**
 * versioning.js — Bot Versioning & Rollback
 * 
 * Tracks every deploy as a version. Users can view deploy history,
 * compare versions, and instantly rollback to any previous deploy.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { Bots, getDb } = require('../database');
const { v4: uuidv4 } = require('uuid');

const router = Router();

// ─── LIST DEPLOY VERSIONS ────────────────────────────────────────────────────
router.get('/:botId', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.botId);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const versions = db.prepare(`
    SELECT * FROM bot_versions 
    WHERE bot_id = ? 
    ORDER BY version_number DESC
    LIMIT 50
  `).all(bot.id);

  res.json({
    versions: versions.map(v => ({
      ...v,
      is_current: v.is_current === 1,
      metadata: JSON.parse(v.metadata || '{}')
    })),
    current_version: versions.find(v => v.is_current === 1) || null
  });
});

// ─── GET VERSION DETAILS ─────────────────────────────────────────────────────
router.get('/:botId/version/:versionId', authenticate, (req, res) => {
  const bot = Bots.findById(req.params.botId);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const version = db.prepare('SELECT * FROM bot_versions WHERE id = ? AND bot_id = ?').get(req.params.versionId, bot.id);
  if (!version) return res.status(404).json({ error: 'Version not found' });

  res.json({
    version: { ...version, is_current: version.is_current === 1, metadata: JSON.parse(version.metadata || '{}') }
  });
});

// ─── ROLLBACK TO VERSION ─────────────────────────────────────────────────────
router.post('/:botId/rollback/:versionId', authenticate, async (req, res) => {
  const bot = Bots.findById(req.params.botId);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const targetVersion = db.prepare('SELECT * FROM bot_versions WHERE id = ? AND bot_id = ?').get(req.params.versionId, bot.id);
  if (!targetVersion) return res.status(404).json({ error: 'Version not found' });

  const metadata = JSON.parse(targetVersion.metadata || '{}');

  try {
    // Stop bot
    const { stopBot, cloneRepo, startBot } = require('../utils/bot-engine');
    if (bot.status === 'running') stopBot(bot.id);

    // Re-deploy from the specific commit
    const repoUrl = metadata.repo_url || bot.repo_url;
    const branch = metadata.branch || bot.branch;
    const commit = metadata.commit_sha || null;

    if (!repoUrl) {
      return res.status(400).json({ error: 'No repository URL available for this version' });
    }

    // Update bot config to match the version
    const updates = {};
    if (metadata.entry_point) updates.entry_point = metadata.entry_point;
    if (metadata.branch) updates.branch = metadata.branch;
    if (Object.keys(updates).length > 0) {
      Bots.update(bot.id, updates);
    }

    // Mark this version as current
    db.prepare('UPDATE bot_versions SET is_current = 0 WHERE bot_id = ?').run(bot.id);
    db.prepare('UPDATE bot_versions SET is_current = 1 WHERE id = ?').run(targetVersion.id);

    res.json({
      message: `Rolled back to version ${targetVersion.version_number}. Redeploy required to apply changes.`,
      version: targetVersion.version_number,
      commit: commit
    });
  } catch (e) {
    res.status(500).json({ error: `Rollback failed: ${e.message}` });
  }
});

// ─── CREATE VERSION (called internally during deploy) ────────────────────────
function createVersion(botId, ownerId, metadata = {}) {
  try {
    const db = getDb();

    // Get next version number
    const last = db.prepare('SELECT MAX(version_number) as max_v FROM bot_versions WHERE bot_id = ?').get(botId);
    const versionNumber = (last.max_v || 0) + 1;

    const id = uuidv4();

    // Unmark previous current
    db.prepare('UPDATE bot_versions SET is_current = 0 WHERE bot_id = ?').run(botId);

    db.prepare(`
      INSERT INTO bot_versions (id, bot_id, owner_id, version_number, is_current, metadata, created_at)
      VALUES (?, ?, ?, ?, 1, ?, datetime('now'))
    `).run(id, botId, ownerId, versionNumber, JSON.stringify(metadata));

    return { id, version_number: versionNumber };
  } catch (e) {
    console.error(`[Versioning] Failed to create version for bot ${botId}: ${e.message}`);
    return null;
  }
}

module.exports = router;
module.exports.createVersion = createVersion;
