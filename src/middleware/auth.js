'use strict';

const jwt = require('jsonwebtoken');
const { Users } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'novaspark-v11-secret';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'novaspark-v11-refresh';

/**
 * Generate access + refresh token pair (no expiry)
 */
function generateTokens(user) {
  const payload = { id: user.id, username: user.username, role: user.role };
  const accessToken = jwt.sign(payload, JWT_SECRET);
  const refreshToken = jwt.sign({ id: user.id }, JWT_REFRESH_SECRET);
  return { accessToken, refreshToken };
}

/**
 * Verify access token and attach user to req
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.query.token || null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = Users.findById(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.is_banned) return res.status(403).json({ error: 'Account suspended', reason: user.ban_reason });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Require admin role
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Optional auth — sets req.user if valid token present, but doesn't block
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = Users.findById(decoded.id);
    } catch (_) { /* ignore */ }
  }
  next();
}

module.exports = { generateTokens, authenticate, requireAdmin, optionalAuth, JWT_SECRET, JWT_REFRESH_SECRET };
