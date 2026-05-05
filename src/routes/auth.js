'use strict';

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { Users, AuditLog, Notifications } = require('../database');
const { generateTokens, authenticate, JWT_REFRESH_SECRET } = require('../middleware/auth');
const { authLimiter, checkBruteForce, recordFailedLogin, clearLoginAttempts } = require('../middleware/security');
const { Alerts } = require('../utils/discord-alerts');

const router = Router();

// ─── SIGNUP ──────────────────────────────────────────────────────────────────
router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { username, password, email, referral_code } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    }

    // Check existing
    if (Users.findByUsername(username)) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Hash password
    const hashed = await bcrypt.hash(password, 12);

    // Handle referral
    let referredBy = null;
    if (referral_code) {
      const referrer = Users.findByReferralCode(referral_code);
      if (referrer) {
        referredBy = referrer.id;
        Users.addCoins(referrer.id, 5, `Referral: ${username} signed up`);
        Users.update(referrer.id, { referral_count: referrer.referral_count + 1 });
        Notifications.create(referrer.id, 'reward', 'Referral Bonus!', `${username} used your referral code. +5 coins!`);
      }
    }

    const user = Users.create({
      username,
      email: email || null,
      password: hashed,
      referred_by: referredBy,
      coins: 10 // Welcome bonus
    });

    const tokens = generateTokens(user);
    AuditLog.record(user.id, 'signup', null, { username, referral_code });
    Alerts.userSignup(username);

    res.status(201).json({
      message: 'Account created',
      user: sanitizeUser(user),
      ...tokens
    });
  } catch (e) {
    console.error('[Auth] Signup error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── LOGIN ───────────────────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password, totp_code } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Brute force check
    const bruteCheck = checkBruteForce(username.toLowerCase());
    if (bruteCheck.locked) {
      return res.status(429).json({ error: `Account locked. Try again in ${bruteCheck.remaining} minutes.` });
    }

    const user = Users.findByUsername(username);
    if (!user) {
      recordFailedLogin(username.toLowerCase());
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      recordFailedLogin(username.toLowerCase());
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 2FA check
    if (user.two_fa_enabled) {
      if (!totp_code) {
        return res.status(200).json({ requires_2fa: true, message: 'Enter your 2FA code' });
      }
      const isValid = authenticator.verify({ token: totp_code, secret: user.two_fa_secret });
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }

    if (user.is_banned) {
      return res.status(403).json({ error: 'Account suspended', reason: user.ban_reason });
    }

    clearLoginAttempts(username.toLowerCase());

    // Update login streak
    const today = new Date().toISOString().slice(0, 10);
    const lastLogin = user.last_login ? user.last_login.slice(0, 10) : null;
    let streak = user.login_streak || 0;
    if (lastLogin) {
      const diff = (new Date(today) - new Date(lastLogin)) / (1000 * 60 * 60 * 24);
      streak = diff === 1 ? streak + 1 : (diff > 1 ? 1 : streak);
    } else {
      streak = 1;
    }

    Users.update(user.id, { last_login: new Date().toISOString(), login_streak: streak });

    const tokens = generateTokens(user);
    AuditLog.record(user.id, 'login', null, { ip: req.ip });

    res.json({
      message: 'Login successful',
      user: sanitizeUser(user),
      login_streak: streak,
      ...tokens
    });
  } catch (e) {
    console.error('[Auth] Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── REFRESH TOKEN ───────────────────────────────────────────────────────────
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const user = Users.findById(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.is_banned) return res.status(403).json({ error: 'Account suspended' });

    const tokens = generateTokens(user);
    res.json(tokens);
  } catch (e) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ─── ME (current user) ──────────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

// ─── UPDATE PROFILE ──────────────────────────────────────────────────────────
router.put('/me', authenticate, async (req, res) => {
  const { bio, avatar_emoji, banner_color, social_links, email } = req.body;
  const updates = {};
  if (bio !== undefined) updates.bio = bio.slice(0, 200);
  if (avatar_emoji !== undefined) updates.avatar_emoji = avatar_emoji;
  if (banner_color !== undefined) updates.banner_color = banner_color;
  if (social_links !== undefined) updates.social_links = JSON.stringify(social_links);
  if (email !== undefined) updates.email = email;

  const user = Users.update(req.user.id, updates);
  res.json({ user: sanitizeUser(user) });
});

// ─── CHANGE PASSWORD ─────────────────────────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Both passwords required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const valid = await bcrypt.compare(current_password, req.user.password);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const hashed = await bcrypt.hash(new_password, 12);
  Users.update(req.user.id, { password: hashed });
  AuditLog.record(req.user.id, 'password_change');

  res.json({ message: 'Password updated' });
});

// ─── 2FA SETUP ───────────────────────────────────────────────────────────────
router.post('/2fa/setup', authenticate, async (req, res) => {
  if (req.user.two_fa_enabled) {
    return res.status(400).json({ error: '2FA already enabled' });
  }

  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(req.user.username, 'NovaSpark', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);

  // Store secret temporarily (not enabled yet)
  Users.update(req.user.id, { two_fa_secret: secret });

  res.json({ secret, qr_code: qrDataUrl, message: 'Scan QR code, then verify with /2fa/verify' });
});

router.post('/2fa/verify', authenticate, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const user = Users.findById(req.user.id);
  if (!user.two_fa_secret) return res.status(400).json({ error: 'Setup 2FA first' });

  const isValid = authenticator.verify({ token: code, secret: user.two_fa_secret });
  if (!isValid) return res.status(401).json({ error: 'Invalid code' });

  Users.update(req.user.id, { two_fa_enabled: 1 });
  AuditLog.record(req.user.id, '2fa_enabled');

  res.json({ message: '2FA enabled successfully' });
});

router.post('/2fa/disable', authenticate, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required to disable 2FA' });

  const valid = await bcrypt.compare(password, req.user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid password' });

  Users.update(req.user.id, { two_fa_enabled: 0, two_fa_secret: null });
  AuditLog.record(req.user.id, '2fa_disabled');

  res.json({ message: '2FA disabled' });
});

// ─── HELPER ──────────────────────────────────────────────────────────────────
function sanitizeUser(user) {
  if (!user) return null;
  const { password, two_fa_secret, ...safe } = user;
  return safe;
}

module.exports = router;
