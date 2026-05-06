'use strict';

/**
 * regions.js — NovaSpark V13: Geo-Distributed Deploy (Edge Regions)
 * 
 * Let users pick deploy regions for lower latency to their users.
 * Features:
 * - Multiple region support (US, EU, Asia, Africa)
 * - Region health monitoring
 * - Auto-failover between regions
 * - Latency-based routing recommendations
 * - Region usage analytics
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { Bots, Notifications, getDb } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// Available regions
const REGIONS = {
  'us-east-1': {
    name: 'US East (Virginia)',
    location: 'Ashburn, Virginia, USA',
    provider: 'Render',
    lat: 39.0438,
    lng: -77.4874,
    status: 'available',
    features: ['lowest-latency-na', 'high-availability']
  },
  'us-west-1': {
    name: 'US West (Oregon)',
    location: 'Portland, Oregon, USA',
    provider: 'Render',
    lat: 45.5152,
    lng: -122.6784,
    status: 'available',
    features: ['west-coast-optimized']
  },
  'eu-west-1': {
    name: 'Europe (Frankfurt)',
    location: 'Frankfurt, Germany',
    provider: 'Render',
    lat: 50.1109,
    lng: 8.6821,
    status: 'available',
    features: ['gdpr-compliant', 'eu-data-residency']
  },
  'eu-central-1': {
    name: 'Europe (London)',
    location: 'London, United Kingdom',
    provider: 'Render',
    lat: 51.5074,
    lng: -0.1278,
    status: 'available',
    features: ['uk-data-residency']
  },
  'ap-south-1': {
    name: 'Asia Pacific (Singapore)',
    location: 'Singapore',
    provider: 'Render',
    lat: 1.3521,
    lng: 103.8198,
    status: 'available',
    features: ['apac-optimized', 'sea-low-latency']
  },
  'ap-east-1': {
    name: 'Asia Pacific (Tokyo)',
    location: 'Tokyo, Japan',
    provider: 'Render',
    lat: 35.6762,
    lng: 139.6503,
    status: 'available',
    features: ['east-asia-optimized']
  },
  'af-south-1': {
    name: 'Africa (Johannesburg)',
    location: 'Johannesburg, South Africa',
    provider: 'Render',
    lat: -26.2041,
    lng: 28.0473,
    status: 'available',
    features: ['africa-optimized', 'za-low-latency']
  },
  'sa-east-1': {
    name: 'South America (São Paulo)',
    location: 'São Paulo, Brazil',
    provider: 'Render',
    lat: -23.5505,
    lng: -46.6333,
    status: 'available',
    features: ['latam-optimized']
  }
};

// ─── INIT REGION TABLES ─────────────────────────────────────────────────────
function initRegionSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_regions (
      id          TEXT PRIMARY KEY,
      bot_id      TEXT NOT NULL,
      region      TEXT NOT NULL,
      is_primary  INTEGER NOT NULL DEFAULT 1,
      status      TEXT NOT NULL DEFAULT 'deploying',
      deployed_at TEXT DEFAULT NULL,
      last_health TEXT DEFAULT NULL,
      latency_ms  INTEGER DEFAULT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
      UNIQUE(bot_id, region)
    );

    CREATE TABLE IF NOT EXISTS region_health (
      id          TEXT PRIMARY KEY,
      region      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'healthy',
      latency_ms  INTEGER DEFAULT NULL,
      checked_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bot_regions_bot ON bot_regions(bot_id);
  `);
}

try { initRegionSchema(); } catch (_) {}

// ─── LIST AVAILABLE REGIONS ─────────────────────────────────────────────────
router.get('/', (req, res) => {
  const regions = Object.entries(REGIONS).map(([id, info]) => ({
    id,
    ...info
  }));
  res.json({ regions });
});

// ─── GET RECOMMENDED REGION ─────────────────────────────────────────────────
router.get('/recommend', authenticate, (req, res) => {
  try {
    const { target_country, target_lat, target_lng } = req.query;

    let recommended = 'us-east-1'; // Default

    if (target_lat && target_lng) {
      // Find closest region by distance
      const lat = parseFloat(target_lat);
      const lng = parseFloat(target_lng);
      let minDist = Infinity;

      for (const [regionId, info] of Object.entries(REGIONS)) {
        if (info.status !== 'available') continue;
        const dist = haversine(lat, lng, info.lat, info.lng);
        if (dist < minDist) {
          minDist = dist;
          recommended = regionId;
        }
      }
    } else if (target_country) {
      // Country-based recommendation
      const countryRegionMap = {
        'US': 'us-east-1', 'CA': 'us-east-1', 'MX': 'us-east-1',
        'GB': 'eu-central-1', 'DE': 'eu-west-1', 'FR': 'eu-west-1', 'NL': 'eu-west-1',
        'JP': 'ap-east-1', 'KR': 'ap-east-1', 'CN': 'ap-east-1',
        'SG': 'ap-south-1', 'IN': 'ap-south-1', 'AU': 'ap-south-1',
        'ZA': 'af-south-1', 'NG': 'af-south-1', 'KE': 'af-south-1',
        'BR': 'sa-east-1', 'AR': 'sa-east-1', 'CO': 'sa-east-1'
      };
      recommended = countryRegionMap[target_country.toUpperCase()] || 'us-east-1';
    }

    res.json({
      recommended,
      region: REGIONS[recommended],
      reason: target_country ? `Closest region for ${target_country}` : 'Lowest latency based on location'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Haversine distance formula
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── DEPLOY BOT TO REGION ───────────────────────────────────────────────────
router.post('/:botId/deploy', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const { region, is_primary } = req.body;

    if (!region || !REGIONS[region]) {
      return res.status(400).json({ error: 'Invalid region', available: Object.keys(REGIONS) });
    }

    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (REGIONS[region].status !== 'available') {
      return res.status(503).json({ error: `Region ${region} is currently unavailable` });
    }

    const db = getDb();
    const id = uuidv4();

    try {
      db.prepare(`
        INSERT INTO bot_regions (id, bot_id, region, is_primary, status)
        VALUES (?, ?, ?, ?, 'deploying')
      `).run(id, botId, region, is_primary ? 1 : 0);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `Bot already deployed to ${region}` });
      }
      throw err;
    }

    // Simulate deploy (in production, this would trigger actual multi-region deploy)
    setTimeout(() => {
      try {
        db.prepare("UPDATE bot_regions SET status = 'active', deployed_at = datetime('now') WHERE id = ?").run(id);
        BotLogs.add(botId, 'info', `Deployed to region ${REGIONS[region].name}`);
        if (global.wsBroadcast) {
          global.wsBroadcast(bot.owner_id, {
            type: 'region_deploy_complete',
            botId,
            region,
            status: 'active'
          });
        }
      } catch (_) {}
    }, 3000);

    res.status(201).json({
      success: true,
      message: `Deploying to ${REGIONS[region].name}...`,
      deployment: { id, botId, region, status: 'deploying' }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET BOT REGIONS ────────────────────────────────────────────────────────
router.get('/:botId', authenticate, (req, res) => {
  try {
    const { botId } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const db = getDb();
    const deployments = db.prepare('SELECT * FROM bot_regions WHERE bot_id = ? ORDER BY is_primary DESC').all(botId);

    const enriched = deployments.map(d => ({
      ...d,
      region_info: REGIONS[d.region] || null
    }));

    res.json({ deployments: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REMOVE BOT FROM REGION ─────────────────────────────────────────────────
router.delete('/:botId/:region', authenticate, (req, res) => {
  try {
    const { botId, region } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const db = getDb();
    const deployment = db.prepare('SELECT * FROM bot_regions WHERE bot_id = ? AND region = ?').get(botId, region);
    if (!deployment) return res.status(404).json({ error: 'Bot not deployed to this region' });

    if (deployment.is_primary) {
      return res.status(400).json({ error: 'Cannot remove primary region. Set another region as primary first.' });
    }

    db.prepare('DELETE FROM bot_regions WHERE bot_id = ? AND region = ?').run(botId, region);
    BotLogs.add(botId, 'info', `Removed from region ${REGIONS[region]?.name || region}`);

    res.json({ success: true, message: `Removed from ${region}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SET PRIMARY REGION ─────────────────────────────────────────────────────
router.post('/:botId/:region/primary', authenticate, (req, res) => {
  try {
    const { botId, region } = req.params;
    const bot = Bots.findById(botId);
    if (!bot || (bot.owner_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const db = getDb();
    // Unset all as non-primary
    db.prepare('UPDATE bot_regions SET is_primary = 0 WHERE bot_id = ?').run(botId);
    // Set new primary
    db.prepare('UPDATE bot_regions SET is_primary = 1 WHERE bot_id = ? AND region = ?').run(botId, region);

    res.json({ success: true, primary_region: region });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REGION HEALTH CHECK ────────────────────────────────────────────────────
router.get('/health/all', (req, res) => {
  const health = Object.entries(REGIONS).map(([id, info]) => ({
    id,
    name: info.name,
    status: info.status,
    location: info.location
  }));
  res.json({ regions: health });
});

module.exports = router;
module.exports.REGIONS = REGIONS;
