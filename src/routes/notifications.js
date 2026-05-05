'use strict';

const { Router } = require('express');
const { Notifications } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// ─── GET MY NOTIFICATIONS ────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const notifications = Notifications.getByUser(req.user.id, limit);
  const unread = Notifications.unreadCount(req.user.id);
  res.json({ notifications, unread });
});

// ─── MARK AS READ ────────────────────────────────────────────────────────────
router.put('/:id/read', authenticate, (req, res) => {
  Notifications.markRead(req.params.id);
  res.json({ message: 'Marked as read' });
});

// ─── MARK ALL READ ──────────────────────────────────────────────────────────
router.put('/read-all', authenticate, (req, res) => {
  Notifications.markAllRead(req.user.id);
  res.json({ message: 'All notifications marked as read' });
});

module.exports = router;
