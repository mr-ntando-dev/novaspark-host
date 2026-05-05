'use strict';

/**
 * discord-alerts.js — Send webhook notifications to Discord
 */

const fetch = require('node-fetch');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

async function sendAlert({ title, description, color = 0x6366f1, fields = [], footer = '' }) {
  if (!WEBHOOK_URL) return;

  const embed = {
    title,
    description,
    color,
    fields: fields.map(f => ({ name: f.name, value: String(f.value).slice(0, 1024), inline: f.inline !== false })),
    timestamp: new Date().toISOString()
  };
  if (footer) embed.footer = { text: footer };

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });
  } catch (e) {
    console.error('[Discord] Alert failed:', e.message);
  }
}

// Pre-built alert types
const Alerts = {
  botCrashed(botName, ownerId, reason) {
    return sendAlert({
      title: '🔴 Bot Crashed',
      description: `**${botName}** went down.`,
      color: 0xef4444,
      fields: [
        { name: 'Owner', value: ownerId },
        { name: 'Reason', value: reason || 'Unknown' }
      ]
    });
  },

  botStarted(botName, ownerId) {
    return sendAlert({
      title: '🟢 Bot Started',
      description: `**${botName}** is now running.`,
      color: 0x22c55e,
      fields: [{ name: 'Owner', value: ownerId }]
    });
  },

  userSignup(username) {
    return sendAlert({
      title: '👤 New User',
      description: `**${username}** just signed up.`,
      color: 0x3b82f6
    });
  },

  planExpiring(username, plan, daysLeft) {
    return sendAlert({
      title: '⚠️ Plan Expiring',
      description: `**${username}**'s ${plan} plan expires in ${daysLeft} day(s).`,
      color: 0xf59e0b
    });
  },

  systemAlert(message) {
    return sendAlert({
      title: '🛠️ System Alert',
      description: message,
      color: 0x8b5cf6
    });
  }
};

module.exports = { sendAlert, Alerts };
