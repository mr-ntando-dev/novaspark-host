'use strict';

/**
 * status-pages.js — NovaSpark V13: Public Bot Status Pages
 * 
 * Each bot can have a public status page showing:
 * - Current uptime status
 * - Historical uptime (90 days)
 * - Incident reports
 * - Maintenance windows
 * - Response time graphs
 * 
 * Think statuspage.io but built into the platform.
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { Bots, BotLogs, Notifications, getDb } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// ─── INIT STATUS PAGE TABLES ────────────────────────────────────────────────
function initStatusPageSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS status_pages (
      id              TEXT PRIMARY KEY,
      bot_id          TEXT NOT NULL UNIQUE,
      owner_id        TEXT NOT NULL,
      slug            TEXT UNIQUE NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT DEFAULT '',
      is_public       INTEGER NOT NULL DEFAULT 1,
      custom_domain   TEXT DEFAULT NULL,
      theme_color     TEXT DEFAULT '#6366f1',
      logo_url        TEXT DEFAULT NULL,
      show_uptime     INTEGER NOT NULL DEFAULT 1,
      show_response_time INTEGER NOT NULL DEFAULT 1,
      show_incidents  INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS status_incidents (
      id           TEXT PRIMARY KEY,
      status_page_id TEXT NOT NULL,
      title        TEXT NOT NULL,
      description  TEXT DEFAULT '',
      severity     TEXT NOT NULL DEFAULT 'minor',
      status       TEXT NOT NULL DEFAULT 'investigating',
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at  TEXT DEFAULT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS status_incident_updates (
      id          TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      status      TEXT NOT NULL,
      message     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (incident_id) REFERENCES status_incidents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS status_maintenance (
      id              TEXT PRIMARY KEY,
      status_page_id  TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT DEFAULT '',
      scheduled_start TEXT NOT NULL,
      scheduled_end   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'scheduled',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS status_uptime_checks (
      id              TEXT PRIMARY KEY,
      status_page_id  TEXT NOT NULL,
      checked_at      TEXT NOT NULL DEFAULT (datetime('now')),
      is_up           INTEGER NOT NULL DEFAULT 1,
      response_time_ms INTEGER DEFAULT NULL,
      status_code     INTEGER DEFAULT NULL,
      FOREIGN KEY (status_page_id) REFERENCES status_pages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_status_pages_slug ON status_pages(slug);
    CREATE INDEX IF NOT EXISTS idx_status_incidents_page ON status_incidents(status_page_id);
    CREATE INDEX IF NOT EXISTS idx_status_uptime_page ON status_uptime_checks(status_page_id);
  `);
}

try { initStatusPageSchema(); } catch (_) {}

// ─── CREATE STATUS PAGE ─────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  try {
    const { bot_id, title, description, slug, theme_color } = req.body;

    if (!bot_id || !title || !slug) {
      return res.status(400).json({ error: 'bot_id, title, and slug required' });
    }

    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with dashes' });
    }

    const bot = Bots.findById(bot_id);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const db = getDb();
    const id = uuidv4();

    try {
      db.prepare(`
        INSERT INTO status_pages (id, bot_id, owner_id, slug, title, description, theme_color)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, bot_id, req.user.id, slug, title, description || '', theme_color || '#6366f1');
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Slug or bot already has a status page' });
      }
      throw err;
    }

    res.status(201).json({
      success: true,
      status_page: { id, bot_id, slug, title, url: `/status/${slug}` }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET PUBLIC STATUS PAGE (no auth required) ──────────────────────────────
router.get('/public/:slug', (req, res) => {
  try {
    const { slug } = req.params;
    const db = getDb();

    const page = db.prepare('SELECT * FROM status_pages WHERE slug = ? AND is_public = 1').get(slug);
    if (!page) return res.status(404).json({ error: 'Status page not found' });

    const bot = Bots.findById(page.bot_id);
    const currentStatus = bot ? bot.status : 'unknown';

    // Get recent incidents
    const incidents = db.prepare(`
      SELECT * FROM status_incidents WHERE status_page_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(page.id);

    // Get uptime percentage (last 90 days)
    const uptimeChecks = db.prepare(`
      SELECT * FROM status_uptime_checks WHERE status_page_id = ? AND checked_at > datetime('now', '-90 days')
      ORDER BY checked_at DESC
    `).all(page.id);

    const totalChecks = uptimeChecks.length;
    const upChecks = uptimeChecks.filter(c => c.is_up).length;
    const uptimePercentage = totalChecks > 0 ? ((upChecks / totalChecks) * 100).toFixed(2) : 100;

    // Average response time
    const responseTimes = uptimeChecks.filter(c => c.response_time_ms).map(c => c.response_time_ms);
    const avgResponseTime = responseTimes.length > 0
      ? Math.round(responseTimes.reduce((s, v) => s + v, 0) / responseTimes.length)
      : null;

    // Scheduled maintenance
    const maintenance = db.prepare(`
      SELECT * FROM status_maintenance WHERE status_page_id = ? AND scheduled_end > datetime('now') ORDER BY scheduled_start ASC
    `).all(page.id);

    // Daily uptime for the last 90 days (for the chart)
    const dailyUptime = [];
    for (let i = 89; i >= 0; i--) {
      const dayChecks = uptimeChecks.filter(c => {
        const checkDate = new Date(c.checked_at);
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - i);
        return checkDate.toDateString() === targetDate.toDateString();
      });
      const dayUp = dayChecks.filter(c => c.is_up).length;
      dailyUptime.push({
        date: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
        uptime: dayChecks.length > 0 ? ((dayUp / dayChecks.length) * 100).toFixed(1) : 100,
        checks: dayChecks.length
      });
    }

    res.json({
      page: {
        title: page.title,
        description: page.description,
        theme_color: page.theme_color,
        logo_url: page.logo_url
      },
      current_status: currentStatus === 'running' ? 'operational' : currentStatus === 'crashed' ? 'major_outage' : 'unknown',
      uptime_percentage: parseFloat(uptimePercentage),
      avg_response_time_ms: avgResponseTime,
      incidents: incidents.map(i => ({
        ...i,
        updates: db.prepare('SELECT * FROM status_incident_updates WHERE incident_id = ? ORDER BY created_at DESC').all(i.id)
      })),
      maintenance,
      daily_uptime: page.show_uptime ? dailyUptime : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE INCIDENT ────────────────────────────────────────────────────────
router.post('/:pageId/incidents', authenticate, (req, res) => {
  try {
    const { pageId } = req.params;
    const { title, description, severity } = req.body;

    if (!title) return res.status(400).json({ error: 'title required' });

    const db = getDb();
    const page = db.prepare('SELECT * FROM status_pages WHERE id = ? AND owner_id = ?').get(pageId, req.user.id);
    if (!page) return res.status(404).json({ error: 'Status page not found' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO status_incidents (id, status_page_id, title, description, severity)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, pageId, title, description || '', severity || 'minor');

    // Auto-create first update
    const updateId = uuidv4();
    db.prepare('INSERT INTO status_incident_updates (id, incident_id, status, message) VALUES (?, ?, ?, ?)')
      .run(updateId, id, 'investigating', description || `We are investigating ${title}`);

    res.status(201).json({ success: true, incident: { id, title, severity, status: 'investigating' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UPDATE INCIDENT ────────────────────────────────────────────────────────
router.post('/:pageId/incidents/:incidentId/update', authenticate, (req, res) => {
  try {
    const { pageId, incidentId } = req.params;
    const { status, message } = req.body;

    if (!status || !message) return res.status(400).json({ error: 'status and message required' });

    const db = getDb();
    const page = db.prepare('SELECT * FROM status_pages WHERE id = ? AND owner_id = ?').get(pageId, req.user.id);
    if (!page) return res.status(404).json({ error: 'Status page not found' });

    const updateId = uuidv4();
    db.prepare('INSERT INTO status_incident_updates (id, incident_id, status, message) VALUES (?, ?, ?, ?)')
      .run(updateId, incidentId, status, message);

    // If resolved, update incident
    if (status === 'resolved') {
      db.prepare("UPDATE status_incidents SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(incidentId);
    } else {
      db.prepare('UPDATE status_incidents SET status = ? WHERE id = ?').run(status, incidentId);
    }

    res.json({ success: true, update: { id: updateId, status, message } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SCHEDULE MAINTENANCE ───────────────────────────────────────────────────
router.post('/:pageId/maintenance', authenticate, (req, res) => {
  try {
    const { pageId } = req.params;
    const { title, description, scheduled_start, scheduled_end } = req.body;

    if (!title || !scheduled_start || !scheduled_end) {
      return res.status(400).json({ error: 'title, scheduled_start, and scheduled_end required' });
    }

    const db = getDb();
    const page = db.prepare('SELECT * FROM status_pages WHERE id = ? AND owner_id = ?').get(pageId, req.user.id);
    if (!page) return res.status(404).json({ error: 'Status page not found' });

    const id = uuidv4();
    db.prepare('INSERT INTO status_maintenance (id, status_page_id, title, description, scheduled_start, scheduled_end) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, pageId, title, description || '', scheduled_start, scheduled_end);

    res.status(201).json({ success: true, maintenance: { id, title, scheduled_start, scheduled_end } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST USER'S STATUS PAGES ───────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  try {
    const db = getDb();
    const pages = db.prepare('SELECT * FROM status_pages WHERE owner_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ pages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE STATUS PAGE ─────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();
    const page = db.prepare('SELECT * FROM status_pages WHERE id = ? AND owner_id = ?').get(id, req.user.id);
    if (!page) return res.status(404).json({ error: 'Status page not found' });

    db.prepare('DELETE FROM status_pages WHERE id = ?').run(id);
    res.json({ success: true, message: 'Status page deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
