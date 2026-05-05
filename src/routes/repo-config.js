'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const fetch = require('node-fetch');

const router = Router();

/**
 * POST /api/repo-config
 * Fetches config files from a GitHub repo to auto-fill deploy form.
 * Reads: package.json, .env.example, config.json, bot-config.json, novaspark.config.json
 */
router.post('/', authenticate, async (req, res) => {
  const { repo_url, branch } = req.body;
  if (!repo_url) return res.status(400).json({ error: 'repo_url required' });

  // Parse GitHub URL
  const match = repo_url.match(/github\.com\/([^\/]+)\/([^\/\s#?]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid GitHub URL' });

  const owner = match[1];
  const repo = match[2].replace(/\.git$/, '');
  const ref = branch || 'main';

  const results = {
    entry_point: null,
    env_keys: [],
    bot_name: null,
    description: null,
    node_version: null,
    has_package_json: false,
    config: null,
    start_script: null
  };

  try {
    // 1. Fetch package.json
    const pkgData = await fetchGitHubFile(owner, repo, ref, 'package.json');
    if (pkgData) {
      results.has_package_json = true;
      const pkg = JSON.parse(pkgData);
      results.bot_name = pkg.name || null;
      results.description = pkg.description || null;
      results.node_version = pkg.engines?.node || null;

      // Detect entry point from main or scripts.start
      if (pkg.main) {
        results.entry_point = pkg.main;
      }
      if (pkg.scripts?.start) {
        const startScript = pkg.scripts.start;
        results.start_script = startScript;
        // Extract file from "node index.js" or "node src/bot.js" etc.
        const nodeMatch = startScript.match(/node\s+(.+\.js)/);
        if (nodeMatch) {
          results.entry_point = nodeMatch[1].trim();
        }
      }
    }

    // 2. Fetch .env.example
    const envExample = await fetchGitHubFile(owner, repo, ref, '.env.example');
    if (envExample) {
      const keys = parseEnvExample(envExample);
      results.env_keys = keys;
    }

    // 3. Fetch config.json or bot-config.json or novaspark.config.json
    const configFiles = ['novaspark.config.json', 'bot-config.json', 'config.json'];
    for (const file of configFiles) {
      const configData = await fetchGitHubFile(owner, repo, ref, file);
      if (configData) {
        try {
          results.config = JSON.parse(configData);
          results.config._source_file = file;
        } catch (_) {}
        break;
      }
    }

    // If config has env or environment keys, merge them
    if (results.config) {
      if (results.config.env && typeof results.config.env === 'object') {
        const configEnvKeys = Object.entries(results.config.env).map(([key, val]) => ({
          key,
          value: typeof val === 'string' ? val : '',
          description: typeof val === 'object' ? val.description || '' : '',
          required: typeof val === 'object' ? val.required !== false : true
        }));
        // Merge without duplicates
        const existingKeys = new Set(results.env_keys.map(e => e.key));
        for (const ek of configEnvKeys) {
          if (!existingKeys.has(ek.key)) {
            results.env_keys.push(ek);
          }
        }
      }
      // Override entry_point if specified in config
      if (results.config.entry_point) {
        results.entry_point = results.config.entry_point;
      }
      if (results.config.name) {
        results.bot_name = results.config.name;
      }
      if (results.config.description) {
        results.description = results.config.description;
      }
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: `Failed to fetch repo config: ${e.message}` });
  }
});

/**
 * Fetch a single file from GitHub raw content
 */
async function fetchGitHubFile(owner, repo, ref, filepath) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filepath}`;
  try {
    const resp = await fetch(url, { timeout: 8000 });
    if (!resp.ok) return null;
    return await resp.text();
  } catch (_) {
    return null;
  }
}

/**
 * Parse .env.example into structured key list
 */
function parseEnvExample(content) {
  const keys = [];
  const lines = content.split('\n');
  let lastComment = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { lastComment = ''; continue; }
    if (trimmed.startsWith('#')) {
      lastComment = trimmed.replace(/^#+\s*/, '');
      continue;
    }
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2].replace(/^["']|["']$/g, '');
      // Don't include placeholder values
      const isPlaceholder = /^(your[-_]|change[-_]me|xxx|placeholder|put[-_]|enter[-_])/i.test(value);
      keys.push({
        key,
        value: isPlaceholder ? '' : value,
        description: lastComment || '',
        required: !trimmed.includes('optional') && !lastComment.toLowerCase().includes('optional')
      });
      lastComment = '';
    }
  }
  return keys;
}

module.exports = router;
