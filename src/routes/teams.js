'use strict';

/**
 * teams.js — Team Collaboration & Role-Based Access
 * 
 * Allows users to create teams, invite members, assign roles,
 * and share bot access with granular permissions.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { getDb, Users, Bots, Notifications } = require('../database');
const { v4: uuidv4 } = require('uuid');

const router = Router();

// Team roles and their permissions
const TEAM_ROLES = {
  owner: ['*'],
  admin: ['manage_members', 'manage_bots', 'deploy', 'start', 'stop', 'restart', 'view_logs', 'view_env', 'edit_env'],
  developer: ['deploy', 'start', 'stop', 'restart', 'view_logs', 'view_env', 'edit_env'],
  viewer: ['view_logs']
};

// ─── CREATE TEAM ─────────────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const { name, description } = req.body;
  if (!name || name.length < 2) return res.status(400).json({ error: 'Team name required (min 2 chars)' });

  const db = getDb();
  const id = uuidv4();
  const invite_code = generateInviteCode();

  db.prepare(`
    INSERT INTO teams (id, name, description, owner_id, invite_code, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(id, name.slice(0, 50), (description || '').slice(0, 200), req.user.id, invite_code);

  // Add owner as member
  db.prepare(`
    INSERT INTO team_members (id, team_id, user_id, role, joined_at)
    VALUES (?, ?, ?, 'owner', datetime('now'))
  `).run(uuidv4(), id, req.user.id);

  res.status(201).json({
    team: { id, name, description, invite_code, member_count: 1 },
    message: 'Team created'
  });
});

// ─── LIST MY TEAMS ───────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const teams = db.prepare(`
    SELECT t.*, tm.role as my_role,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.user_id = ?
    ORDER BY t.created_at DESC
  `).all(req.user.id);

  res.json({ teams });
});

// ─── GET TEAM DETAILS ────────────────────────────────────────────────────────
router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const membership = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, req.user.id);
  if (!membership && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not a team member' });
  }

  const members = db.prepare(`
    SELECT tm.*, u.username, u.avatar_emoji, u.email
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ?
    ORDER BY tm.joined_at ASC
  `).all(team.id);

  // Get team bots
  const teamBots = db.prepare(`
    SELECT b.* FROM bots b
    JOIN team_bots tb ON tb.bot_id = b.id
    WHERE tb.team_id = ?
  `).all(team.id);

  res.json({ team, members, bots: teamBots, my_role: membership ? membership.role : 'admin' });
});

// ─── INVITE MEMBER ───────────────────────────────────────────────────────────
router.post('/:id/invite', authenticate, (req, res) => {
  const { username, role } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!TEAM_ROLES[role || 'viewer']) return res.status(400).json({ error: 'Invalid role' });

  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  // Check requester has permission
  const requesterMembership = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, req.user.id);
  if (!requesterMembership || !['owner', 'admin'].includes(requesterMembership.role)) {
    return res.status(403).json({ error: 'Only owners/admins can invite members' });
  }

  // Find user
  const targetUser = Users.findByUsername(username);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  // Check not already member
  const existing = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, targetUser.id);
  if (existing) return res.status(409).json({ error: 'User already in team' });

  // Add member
  db.prepare(`
    INSERT INTO team_members (id, team_id, user_id, role, joined_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(uuidv4(), team.id, targetUser.id, role || 'viewer');

  // Notify the invited user
  Notifications.create(targetUser.id, 'team_invite', `You've been invited to team "${team.name}" as ${role || 'viewer'}`);

  res.json({ message: `${username} added to team as ${role || 'viewer'}` });
});

// ─── JOIN VIA INVITE CODE ────────────────────────────────────────────────────
router.post('/join/:code', authenticate, (req, res) => {
  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE invite_code = ?').get(req.params.code);
  if (!team) return res.status(404).json({ error: 'Invalid invite code' });

  const existing = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, req.user.id);
  if (existing) return res.status(409).json({ error: 'Already a member' });

  db.prepare(`
    INSERT INTO team_members (id, team_id, user_id, role, joined_at)
    VALUES (?, ?, ?, 'viewer', datetime('now'))
  `).run(uuidv4(), team.id, req.user.id);

  res.json({ team: { id: team.id, name: team.name }, message: 'Joined team' });
});

// ─── REMOVE MEMBER ───────────────────────────────────────────────────────────
router.delete('/:id/members/:userId', authenticate, (req, res) => {
  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const requesterMembership = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, req.user.id);
  if (!requesterMembership || !['owner', 'admin'].includes(requesterMembership.role)) {
    return res.status(403).json({ error: 'Only owners/admins can remove members' });
  }

  if (req.params.userId === team.owner_id) {
    return res.status(400).json({ error: 'Cannot remove team owner' });
  }

  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, req.params.userId);
  res.json({ message: 'Member removed' });
});

// ─── SHARE BOT WITH TEAM ────────────────────────────────────────────────────
router.post('/:id/bots', authenticate, (req, res) => {
  const { bot_id } = req.body;
  if (!bot_id) return res.status(400).json({ error: 'bot_id required' });

  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const bot = Bots.findById(bot_id);
  if (!bot || bot.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only share your own bots' });
  }

  const existing = db.prepare('SELECT * FROM team_bots WHERE team_id = ? AND bot_id = ?').get(team.id, bot_id);
  if (existing) return res.status(409).json({ error: 'Bot already shared with team' });

  db.prepare(`
    INSERT INTO team_bots (id, team_id, bot_id, shared_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(uuidv4(), team.id, bot_id);

  res.json({ message: `Bot "${bot.name}" shared with team "${team.name}"` });
});

// ─── DELETE TEAM ─────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the team owner can delete it' });
  }

  db.prepare('DELETE FROM team_bots WHERE team_id = ?').run(team.id);
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(team.id);
  db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);

  res.json({ message: 'Team deleted' });
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

module.exports = router;
