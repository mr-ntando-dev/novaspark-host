'use strict';

/**
 * database.js — NovaSpark V11 SQLite Database Layer
 * 
 * Zero-config embedded database using Node 22+ built-in node:sqlite.
 * WAL mode for concurrent reads. All data persists in data/novaspark.db.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'novaspark.db');

let _db = null;

function getDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
    _db.exec("PRAGMA busy_timeout = 5000");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db) {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════════════
    -- USERS
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS users (
      id                TEXT PRIMARY KEY,
      username          TEXT UNIQUE NOT NULL,
      email             TEXT DEFAULT NULL,
      password          TEXT NOT NULL,
      role              TEXT NOT NULL DEFAULT 'user',
      plan              TEXT NOT NULL DEFAULT 'free',
      plan_expires_at   TEXT DEFAULT NULL,
      coins             INTEGER NOT NULL DEFAULT 0,
      total_earned      INTEGER NOT NULL DEFAULT 0,
      total_spent       INTEGER NOT NULL DEFAULT 0,
      whatsapp_number   TEXT DEFAULT NULL,
      referred_by       TEXT DEFAULT NULL,
      referral_code     TEXT UNIQUE,
      referral_count    INTEGER NOT NULL DEFAULT 0,
      last_daily_reward TEXT DEFAULT NULL,
      has_vip_access    INTEGER NOT NULL DEFAULT 0,
      two_fa_secret     TEXT DEFAULT NULL,
      two_fa_enabled    INTEGER NOT NULL DEFAULT 0,
      avatar_emoji      TEXT DEFAULT '🤖',
      bio               TEXT DEFAULT NULL,
      banner_color      TEXT DEFAULT '#6366f1',
      social_links      TEXT DEFAULT '{}',
      is_banned         INTEGER NOT NULL DEFAULT 0,
      ban_reason        TEXT DEFAULT NULL,
      last_login        TEXT DEFAULT NULL,
      login_streak      INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══════════════════════════════════════════════════════════════════════
    -- BOTS (hosted bot instances)
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS bots (
      id                TEXT PRIMARY KEY,
      owner_id          TEXT NOT NULL,
      name              TEXT NOT NULL,
      description       TEXT DEFAULT '',
      repo_url          TEXT DEFAULT NULL,
      branch            TEXT DEFAULT 'main',
      entry_point       TEXT DEFAULT 'index.js',
      status            TEXT NOT NULL DEFAULT 'stopped',
      server_tier       TEXT DEFAULT 'basic',
      pid               INTEGER DEFAULT NULL,
      port              INTEGER DEFAULT NULL,
      start_time        TEXT DEFAULT NULL,
      paid_until        TEXT DEFAULT NULL,
      auto_restart      INTEGER NOT NULL DEFAULT 1,
      restart_count     INTEGER NOT NULL DEFAULT 0,
      max_ram_mb        INTEGER NOT NULL DEFAULT 512,
      last_health_check TEXT DEFAULT NULL,
      health_status     TEXT DEFAULT 'unknown',
      uptime_seconds    INTEGER NOT NULL DEFAULT 0,
      total_restarts    INTEGER NOT NULL DEFAULT 0,
      env_vars          TEXT DEFAULT '{}',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════════════════════════════════
    -- BOT LOGS (stdout/stderr captured per bot)
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS bot_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id     TEXT NOT NULL,
      level      TEXT NOT NULL DEFAULT 'info',
      message    TEXT NOT NULL,
      timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════════════════════════════════
    -- TRANSACTIONS (coin economy ledger)
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS transactions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      balance     INTEGER NOT NULL,
      description TEXT DEFAULT '',
      metadata    TEXT DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════════════════════════════════
    -- REDEMPTION CODES
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS redemption_codes (
      id           TEXT PRIMARY KEY,
      code         TEXT UNIQUE NOT NULL,
      type         TEXT NOT NULL DEFAULT 'coins',
      value        INTEGER NOT NULL DEFAULT 0,
      max_uses     INTEGER NOT NULL DEFAULT 1,
      used_count   INTEGER NOT NULL DEFAULT 0,
      used_by      TEXT DEFAULT '[]',
      expires_at   TEXT DEFAULT NULL,
      created_by   TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══════════════════════════════════════════════════════════════════════
    -- NOTIFICATIONS
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'info',
      title      TEXT NOT NULL,
      message    TEXT NOT NULL,
      read       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════════════════════════════════
    -- BACKUPS
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS backups (
      id         TEXT PRIMARY KEY,
      bot_id     TEXT NOT NULL,
      owner_id   TEXT NOT NULL,
      filename   TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════════════════════════════════
    -- AUDIT LOG (admin actions tracking)
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id   TEXT NOT NULL,
      action     TEXT NOT NULL,
      target     TEXT DEFAULT NULL,
      details    TEXT DEFAULT '{}',
      ip_address TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══════════════════════════════════════════════════════════════════════
    -- API KEYS (for external integrations)
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS api_keys (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      key_hash   TEXT UNIQUE NOT NULL,
      prefix     TEXT NOT NULL,
      scopes     TEXT DEFAULT '["read"]',
      last_used  TEXT DEFAULT NULL,
      expires_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════════════════════════════════
    -- INDEXES
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
    CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status);
    CREATE INDEX IF NOT EXISTS idx_bot_logs_bot ON bot_logs(bot_id);
    CREATE INDEX IF NOT EXISTS idx_bot_logs_ts ON bot_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: generic CRUD wrappers
// ─────────────────────────────────────────────────────────────────────────────
function generateId() { return uuidv4(); }

function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// ─────────────────────────────────────────────────────────────────────────────
// USER operations
// ─────────────────────────────────────────────────────────────────────────────
const Users = {
  create(data) {
    const db = getDb();
    const id = data.id || generateId();
    const referralCode = data.referral_code || `NS-${id.slice(0, 8).toUpperCase()}`;
    const stmt = db.prepare(`
      INSERT INTO users (id, username, email, password, role, plan, coins, referral_code, referred_by, avatar_emoji, banner_color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, data.username, data.email || null, data.password, data.role || 'user',
      data.plan || 'free', data.coins || 0, referralCode, data.referred_by || null,
      data.avatar_emoji || '🤖', data.banner_color || '#6366f1');
    return this.findById(id);
  },

  findById(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row || null;
  },

  findByUsername(username) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    return row || null;
  },

  findByReferralCode(code) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(code);
    return row || null;
  },

  update(id, data) {
    const db = getDb();
    const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = Object.values(data);
    db.prepare(`UPDATE users SET ${fields}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
    return this.findById(id);
  },

  delete(id) {
    const db = getDb();
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },

  list(limit = 100, offset = 0) {
    const db = getDb();
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  },

  count() {
    const db = getDb();
    return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  },

  addCoins(id, amount, description = '') {
    const db = getDb();
    const user = this.findById(id);
    if (!user) return null;
    const newBalance = user.coins + amount;
    db.prepare('UPDATE users SET coins = ?, total_earned = total_earned + ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(newBalance, Math.max(0, amount), id);
    // Record transaction
    Transactions.create({ user_id: id, type: amount > 0 ? 'credit' : 'debit', amount, balance: newBalance, description });
    return this.findById(id);
  },

  spendCoins(id, amount, description = '') {
    const db = getDb();
    const user = this.findById(id);
    if (!user || user.coins < amount) return null;
    const newBalance = user.coins - amount;
    db.prepare('UPDATE users SET coins = ?, total_spent = total_spent + ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(newBalance, amount, id);
    Transactions.create({ user_id: id, type: 'debit', amount: -amount, balance: newBalance, description });
    return this.findById(id);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BOT operations
// ─────────────────────────────────────────────────────────────────────────────
const Bots = {
  create(data) {
    const db = getDb();
    const id = data.id || generateId();
    db.prepare(`
      INSERT INTO bots (id, owner_id, name, description, repo_url, branch, entry_point, server_tier, env_vars, auto_restart)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.owner_id, data.name, data.description || '', data.repo_url || null,
      data.branch || 'main', data.entry_point || 'index.js', data.server_tier || 'basic',
      JSON.stringify(data.env_vars || {}), data.auto_restart !== undefined ? data.auto_restart : 1);
    return this.findById(id);
  },

  findById(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM bots WHERE id = ?').get(id) || null;
  },

  findByOwner(ownerId) {
    const db = getDb();
    return db.prepare('SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId);
  },

  update(id, data) {
    const db = getDb();
    const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = Object.values(data);
    db.prepare(`UPDATE bots SET ${fields}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
    return this.findById(id);
  },

  delete(id) {
    const db = getDb();
    db.prepare('DELETE FROM bots WHERE id = ?').run(id);
  },

  listAll(limit = 100, offset = 0) {
    const db = getDb();
    return db.prepare('SELECT * FROM bots ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  },

  countByOwner(ownerId) {
    const db = getDb();
    return db.prepare('SELECT COUNT(*) as count FROM bots WHERE owner_id = ?').get(ownerId).count;
  },

  countByStatus(status) {
    const db = getDb();
    return db.prepare('SELECT COUNT(*) as count FROM bots WHERE status = ?').get(status).count;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BOT LOGS
// ─────────────────────────────────────────────────────────────────────────────
const BotLogs = {
  add(botId, level, message) {
    const db = getDb();
    db.prepare('INSERT INTO bot_logs (bot_id, level, message) VALUES (?, ?, ?)').run(botId, level, message);
  },

  getRecent(botId, limit = 100) {
    const db = getDb();
    return db.prepare('SELECT * FROM bot_logs WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?').all(botId, limit);
  },

  clear(botId) {
    const db = getDb();
    db.prepare('DELETE FROM bot_logs WHERE bot_id = ?').run(botId);
  },

  prune(daysOld = 7) {
    const db = getDb();
    db.prepare(`DELETE FROM bot_logs WHERE timestamp < datetime('now', '-' || ? || ' days')`).run(daysOld);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTIONS
// ─────────────────────────────────────────────────────────────────────────────
const Transactions = {
  create(data) {
    const db = getDb();
    const id = generateId();
    db.prepare(`
      INSERT INTO transactions (id, user_id, type, amount, balance, description, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.user_id, data.type, data.amount, data.balance, data.description || '', JSON.stringify(data.metadata || {}));
    return { id, ...data };
  },

  getByUser(userId, limit = 50) {
    const db = getDb();
    return db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REDEMPTION CODES
// ─────────────────────────────────────────────────────────────────────────────
const RedemptionCodes = {
  create(data) {
    const db = getDb();
    const id = generateId();
    db.prepare(`
      INSERT INTO redemption_codes (id, code, type, value, max_uses, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.code, data.type || 'coins', data.value, data.max_uses || 1, data.expires_at || null, data.created_by);
    return this.findByCode(data.code);
  },

  findByCode(code) {
    const db = getDb();
    return db.prepare('SELECT * FROM redemption_codes WHERE code = ?').get(code) || null;
  },

  use(code, userId) {
    const db = getDb();
    const rc = this.findByCode(code);
    if (!rc) return { error: 'Code not found' };
    if (rc.used_count >= rc.max_uses) return { error: 'Code fully redeemed' };
    if (rc.expires_at && new Date(rc.expires_at) < new Date()) return { error: 'Code expired' };
    const usedBy = JSON.parse(rc.used_by || '[]');
    if (usedBy.includes(userId)) return { error: 'Already used by you' };
    usedBy.push(userId);
    db.prepare('UPDATE redemption_codes SET used_count = used_count + 1, used_by = ? WHERE id = ?')
      .run(JSON.stringify(usedBy), rc.id);
    return { success: true, type: rc.type, value: rc.value };
  },

  list() {
    const db = getDb();
    return db.prepare('SELECT * FROM redemption_codes ORDER BY created_at DESC').all();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
const Notifications = {
  create(userId, type, title, message) {
    const db = getDb();
    const id = generateId();
    db.prepare('INSERT INTO notifications (id, user_id, type, title, message) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, type, title, message);
    return { id, user_id: userId, type, title, message };
  },

  getByUser(userId, limit = 50) {
    const db = getDb();
    return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  },

  markRead(id) {
    const db = getDb();
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  },

  markAllRead(userId) {
    const db = getDb();
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId);
  },

  unreadCount(userId) {
    const db = getDb();
    return db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0').get(userId).count;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────────────────────────────────────
const AuditLog = {
  record(actorId, action, target = null, details = {}, ipAddress = null) {
    const db = getDb();
    db.prepare('INSERT INTO audit_log (actor_id, action, target, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(actorId, action, target, JSON.stringify(details), ipAddress);
  },

  getRecent(limit = 100) {
    const db = getDb();
    return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// API KEYS
// ─────────────────────────────────────────────────────────────────────────────
const ApiKeys = {
  create(data) {
    const db = getDb();
    const id = generateId();
    db.prepare(`
      INSERT INTO api_keys (id, user_id, name, key_hash, prefix, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.user_id, data.name, data.key_hash, data.prefix, JSON.stringify(data.scopes || ['read']), data.expires_at || null);
    return { id, prefix: data.prefix, name: data.name };
  },

  findByHash(hash) {
    const db = getDb();
    return db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash) || null;
  },

  listByUser(userId) {
    const db = getDb();
    return db.prepare('SELECT id, name, prefix, scopes, last_used, created_at FROM api_keys WHERE user_id = ?').all(userId);
  },

  delete(id) {
    const db = getDb();
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  },

  touch(id) {
    const db = getDb();
    db.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?").run(id);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BACKUPS
// ─────────────────────────────────────────────────────────────────────────────
const Backups = {
  create(data) {
    const db = getDb();
    const id = generateId();
    db.prepare('INSERT INTO backups (id, bot_id, owner_id, filename, size_bytes) VALUES (?, ?, ?, ?, ?)')
      .run(id, data.bot_id, data.owner_id, data.filename, data.size_bytes || 0);
    return { id, ...data };
  },

  listByBot(botId) {
    const db = getDb();
    return db.prepare('SELECT * FROM backups WHERE bot_id = ? ORDER BY created_at DESC').all(botId);
  },

  listByOwner(ownerId) {
    const db = getDb();
    return db.prepare('SELECT * FROM backups WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId);
  },

  delete(id) {
    const db = getDb();
    db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  }
};

module.exports = {
  getDb,
  Users,
  Bots,
  BotLogs,
  Transactions,
  RedemptionCodes,
  Notifications,
  AuditLog,
  ApiKeys,
  Backups
};
