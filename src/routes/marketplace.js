'use strict';

/**
 * marketplace.js — Bot Marketplace
 * 
 * Users can publish bot templates, browse community-shared bots,
 * rate/review them, and one-click deploy from the marketplace.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { getDb, Users } = require('../database');
const { v4: uuidv4 } = require('uuid');

const router = Router();

// ─── PUBLISH BOT TEMPLATE ────────────────────────────────────────────────────
router.post('/publish', authenticate, (req, res) => {
  const { name, description, repo_url, branch, entry_point, category, tags, preview_image, documentation } = req.body;

  if (!name || !repo_url) {
    return res.status(400).json({ error: 'name and repo_url required' });
  }

  const validCategories = ['whatsapp', 'discord', 'telegram', 'multi-platform', 'utility', 'game', 'moderation', 'music', 'other'];
  const cat = validCategories.includes(category) ? category : 'other';

  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO marketplace_bots (id, author_id, name, description, repo_url, branch, entry_point, category, tags, preview_image, documentation, status, downloads, rating, review_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, datetime('now'))
  `).run(id, req.user.id, name.slice(0, 80), (description || '').slice(0, 500), repo_url, branch || 'main', entry_point || 'index.js', cat, JSON.stringify(tags || []), preview_image || null, (documentation || '').slice(0, 5000));

  res.status(201).json({
    listing: { id, name, status: 'pending' },
    message: 'Bot submitted to marketplace. It will be reviewed before appearing publicly.'
  });
});

// ─── BROWSE MARKETPLACE ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const { category, search, sort, page } = req.query;
  const limit = 20;
  const offset = ((parseInt(page) || 1) - 1) * limit;

  let where = "WHERE m.status = 'approved'";
  const params = [];

  if (category && category !== 'all') {
    where += ' AND m.category = ?';
    params.push(category);
  }

  if (search) {
    where += ' AND (m.name LIKE ? OR m.description LIKE ? OR m.tags LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  let orderBy = 'ORDER BY m.downloads DESC';
  if (sort === 'newest') orderBy = 'ORDER BY m.created_at DESC';
  if (sort === 'rating') orderBy = 'ORDER BY m.rating DESC';
  if (sort === 'popular') orderBy = 'ORDER BY m.downloads DESC';

  const bots = db.prepare(`
    SELECT m.*, u.username as author_name, u.avatar_emoji as author_avatar
    FROM marketplace_bots m
    JOIN users u ON u.id = m.author_id
    ${where}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM marketplace_bots m ${where}`).get(...params);

  res.json({
    bots: bots.map(b => ({ ...b, tags: JSON.parse(b.tags || '[]') })),
    total: total.count,
    page: parseInt(page) || 1,
    total_pages: Math.ceil(total.count / limit)
  });
});

// ─── GET SINGLE LISTING ──────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = getDb();
  const bot = db.prepare(`
    SELECT m.*, u.username as author_name, u.avatar_emoji as author_avatar
    FROM marketplace_bots m
    JOIN users u ON u.id = m.author_id
    WHERE m.id = ?
  `).get(req.params.id);

  if (!bot) return res.status(404).json({ error: 'Listing not found' });

  // Get reviews
  const reviews = db.prepare(`
    SELECT r.*, u.username, u.avatar_emoji
    FROM marketplace_reviews r
    JOIN users u ON u.id = r.user_id
    WHERE r.listing_id = ?
    ORDER BY r.created_at DESC
    LIMIT 20
  `).all(req.params.id);

  res.json({ bot: { ...bot, tags: JSON.parse(bot.tags || '[]') }, reviews });
});

// ─── REVIEW / RATE ───────────────────────────────────────────────────────────
router.post('/:id/review', authenticate, (req, res) => {
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });

  const db = getDb();
  const listing = db.prepare('SELECT * FROM marketplace_bots WHERE id = ?').get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });

  // Check if already reviewed
  const existing = db.prepare('SELECT * FROM marketplace_reviews WHERE listing_id = ? AND user_id = ?').get(listing.id, req.user.id);
  if (existing) return res.status(409).json({ error: 'You already reviewed this bot' });

  db.prepare(`
    INSERT INTO marketplace_reviews (id, listing_id, user_id, rating, comment, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(uuidv4(), listing.id, req.user.id, rating, (comment || '').slice(0, 500));

  // Update average rating
  const stats = db.prepare('SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM marketplace_reviews WHERE listing_id = ?').get(listing.id);
  db.prepare('UPDATE marketplace_bots SET rating = ?, review_count = ? WHERE id = ?').run(
    parseFloat(stats.avg_rating.toFixed(1)), stats.count, listing.id
  );

  res.json({ message: 'Review submitted' });
});

// ─── INCREMENT DOWNLOAD ──────────────────────────────────────────────────────
router.post('/:id/download', authenticate, (req, res) => {
  const db = getDb();
  const listing = db.prepare('SELECT * FROM marketplace_bots WHERE id = ?').get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });

  db.prepare('UPDATE marketplace_bots SET downloads = downloads + 1 WHERE id = ?').run(listing.id);
  res.json({ repo_url: listing.repo_url, branch: listing.branch, entry_point: listing.entry_point });
});

// ─── ADMIN: APPROVE/REJECT ───────────────────────────────────────────────────
router.put('/:id/status', authenticate, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Status must be approved or rejected' });

  const db = getDb();
  db.prepare('UPDATE marketplace_bots SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ message: `Listing ${status}` });
});

module.exports = router;
