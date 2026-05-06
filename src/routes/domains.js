'use strict';

/**
 * domains.js — Custom Domain Mapping for Bot Webhooks
 * 
 * Allows users to map custom domains/subdomains to their bots
 * for webhook callbacks, health endpoints, and web panels.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { Bots, getDb } = require('../database');
const { v4: uuidv4 } = require('uuid');

const router = Router();

// ─── ADD CUSTOM DOMAIN ───────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const { bot_id, domain, ssl_enabled } = req.body;

  if (!bot_id || !domain) return res.status(400).json({ error: 'bot_id and domain required' });

  // Validate domain format
  const domainRegex = /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;
  if (!domainRegex.test(domain)) return res.status(400).json({ error: 'Invalid domain format' });

  const bot = Bots.findById(bot_id);
  if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Bot not found or access denied' });
  }

  const db = getDb();

  // Check domain not already taken
  const existing = db.prepare('SELECT * FROM custom_domains WHERE domain = ?').get(domain);
  if (existing) return res.status(409).json({ error: 'Domain already in use' });

  const id = uuidv4();
  const verification_token = `novaspark-verify-${uuidv4().slice(0, 12)}`;

  db.prepare(`
    INSERT INTO custom_domains (id, bot_id, owner_id, domain, ssl_enabled, verified, verification_token, status, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, 'pending_verification', datetime('now'))
  `).run(id, bot_id, req.user.id, domain.toLowerCase(), ssl_enabled !== false ? 1 : 0, verification_token);

  res.status(201).json({
    domain: {
      id,
      domain: domain.toLowerCase(),
      verified: false,
      status: 'pending_verification',
      verification_token,
      ssl_enabled: ssl_enabled !== false
    },
    instructions: {
      step1: `Add a TXT record to your DNS: _novaspark-verify.${domain}`,
      step2: `Set the value to: ${verification_token}`,
      step3: `Add a CNAME record pointing ${domain} to your NovaSpark instance URL`,
      step4: 'Call the verify endpoint once DNS propagates (usually 5-30 minutes)'
    },
    message: 'Domain added. Complete DNS verification to activate.'
  });
});

// ─── LIST MY DOMAINS ─────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const domains = db.prepare(`
    SELECT d.*, b.name as bot_name 
    FROM custom_domains d
    LEFT JOIN bots b ON b.id = d.bot_id
    WHERE d.owner_id = ?
    ORDER BY d.created_at DESC
  `).all(req.user.id);

  res.json({ domains });
});

// ─── VERIFY DOMAIN ───────────────────────────────────────────────────────────
router.post('/:id/verify', authenticate, async (req, res) => {
  const db = getDb();
  const domain = db.prepare('SELECT * FROM custom_domains WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  if (domain.verified) return res.json({ message: 'Domain already verified', verified: true });

  // In production, we'd do a DNS TXT lookup here.
  // For now, mark as verified if user confirms (or auto-verify in dev)
  const { force } = req.body;
  if (force || process.env.NODE_ENV !== 'production') {
    db.prepare(`UPDATE custom_domains SET verified = 1, status = 'active' WHERE id = ?`).run(domain.id);
    return res.json({ message: 'Domain verified and active', verified: true });
  }

  // DNS verification would go here with a real DNS lookup
  try {
    const dns = require('dns').promises;
    const records = await dns.resolveTxt(`_novaspark-verify.${domain.domain}`);
    const flat = records.flat();
    if (flat.includes(domain.verification_token)) {
      db.prepare(`UPDATE custom_domains SET verified = 1, status = 'active' WHERE id = ?`).run(domain.id);
      return res.json({ message: 'Domain verified successfully', verified: true });
    } else {
      return res.status(400).json({ error: 'Verification token not found in DNS TXT records. Please wait for DNS propagation.' });
    }
  } catch (e) {
    return res.status(400).json({ error: `DNS lookup failed: ${e.message}. Ensure the TXT record is set correctly.` });
  }
});

// ─── DELETE DOMAIN ───────────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const domain = db.prepare('SELECT * FROM custom_domains WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  db.prepare('DELETE FROM custom_domains WHERE id = ?').run(domain.id);
  res.json({ message: 'Domain removed' });
});

module.exports = router;
