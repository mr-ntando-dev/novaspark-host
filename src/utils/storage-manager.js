'use strict';

/**
 * storage-manager.js — NovaSpark Internal Storage Engine
 *
 * Manages disk space on Render's limited 1GB disk by:
 * 1. Storing session files (auth_info_baileys, creds.json) in SQLite as compressed BLOBs
 * 2. Cleaning up bot folders (repos + node_modules) after stop
 * 3. Running a disk watchdog that evicts idle bot folders when disk usage > 80%
 * 4. Re-cloning and restoring on start (bots are on GitHub anyway)
 *
 * Session files are tiny (5-50KB) so SQLite handles them fine even with many bots.
 * The big space hogs (node_modules = 50-200MB per bot) get wiped when not running.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');
const { getDb, Bots, BotLogs } = require('../database');

const BOTS_DIR = path.join(__dirname, '..', '..', 'data', 'bots');
const DISK_USAGE_THRESHOLD = 0.80; // 80% — start cleaning
const DISK_CRITICAL_THRESHOLD = 0.92; // 92% — force-evict everything stopped

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA — bot_storage table for session blobs
// ─────────────────────────────────────────────────────────────────────────────
function initStorageSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_storage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id     TEXT NOT NULL,
      file_path  TEXT NOT NULL,
      data       BLOB NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(bot_id, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_storage_bot ON bot_storage(bot_id);
  `);
}

// Initialize on load
initStorageSchema();

// ─────────────────────────────────────────────────────────────────────────────
// SESSION BACKUP — compress and store session files into SQLite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the session directory for a bot (checks multiple common locations)
 */
function findSessionDir(botId, bot) {
  const botDir = path.join(BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) return null;

  const candidates = [
    bot && bot.session_dir ? path.join(botDir, bot.session_dir) : null,
    path.join(botDir, 'auth_info_baileys'),
    path.join(botDir, 'session'),
    path.join(botDir, '.session'),
    path.join(botDir, 'auth'),
    path.join(botDir, 'baileys_auth_info'),
    path.join(botDir, 'sessions'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return dir;
    }
  }
  return null;
}

/**
 * Backup all session files for a bot into SQLite (compressed)
 */
