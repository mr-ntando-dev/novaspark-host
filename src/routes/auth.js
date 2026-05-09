'use strict';

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { Users, AuditLog, Notifications, getDb } = require('../database');
const { generateTokens, authenticate } = require('../middleware/auth');
const { authLimiter, checkBruteForce, recordFailedLogin, clearLoginAttempts } = require('../middleware/security');
const { Alerts } = require('../utils/discord-alerts');

const router = Router();

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const PLATFORM_DOMAIN = process.env.APP_URL || process.env.RENDER_URL || 'http://localhost:3000';

// ─── DB MIGRATION: add email verification columns ────────────────────────────
function ensureVerificationColumns() {
  try {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    if (!cols.includes('email_verified'))
      db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes('verification_token'))
      db.exec("ALTER TABLE users ADD COLUMN verification_token TEXT DEFAULT NULL");
    if (!cols.includes('verification_token_expires'))
      db.exec("ALTER TABLE users ADD COLUMN verification_token_expires TEXT DEFAULT NULL");
  } catch (e) {
    console.error('[Auth] Migration error:', e.message);
  }
}
ensureVerificationColumns();

// ─── SEND VERIFICATION EMAIL ─────────────────────────────────────────────────
async function sendVerificationEmail(email, username, token) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const verifyUrl = `${PLATFORM_DOMAIN}/api/auth/verify-email?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Spaceify <onboarding@resend.dev>',
      to: [email],
      subject: 'Verify your Spaceify account',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f0f1a;color:#e2e8f0;border-radius:12px">
          <h2 style="color:#a78bfa;margin-top:0">Welcome to Spaceify, ${username}!</h2>
          <p>Thanks for signing up. Click the button below to verify your email address and activate your account.</p>
          <a href="${verifyUrl}" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">Verify Email</a>
          <p style="color:#94a3b8;font-size:13px">This link expires in 24 hours. If you did not sign up, ignore this email.</p>
          <hr style="border-color:#1e1e3a;margin:24px 0"/>
          <p style="color:#64748b;font-size:12px">Spaceify &mdash; nvs-host.spcfy.eu</p>
        </div>
      `,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to send verification email');
  return data;
}

// ─── SIGNUP ──────────────────────────────────────────────────────────────────
router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { username, password, email, referral_code } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required' });
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

    const db = getDb();
    const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingEmail) {
      return res.status(409).json({ error: 'That email is already registered' });
    }

    const hashed = await bcrypt.hash(password, 12);

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

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const user = Users.create({
      username,
      email,
      password: hashed,
      referred_by: referredBy,
      coins: 10
    });

    db.prepare('UPDATE users SET email_verified = 0, verification_token = ?, verification_token_expires = ? WHERE id = ?')
      .run(token, expires, user.id);

    try {
      await sendVerificationEmail(email, username, token);
    } catch (emailErr) {
      console.error('[Auth] Failed to send verification email:', emailErr.message);
    }

    AuditLog.record(user.id, 'signup', null, { username, referral_code });
    Alerts.userSignup(username);

    res.status(201).json({
      message: 'Account created! Please check your email to verify your account before logging in.',
      email_sent: true,
    });
  } catch (e) {
    console.error('[Auth] Signup error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── VERIFY EMAIL ─────────────────────────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Missing token.');

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE verification_token = ?').get(token);

    if (!user) {
      return res.status(400).send('Invalid or already used verification link.');
    }
    if (new Date(user.verification_token_expires) < new Date()) {
      return res.status(400).send('Verification link has expired. Please sign up again or contact support.');
    }

    db.prepare('UPDATE users SET email_verified = 1, verification_token = NULL, verification_token_expires = NULL WHERE id = ?')
      .run(user.id);

    AuditLog.record(user.id, 'email_verified', null, {});

    return res.redirect('/?verified=1');
  } catch (e) {
    console.error('[Auth] Verify error:', e);
    res.status(500).send('Verification failed. Please try again.');
  }
});

// ─── RESEND VERIFICATION EMAIL ────────────────────────────────────────────────
router.post('/resend-verification', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(404).json({ error: 'No account found with that email' });
    if (user.email_verified) return res.status(400).json({ error: 'Email is already verified' });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    db.prepare('UPDATE users SET verification_token = ?, verification_token_expires = ? WHERE id = ?')
      .run(token, expires, user.id);

    await sendVerificationEmail(email, user.username, token);
    res.json({ message: 'Verification email resent. Please check your inbox.' });
  } catch (e) {
    console.error('[Auth] Resend verification error:', e);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// ─── LOGIN ───────────────────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password, totp_code } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    await checkBruteForce(req, res, async () => {
      const user = Users.findByUsername(username);
      if (!user) {
        await recordFailedLogin(req, username);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        await recordFailedLogin(req, username);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Block login if email not verified
      if (!user.email_verified) {
        return res.status(403).json({
          error: 'Please verify your email before logging in. Check your inbox or request a new verification email.',
          email_unverified: true,
        });
      }

      if (user.is_banned) {
        return res.status(403).json({ error: `Account banned: ${user.ban_reason || 'Contact support'}` });
      }

      if (user.two_fa_enabled) {
        if (!totp_code) {
          return res.status(200).json({ requires_2fa: true, message: '2FA code required' });
        }
        const validTotp = authenticator.verify({ token: totp_code, secret: user.two_fa_secret });
        if (!validTotp) {
          return res.status(401).json({ error: 'Invalid 2FA code' });
        }
      }

      clearLoginAttempts(req);
      Users.update(user.id, { last_login: new Date().toISOString() });
      AuditLog.record(user.id, 'login', null, { ip: req.ip });

      const tokens = generateTokens(user);
      res.json({ message: 'Login successful', user: sanitizeUser(user), ...tokens });
    });
  } catch (e) {
    console.error('[Auth] Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token required' });

    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    const user = Users.findById(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const tokens = generateTokens(user);
    res.json(tokens);
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// ─── GET CURRENT USER ─────────────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

// ─── UPDATE PROFILE ───────────────────────────────────────────────────────────
router.patch('/profile', authenticate, async (req, res) => {
  try {
    const { bio, avatar_emoji, banner_color, social_links } = req.body;
    const updates = {};
    if (bio !== undefined) updates.bio = bio;
    if (avatar_emoji !== undefined) updates.avatar_emoji = avatar_emoji;
    if (banner_color !== undefined) updates.banner_color = banner_color;
    if (social_links !== undefined) updates.social_links = JSON.stringify(social_links);

    Users.update(req.user.id, updates);
    res.json({ message: 'Profile updated', user: sanitizeUser(Users.findById(req.user.id)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Both current and new password required' });
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 2FA SETUP ───────────────────────────────────────────────────────────────
router.post('/2fa/setup', authenticate, async (req, res) => {
  if (req.user.two_fa_enabled) {
    return res.status(400).json({ error: '2FA already enabled' });
  }

  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(req.user.username, 'NovaSpark', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);

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
  const { password, two_fa_secret, verification_token, verification_token_expires, ...safe } = user;
  return safe;
}

module.exports = router;
