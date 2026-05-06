'use strict';

/**
 * vault.js — NovaSpark V13: Secret Vault (Encrypted Env Var Manager)
 * 
 * Secure storage for bot secrets and environment variables.
 * Features:
 * - AES-256-GCM encryption at rest
 * - Secret rotation with history
 * - Team-scoped secrets (shared across team bots)
 * - Audit trail for all secret access
 * - Expiration dates and rotation reminders
 * - Bulk import/export (encrypted)
 */

const { Router } = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Bots, Notifications, AuditLog, getDb } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// Encryption key derived from JWT_SECRET (or a dedicated VAULT_KEY env var)
const VAULT_KEY = crypto.createHash('sha256')
  .update(process.env.VAULT_ENCRYPTION_KEY || process.env.JWT_SECRET || 'novaspark-default-vault-key')
  .digest();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// ─── ENCRYPTION HELPERS ─────────────────────────────────────────────────────
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, VAULT_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(ciphertext) {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv(ALGORITHM, VAULT_KEY, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

// ─── INIT VAULT TABLE ───────────────────────────────────────────────────────
function initVaultSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_secrets (
      id              TEXT PRIMARY KEY,
      owner_id        TEXT NOT NULL,
      bot_id          TEXT DEFAULT NULL,
      team_id         TEXT DEFAULT NULL,
      key_name        TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      description     TEXT DEFAULT '',
      category        TEXT DEFAULT 'general',
      expires_at      TEXT DEFAULT NULL,
      rotation_days   INTEGER DEFAULT NULL,
      last_rotated    TEXT DEFAULT NULL,
      last_accessed   TEXT DEFAULT NULL,
      access_count    INTEGER NOT NULL DEFAULT 0,
      version         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vault_history (
      id         TEXT PRIMARY KEY,
      secret_id  TEXT NOT NULL,
      version    INTEGER NOT NULL,
      encrypted_value TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (secret_id) REFERENCES vault_secrets(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vault_owner ON vault_secrets(owner_id);
    CREATE INDEX IF NOT EXISTS idx_vault_bot ON vault_secrets(bot_id);
    CREATE INDEX IF NOT EXISTS idx_vault_team ON vault_secrets(team_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_unique_key ON vault_secrets(owner_id, bot_id, key_name);
  `);
}

// Initialize on load
try { initVaultSchema(); } catch (_) {}

// ─── CREATE SECRET ──────────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  try {
    const { key_name, value, bot_id, team_id, description, category, expires_at, rotation_days } = req.body;

    if (!key_name || !value) {
      return res.status(400).json({ error: 'key_name and value required' });
    }

    if (!/^[A-Z][A-Z0-9_]*$/.test(key_name)) {
      return res.status(400).json({ error: 'key_name must be uppercase alphanumeric with underscores (e.g. BOT_TOKEN)' });
    }

    if (value.length > 10000) {
      return res.status(400).json({ error: 'Value too long (max 10,000 characters)' });
    }

    // Verify bot ownership if bot_id provided
    if (bot_id) {
      const bot = Bots.findById(bot_id);
      if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
        return res.status(403).json({ error: 'Not authorized for this bot' });
      }
    }

    const db = getDb();
    const id = uuidv4();
    const encryptedValue = encrypt(value);

    try {
      db.prepare(`
        INSERT INTO vault_secrets (id, owner_id, bot_id, team_id, key_name, encrypted_value, description, category, expires_at, rotation_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, req.user.id, bot_id || null, team_id || null, key_name, encryptedValue,
        description || '', category || 'general', expires_at || null, rotation_days || null);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `Secret "${key_name}" already exists for this scope` });
      }
      throw err;
    }

    AuditLog.record(req.user.id, 'vault_create', key_name, { bot_id, category });

    res.status(201).json({
      success: true,
      secret: { id, key_name, bot_id, team_id, description, category, expires_at, version: 1 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST SECRETS (metadata only, never values) ─────────────────────────────
router.get('/', authenticate, (req, res) => {
  try {
    const { bot_id, team_id, category } = req.query;
    const db = getDb();

    let query = 'SELECT id, owner_id, bot_id, team_id, key_name, description, category, expires_at, rotation_days, last_rotated, last_accessed, access_count, version, created_at, updated_at FROM vault_secrets WHERE owner_id = ?';
    const params = [req.user.id];

    if (bot_id) { query += ' AND bot_id = ?'; params.push(bot_id); }
    if (team_id) { query += ' AND team_id = ?'; params.push(team_id); }
    if (category) { query += ' AND category = ?'; params.push(category); }

    query += ' ORDER BY key_name ASC';
    const secrets = db.prepare(query).all(...params);

    // Check for expiring secrets
    const expiring = secrets.filter(s => {
      if (!s.expires_at) return false;
      const daysLeft = (new Date(s.expires_at) - Date.now()) / (1000 * 60 * 60 * 24);
      return daysLeft > 0 && daysLeft <= 7;
    });

    // Check for rotation-due secrets
    const rotationDue = secrets.filter(s => {
      if (!s.rotation_days || !s.last_rotated) return false;
      const daysSinceRotation = (Date.now() - new Date(s.last_rotated)) / (1000 * 60 * 60 * 24);
      return daysSinceRotation >= s.rotation_days;
    });

    res.json({
      secrets,
      warnings: {
        expiring: expiring.map(s => ({ key: s.key_name, expires_at: s.expires_at })),
        rotation_due: rotationDue.map(s => ({ key: s.key_name, last_rotated: s.last_rotated, rotation_days: s.rotation_days }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET SECRET VALUE (decrypted) ───────────────────────────────────────────
router.get('/:id/reveal', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const secret = db.prepare('SELECT * FROM vault_secrets WHERE id = ? AND owner_id = ?').get(id, req.user.id);
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    // Check expiration
    if (secret.expires_at && new Date(secret.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Secret has expired', expired_at: secret.expires_at });
    }

    const decryptedValue = decrypt(secret.encrypted_value);

    // Update access tracking
    db.prepare("UPDATE vault_secrets SET last_accessed = datetime('now'), access_count = access_count + 1 WHERE id = ?").run(id);
    AuditLog.record(req.user.id, 'vault_access', secret.key_name);

    res.json({
      key_name: secret.key_name,
      value: decryptedValue,
      version: secret.version,
      last_rotated: secret.last_rotated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ROTATE SECRET ──────────────────────────────────────────────────────────
router.post('/:id/rotate', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { new_value } = req.body;

    if (!new_value) return res.status(400).json({ error: 'new_value required' });

    const db = getDb();
    const secret = db.prepare('SELECT * FROM vault_secrets WHERE id = ? AND owner_id = ?').get(id, req.user.id);
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    // Save old version to history
    const historyId = uuidv4();
    db.prepare('INSERT INTO vault_history (id, secret_id, version, encrypted_value, changed_by) VALUES (?, ?, ?, ?, ?)')
      .run(historyId, id, secret.version, secret.encrypted_value, req.user.id);

    // Update with new value
    const newEncrypted = encrypt(new_value);
    const newVersion = secret.version + 1;
    db.prepare("UPDATE vault_secrets SET encrypted_value = ?, version = ?, last_rotated = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(newEncrypted, newVersion, id);

    AuditLog.record(req.user.id, 'vault_rotate', secret.key_name, { from_version: secret.version, to_version: newVersion });

    res.json({
      success: true,
      key_name: secret.key_name,
      version: newVersion,
      message: `Secret rotated to version ${newVersion}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET SECRET HISTORY ─────────────────────────────────────────────────────
router.get('/:id/history', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const secret = db.prepare('SELECT * FROM vault_secrets WHERE id = ? AND owner_id = ?').get(id, req.user.id);
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    const history = db.prepare('SELECT id, version, changed_by, changed_at FROM vault_history WHERE secret_id = ? ORDER BY version DESC').all(id);

    res.json({
      key_name: secret.key_name,
      current_version: secret.version,
      history
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE SECRET ──────────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const secret = db.prepare('SELECT * FROM vault_secrets WHERE id = ? AND owner_id = ?').get(id, req.user.id);
    if (!secret) return res.status(404).json({ error: 'Secret not found' });

    db.prepare('DELETE FROM vault_secrets WHERE id = ?').run(id);
    AuditLog.record(req.user.id, 'vault_delete', secret.key_name);

    res.json({ success: true, message: `Secret "${secret.key_name}" deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BULK INJECT SECRETS INTO BOT ENV ───────────────────────────────────────
router.post('/inject/:botId', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const db = getDb();
    const secrets = db.prepare('SELECT * FROM vault_secrets WHERE owner_id = ? AND (bot_id = ? OR bot_id IS NULL)').all(req.user.id, botId);

    const envVars = {};
    for (const secret of secrets) {
      if (secret.expires_at && new Date(secret.expires_at) < new Date()) continue; // Skip expired
      try {
        envVars[secret.key_name] = decrypt(secret.encrypted_value);
      } catch (_) {}
    }

    // Update bot env_vars
    const currentEnv = JSON.parse(bot.env_vars || '{}');
    const merged = { ...currentEnv, ...envVars };
    Bots.update(botId, { env_vars: JSON.stringify(merged) });

    AuditLog.record(req.user.id, 'vault_inject', botId, { keys: Object.keys(envVars) });

    res.json({
      success: true,
      injected: Object.keys(envVars).length,
      keys: Object.keys(envVars),
      message: `${Object.keys(envVars).length} secrets injected into bot env`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.encrypt = encrypt;
module.exports.decrypt = decrypt;
