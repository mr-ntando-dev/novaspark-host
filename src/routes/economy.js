'use strict';

const { Router } = require('express');
const { Users, Transactions, RedemptionCodes, Notifications } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = Router();

// ─── PLAN DEFINITIONS ────────────────────────────────────────────────────────
const PLANS = {
  free:       { name: 'Free',       price: 0,  maxBots: 1,   coins_monthly: 0 },
  starter:    { name: 'Starter',    price: 2,  maxBots: 2,   coins_monthly: 20 },
  basic:      { name: 'Basic',      price: 5,  maxBots: 3,   coins_monthly: 50 },
  pro:        { name: 'Pro',        price: 10, maxBots: 10,  coins_monthly: 150 },
  business:   { name: 'Business',   price: 25, maxBots: 25,  coins_monthly: 400 },
  enterprise: { name: 'Enterprise', price: 50, maxBots: 9999, coins_monthly: 1000 }
};

const COIN_DAILY_REWARD = parseInt(process.env.COIN_DAILY_REWARD) || 3;
const COIN_REFERRAL_REWARD = parseInt(process.env.COIN_REFERRAL_REWARD) || 5;
const COIN_LOGIN_STREAK_BONUS = 2;

// ─── GET PLANS ───────────────────────────────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json({ plans: PLANS });
});

// ─── MY BALANCE & TRANSACTIONS ───────────────────────────────────────────────
router.get('/balance', authenticate, (req, res) => {
  const user = Users.findById(req.user.id);
  res.json({
    coins: user.coins,
    total_earned: user.total_earned,
    total_spent: user.total_spent,
    plan: user.plan,
    plan_expires_at: user.plan_expires_at
  });
});

router.get('/transactions', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const transactions = Transactions.getByUser(req.user.id, limit);
  res.json({ transactions });
});

// ─── DAILY REWARD ────────────────────────────────────────────────────────────
router.post('/daily-reward', authenticate, (req, res) => {
  const user = Users.findById(req.user.id);
  const today = new Date().toISOString().slice(0, 10);

  if (user.last_daily_reward === today) {
    return res.status(400).json({ error: 'Already claimed today', next_claim: 'Tomorrow' });
  }

  let bonus = COIN_DAILY_REWARD;
  // Streak bonus: every 7 days consecutive, double reward
  if (user.login_streak > 0 && user.login_streak % 7 === 0) {
    bonus += COIN_LOGIN_STREAK_BONUS * 2;
  } else if (user.login_streak >= 3) {
    bonus += COIN_LOGIN_STREAK_BONUS;
  }

  Users.addCoins(user.id, bonus, `Daily reward (streak: ${user.login_streak})`);
  Users.update(user.id, { last_daily_reward: today });

  res.json({
    message: 'Daily reward claimed!',
    coins_earned: bonus,
    new_balance: Users.findById(user.id).coins,
    login_streak: user.login_streak
  });
});

// ─── REDEEM CODE ─────────────────────────────────────────────────────────────
router.post('/redeem', authenticate, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const result = RedemptionCodes.use(code, req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });

  // Apply reward
  if (result.type === 'coins') {
    Users.addCoins(req.user.id, result.value, `Redeemed code: ${code}`);
  } else if (result.type === 'plan') {
    // value = days to extend
    const currentExpiry = req.user.plan_expires_at ? new Date(req.user.plan_expires_at) : new Date();
    const newExpiry = new Date(currentExpiry.getTime() + result.value * 24 * 60 * 60 * 1000);
    Users.update(req.user.id, { plan_expires_at: newExpiry.toISOString() });
  }

  Notifications.create(req.user.id, 'reward', 'Code Redeemed!', `Code "${code}" applied. +${result.value} ${result.type}`);

  const user = Users.findById(req.user.id);
  res.json({
    message: 'Code redeemed successfully!',
    type: result.type,
    value: result.value,
    new_balance: user.coins
  });
});

// ─── REFERRAL INFO ───────────────────────────────────────────────────────────
router.get('/referral', authenticate, (req, res) => {
  const user = Users.findById(req.user.id);
  res.json({
    referral_code: user.referral_code,
    referral_count: user.referral_count,
    coins_per_referral: COIN_REFERRAL_REWARD
  });
});

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────
router.get('/leaderboard', (req, res) => {
  const { getDb } = require('../database');
  const db = getDb();
  const top = db.prepare(`
    SELECT username, avatar_emoji, coins, referral_count, login_streak, plan
    FROM users WHERE is_banned = 0
    ORDER BY coins DESC LIMIT 20
  `).all();

  res.json({ leaderboard: top });
});

module.exports = router;
module.exports.PLANS = PLANS;