function backupSessionToDb(botId) {
  const bot = Bots.findById(botId);
  const sessionDir = findSessionDir(botId, bot);
  if (!sessionDir) return { backed_up: 0 };

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO bot_storage (bot_id, file_path, data, size_bytes, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(bot_id, file_path) DO UPDATE SET
      data = excluded.data,
      size_bytes = excluded.size_bytes,
      updated_at = datetime('now')
  `);

  let count = 0;
  const botDir = path.join(BOTS_DIR, botId);
  const relativeBase = path.relative(botDir, sessionDir);

  function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(fullPath);
          const compressed = zlib.gzipSync(content);
          const relativePath = path.join(relativeBase, path.relative(sessionDir, fullPath));
          upsert.run(botId, relativePath, compressed, content.length);
          count++;
        } catch (_) {}
      }
    }
  }

  try {
    walkDir(sessionDir);
    BotLogs.add(botId, 'info', `Session backed up to internal storage (${count} files)`);
  } catch (e) {
    BotLogs.add(botId, 'warn', `Session backup failed: ${e.message}`);
  }

  return { backed_up: count };
}

/**
 * Restore session files from SQLite back to disk
 */
function restoreSessionFromDb(botId) {
  const db = getDb();
  const rows = db.prepare('SELECT file_path, data FROM bot_storage WHERE bot_id = ?').all(botId);

  if (!rows || rows.length === 0) return { restored: 0 };

  const botDir = path.join(BOTS_DIR, botId);
  let count = 0;

  for (const row of rows) {
    try {
      const fullPath = path.join(botDir, row.file_path);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const decompressed = zlib.gunzipSync(row.data);
      fs.writeFileSync(fullPath, decompressed);
      count++;
    } catch (_) {}
  }

  if (count > 0) {
    BotLogs.add(botId, 'info', `Session restored from internal storage (${count} files)`);
  }

  return { restored: count };
}

/**
 * Delete session data from SQLite for a bot
 */
function clearSessionFromDb(botId) {
  const db = getDb();
  db.prepare('DELETE FROM bot_storage WHERE bot_id = ?').run(botId);
  BotLogs.add(botId, 'info', 'Session cleared from internal storage');
}

/**
 * Get storage usage stats for a bot
 */
function getStorageStats(botId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as file_count, COALESCE(SUM(size_bytes), 0) as total_bytes FROM bot_storage WHERE bot_id = ?'
  ).get(botId);
  return row || { file_count: 0, total_bytes: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISK CLEANUP — remove bot folders to free space
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get current disk usage as a fraction (0.0 - 1.0)
 */
function getDiskUsage() {
  try {
    const output = execSync("df -B1 /opt/render/project/src/data 2>/dev/null || df -B1 / 2>/dev/null | tail -1", {
      encoding: 'utf8',
      timeout: 5000
    }).trim();
    const parts = output.split(/\s+/);
    // df output: Filesystem 1B-blocks Used Available Use% Mounted
    const used = parseInt(parts[2]);
    const total = parseInt(parts[1]);
    if (total > 0) return used / total;
  } catch (_) {}
  return 0;
}

/**
 * Get folder size in bytes
 */
function getFolderSize(dirPath) {
  try {
    const output = execSync(`du -sb "${dirPath}" 2>/dev/null | cut -f1`, {
      encoding: 'utf8',
      timeout: 10000
    }).trim();
    return parseInt(output) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Clean up a single bot's folder from disk (backup session first)
 */
function evictBotFromDisk(botId) {
  const botDir = path.join(BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) return;

  // Backup session before wiping
  backupSessionToDb(botId);

  // Remove the entire bot folder
  try {
    fs.rmSync(botDir, { recursive: true, force: true });
    BotLogs.add(botId, 'info', 'Bot folder evicted from disk to free space (session saved in DB)');
  } catch (e) {
    BotLogs.add(botId, 'warn', `Failed to evict bot folder: ${e.message}`);
  }
}

/**
 * Clean up all stopped bots to free disk space.
 * Only evicts bots that are NOT currently running.
 */
function cleanupStoppedBots() {
  if (!fs.existsSync(BOTS_DIR)) return { evicted: 0, freed_bytes: 0 };

  const entries = fs.readdirSync(BOTS_DIR, { withFileTypes: true });
  let evicted = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const botId = entry.name;
    const bot = Bots.findById(botId);

    // Only evict stopped/crashed bots — never touch running ones
    if (bot && (bot.status === 'running')) continue;

    const botDir = path.join(BOTS_DIR, botId);
    const size = getFolderSize(botDir);
    evictBotFromDisk(botId);
    freedBytes += size;
    evicted++;
  }

  return { evicted, freed_bytes: freedBytes };
}

/**
 * Disk watchdog — runs periodically to prevent disk full
 */
function runDiskWatchdog() {
  const usage = getDiskUsage();

  if (usage >= DISK_CRITICAL_THRESHOLD) {
    // Critical — evict ALL stopped bots immediately
    const result = cleanupStoppedBots();
    if (result.evicted > 0) {
      console.log(`[Storage] CRITICAL: Disk at ${Math.round(usage * 100)}% — evicted ${result.evicted} stopped bots, freed ${Math.round(result.freed_bytes / 1024 / 1024)}MB`);
    }
  } else if (usage >= DISK_USAGE_THRESHOLD) {
    // Warning — evict oldest stopped bots until below threshold
    const entries = fs.readdirSync(BOTS_DIR, { withFileTypes: true }).filter(e => e.isDirectory());

    // Sort by modification time (oldest first)
    const sorted = entries.map(e => ({
      name: e.name,
      mtime: fs.statSync(path.join(BOTS_DIR, e.name)).mtimeMs
    })).sort((a, b) => a.mtime - b.mtime);

    for (const entry of sorted) {
      if (getDiskUsage() < DISK_USAGE_THRESHOLD) break;
      const bot = Bots.findById(entry.name);
      if (bot && bot.status === 'running') continue;
      evictBotFromDisk(entry.name);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL STORAGE STATS
// ─────────────────────────────────────────────────────────────────────────────
function getFullStorageInfo() {
  const db = getDb();
  const diskUsage = getDiskUsage();
  const totalStored = db.prepare('SELECT COUNT(DISTINCT bot_id) as bots, COUNT(*) as files, COALESCE(SUM(size_bytes), 0) as bytes FROM bot_storage').get();
  const botsOnDisk = fs.existsSync(BOTS_DIR)
    ? fs.readdirSync(BOTS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).length
    : 0;

  return {
    disk_usage_percent: Math.round(diskUsage * 100),
    disk_threshold_percent: Math.round(DISK_USAGE_THRESHOLD * 100),
    bots_on_disk: botsOnDisk,
    sessions_in_db: {
      bot_count: totalStored.bots,
      file_count: totalStored.files,
      total_bytes: totalStored.bytes
    }
  };
}

module.exports = {
  backupSessionToDb,
  restoreSessionFromDb,
  clearSessionFromDb,
  getStorageStats,
  evictBotFromDisk,
  cleanupStoppedBots,
  runDiskWatchdog,
  getDiskUsage,
  getFullStorageInfo,
  initStorageSchema
};
