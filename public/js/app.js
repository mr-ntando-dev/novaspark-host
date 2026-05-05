'use strict';

// ─── STATE ───────────────────────────────────────────────────────────────────
let token = localStorage.getItem('ns_token') || null;
let refreshToken = localStorage.getItem('ns_refresh') || null;
let currentUser = null;
let ws = null;

const API = '';

// ─── AUTH ────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });

  if (res.status === 401) {
    const data = await res.json();

    // Auth endpoints (login/signup) should just throw — never auto-logout
    if (path.startsWith('/api/auth/login') || path.startsWith('/api/auth/signup')) {
      throw new Error(data.error || 'Invalid credentials');
    }

    // Try to refresh expired token once
    if (data.code === 'TOKEN_EXPIRED' && refreshToken) {
      const r = await fetch(`${API}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
      if (r.ok) {
        const t = await r.json();
        setTokens(t.accessToken, t.refreshToken);
        return api(path, opts);
      }
    }

    // Token is truly invalid/expired and refresh failed — show auth modal
    // but do NOT hard-logout from background requests (notif badge, etc.)
    if (currentUser) {
      token = null; refreshToken = null; currentUser = null;
      localStorage.removeItem('ns_token');
      localStorage.removeItem('ns_refresh');
      if (ws) { ws.close(); ws = null; }
      showAuth();
      toast('Session expired. Please log in again.', 'error');
    }
    throw new Error(data.error || 'Unauthorized');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setTokens(access, refresh) { token = access; refreshToken = refresh; localStorage.setItem('ns_token', access); localStorage.setItem('ns_refresh', refresh); }

async function handleLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const totp_code = document.getElementById('login-totp').value || undefined;
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { username, password, totp_code } });
    if (data.requires_2fa) { document.getElementById('totp-field').classList.remove('hidden'); return; }
    setTokens(data.accessToken, data.refreshToken);
    currentUser = data.user;
    hideAuth();
    updateUserCard();
    if (currentUser.role === 'admin') document.getElementById('admin-nav').classList.remove('hidden');
    navigate('dashboard');
    connectWS();
    loadNotifBadge();
    toast('Welcome back, ' + currentUser.username, 'success');
  } catch (err) { showError('auth-error', err.message); }
}

async function handleSignup(e) {
  if (e && e.preventDefault) e.preventDefault();
  const body = { username: document.getElementById('signup-username').value, password: document.getElementById('signup-password').value, email: document.getElementById('signup-email').value || undefined, referral_code: document.getElementById('signup-referral').value || undefined };
  try {
    const data = await api('/api/auth/signup', { method: 'POST', body });
    setTokens(data.accessToken, data.refreshToken);
    currentUser = data.user;
    hideAuth();
    updateUserCard();
    if (currentUser.role === 'admin') document.getElementById('admin-nav').classList.remove('hidden');
    navigate('dashboard');
    connectWS();
    loadNotifBadge();
    toast('Account created! Welcome to NovaSpark', 'success');
  } catch (err) { showError('signup-error', err.message); }
}

function logout() { token = null; refreshToken = null; currentUser = null; localStorage.removeItem('ns_token'); localStorage.removeItem('ns_refresh'); if (ws) ws.close(); showAuth(); }
function showAuth() { document.getElementById('auth-modal').classList.remove('hidden'); }
function hideAuth() { document.getElementById('auth-modal').classList.add('hidden'); }
function showSignup() { document.getElementById('login-form').classList.add('hidden'); document.getElementById('signup-form').classList.remove('hidden'); document.getElementById('signup-toggle').classList.remove('hidden'); document.getElementById('login-toggle').classList.add('hidden'); }
function showLogin() { document.getElementById('login-form').classList.remove('hidden'); document.getElementById('signup-form').classList.add('hidden'); document.getElementById('signup-toggle').classList.add('hidden'); document.getElementById('login-toggle').classList.remove('hidden'); }
function showError(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 5000); }

// ─── WEBSOCKET ───────────────────────────────────────────────────────────────
function connectWS() {
  if (!currentUser) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', userId: currentUser.id }));
  ws.onmessage = (e) => { try { const d = JSON.parse(e.data); handleWSMessage(d); } catch(_){} };
  ws.onclose = () => setTimeout(connectWS, 5000);
}

function handleWSMessage(data) {
  if (data.type === 'system_stats') updateLiveStats(data.data);
  if (data.type === 'notification') { loadNotifBadge(); toast(data.title || 'New notification', 'info'); }
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
function navigate(page) {
  document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
  const link = document.querySelector(`[data-page="${page}"]`);
  if (link) link.classList.add('active');
  const content = document.getElementById('page-content');
  content.classList.remove('fade-in');
  void content.offsetWidth;
  content.classList.add('fade-in');
  switch(page) {
    case 'dashboard': renderDashboard(); break;
    case 'bots': renderBots(); break;
    case 'deploy': renderDeploy(); break;
    case 'economy': renderEconomy(); break;
    case 'leaderboard': renderLeaderboard(); break;
    case 'notifications': renderNotifications(); break;
    case 'profile': renderProfile(); break;
    case 'settings': renderSettings(); break;
    case 'admin-users': renderAdminUsers(); break;
    case 'admin-system': renderAdminSystem(); break;
    case 'admin-codes': renderAdminCodes(); break;
    case 'admin-install-bot': renderAdminInstallBot(); break;
    default: renderDashboard();
  }
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
async function renderDashboard() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6">
    <div class="flex items-center justify-between"><h2 class="text-2xl font-bold text-white">Dashboard</h2><span class="text-sm text-gray-400" id="dash-time"></span></div>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" id="stat-cards">
      <div class="glass rounded-xl p-5"><p class="text-gray-400 text-sm">My Bots</p><p class="text-3xl font-bold text-white mt-1" id="s-bots">—</p></div>
      <div class="glass rounded-xl p-5"><p class="text-gray-400 text-sm">Coins</p><p class="text-3xl font-bold text-brand-400 mt-1" id="s-coins">—</p></div>
      <div class="glass rounded-xl p-5"><p class="text-gray-400 text-sm">Plan</p><p class="text-3xl font-bold text-purple-400 mt-1 capitalize" id="s-plan">—</p></div>
      <div class="glass rounded-xl p-5"><p class="text-gray-400 text-sm">Login Streak</p><p class="text-3xl font-bold text-green-400 mt-1" id="s-streak">—</p></div>
    </div>
    <div class="glass rounded-xl p-6"><h3 class="text-lg font-semibold text-white mb-4">My Bots</h3><div id="dash-bots" class="space-y-3"><p class="text-gray-400">Loading...</p></div></div>
    <div class="glass rounded-xl p-6"><h3 class="text-lg font-semibold text-white mb-4">Quick Actions</h3>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <button onclick="navigate('deploy')" class="bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/20 rounded-lg p-4 text-center transition"><i class="ri-rocket-2-line text-2xl text-brand-400"></i><p class="text-sm text-gray-300 mt-2">Deploy Bot</p></button>
        <button onclick="claimDaily()" class="bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 rounded-lg p-4 text-center transition"><i class="ri-gift-line text-2xl text-green-400"></i><p class="text-sm text-gray-300 mt-2">Daily Reward</p></button>
        <button onclick="navigate('economy')" class="bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 rounded-lg p-4 text-center transition"><i class="ri-coin-line text-2xl text-purple-400"></i><p class="text-sm text-gray-300 mt-2">Economy</p></button>
        <button onclick="navigate('leaderboard')" class="bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/20 rounded-lg p-4 text-center transition"><i class="ri-trophy-line text-2xl text-yellow-400"></i><p class="text-sm text-gray-300 mt-2">Leaderboard</p></button>
      </div>
    </div>
  </div>`;
  document.getElementById('dash-time').textContent = new Date().toLocaleString();
  try {
    const [botsData, balData] = await Promise.all([api('/api/bots'), api('/api/economy/balance')]);
    document.getElementById('s-bots').textContent = botsData.count;
    document.getElementById('s-coins').textContent = balData.coins;
    document.getElementById('s-plan').textContent = balData.plan;
    document.getElementById('s-streak').textContent = currentUser.login_streak || 0;
    const botsEl = document.getElementById('dash-bots');
    if (botsData.bots.length === 0) { botsEl.innerHTML = '<p class="text-gray-500">No bots yet. Deploy your first bot!</p>'; return; }
    botsEl.innerHTML = botsData.bots.map(b => `<div class="flex items-center justify-between bg-white/5 rounded-lg px-4 py-3">
      <div class="flex items-center gap-3"><div class="status-dot status-${b.status}"></div><span class="font-medium text-white">${b.name}</span><span class="text-xs text-gray-500">${b.status}</span></div>
      <div class="flex gap-2">${b.status==='running'?`<button onclick="botAction('${b.id}','stop')" class="text-xs bg-red-500/20 text-red-400 px-3 py-1 rounded hover:bg-red-500/30 transition">Stop</button>`:`<button onclick="botAction('${b.id}','start')" class="text-xs bg-green-500/20 text-green-400 px-3 py-1 rounded hover:bg-green-500/30 transition">Start</button>`}</div>
    </div>`).join('');
  } catch(e) { console.error(e); }
}

// ─── BOTS ────────────────────────────────────────────────────────────────────
async function renderBots() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6"><div class="flex items-center justify-between"><h2 class="text-2xl font-bold text-white">My Bots</h2><button onclick="navigate('deploy')" class="bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 rounded-lg text-sm transition"><i class="ri-add-line"></i> New Bot</button></div><div id="bots-list" class="space-y-4"><p class="text-gray-400">Loading...</p></div></div>`;
  try {
    const data = await api('/api/bots');
    const list = document.getElementById('bots-list');
    if (data.bots.length === 0) { list.innerHTML = '<div class="glass rounded-xl p-12 text-center"><i class="ri-robot-2-line text-5xl text-gray-600 mb-4"></i><p class="text-gray-400">No bots yet</p><button onclick="navigate(\'deploy\')" class="mt-4 bg-brand-500 text-white px-6 py-2 rounded-lg">Deploy Your First Bot</button></div>'; return; }
    list.innerHTML = data.bots.map(b => `<div class="glass rounded-xl p-5">
      <div class="flex items-center justify-between mb-3"><div class="flex items-center gap-3"><div class="status-dot status-${b.status}"></div><h3 class="font-semibold text-white">${b.name}</h3></div><span class="text-xs px-2 py-1 rounded bg-white/5 text-gray-400">${b.server_tier}</span></div>
      <p class="text-sm text-gray-400 mb-4">${b.description||'No description'}</p>
      <div class="flex items-center justify-between"><div class="flex gap-2 text-xs text-gray-500"><span><i class="ri-time-line"></i> ${b.status==='running'?formatUptime(b.uptime_seconds):'Offline'}</span><span><i class="ri-restart-line"></i> ${b.total_restarts||0} restarts</span></div>
      <div class="flex gap-2">${b.status==='running'?`<button onclick="botAction('${b.id}','restart')" class="text-xs bg-yellow-500/20 text-yellow-400 px-3 py-1.5 rounded hover:bg-yellow-500/30 transition">Restart</button><button onclick="botAction('${b.id}','stop')" class="text-xs bg-red-500/20 text-red-400 px-3 py-1.5 rounded hover:bg-red-500/30 transition">Stop</button>`:`<button onclick="botAction('${b.id}','start')" class="text-xs bg-green-500/20 text-green-400 px-3 py-1.5 rounded hover:bg-green-500/30 transition">Start</button>`}
      <button onclick="viewLogs('${b.id}')" class="text-xs bg-white/5 text-gray-300 px-3 py-1.5 rounded hover:bg-white/10 transition">Logs</button>
      <button onclick="deleteBot('${b.id}')" class="text-xs bg-red-500/10 text-red-400 px-3 py-1.5 rounded hover:bg-red-500/20 transition"><i class="ri-delete-bin-line"></i></button></div></div>
    </div>`).join('');
  } catch(e) { toast(e.message, 'error'); }
}

async function botAction(id, action) {
  try { await api(`/api/bots/${id}/${action}`, { method: 'POST' }); toast(`Bot ${action}ed`, 'success'); setTimeout(() => navigate('bots'), 500); } catch(e) { toast(e.message, 'error'); }
}

async function deleteBot(id) { if (!confirm('Delete this bot? This cannot be undone.')) return; try { await api(`/api/bots/${id}`, { method: 'DELETE' }); toast('Bot deleted', 'success'); renderBots(); } catch(e) { toast(e.message, 'error'); } }

async function viewLogs(id) {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-4"><div class="flex items-center gap-3"><button onclick="navigate('bots')" class="text-gray-400 hover:text-white"><i class="ri-arrow-left-line text-xl"></i></button><h2 class="text-2xl font-bold text-white">Bot Logs</h2></div><div id="log-container" class="glass rounded-xl p-4 h-96 overflow-y-auto font-mono text-xs space-y-1"><p class="text-gray-500">Loading...</p></div><button onclick="clearLogs('${id}')" class="text-sm text-red-400 hover:text-red-300">Clear Logs</button></div>`;
  try { const data = await api(`/api/bots/${id}/logs`); const c = document.getElementById('log-container'); c.innerHTML = data.logs.reverse().map(l => `<div class="log-${l.level}"><span class="text-gray-600">${l.timestamp}</span> [${l.level.toUpperCase()}] ${escapeHtml(l.message)}</div>`).join(''); c.scrollTop = c.scrollHeight; } catch(e) { toast(e.message,'error'); }
}

async function clearLogs(id) { try { await api(`/api/bots/${id}/logs`, { method: 'DELETE' }); toast('Logs cleared','success'); viewLogs(id); } catch(e) { toast(e.message,'error'); } }

// ─── DEPLOY ──────────────────────────────────────────────────────────────────
function renderDeploy() {
  document.getElementById('page-content').innerHTML = `<div class="space-y-6"><h2 class="text-2xl font-bold text-white">Deploy a Bot</h2>
    <form onsubmit="handleDeploy(event)" class="glass rounded-xl p-6 space-y-5 max-w-xl">
      <div><label class="text-sm text-gray-400 block mb-1">Bot Name *</label><input type="text" id="d-name" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" placeholder="My Awesome Bot" required></div>
      <div><label class="text-sm text-gray-400 block mb-1">Description</label><input type="text" id="d-desc" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" placeholder="What does your bot do?"></div>
      <div><label class="text-sm text-gray-400 block mb-1">GitHub Repo URL *</label><input type="url" id="d-repo" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" placeholder="https://github.com/user/repo" required></div>
      <div class="grid grid-cols-2 gap-4">
        <div><label class="text-sm text-gray-400 block mb-1">Branch</label><input type="text" id="d-branch" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="main"></div>
        <div><label class="text-sm text-gray-400 block mb-1">Entry Point</label><input type="text" id="d-entry" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="index.js"></div>
      </div>
      <button type="submit" class="w-full bg-gradient-to-r from-brand-500 to-purple-500 text-white py-3 rounded-lg font-medium hover:opacity-90 transition"><i class="ri-rocket-2-line"></i> Deploy Bot</button>
    </form></div>`;
}

async function handleDeploy(e) {
  if (e && e.preventDefault) e.preventDefault();
  const body = { name: document.getElementById('d-name').value, description: document.getElementById('d-desc').value, repo_url: document.getElementById('d-repo').value, branch: document.getElementById('d-branch').value, entry_point: document.getElementById('d-entry').value };
  try { const data = await api('/api/bots', { method: 'POST', body }); await api(`/api/bots/${data.bot.id}/deploy`, { method: 'POST' }); toast('Bot deployed!', 'success'); navigate('bots'); } catch(e) { toast(e.message, 'error'); }
}

// ─── ECONOMY ─────────────────────────────────────────────────────────────────
async function renderEconomy() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6"><h2 class="text-2xl font-bold text-white">Economy</h2><div class="grid grid-cols-1 md:grid-cols-3 gap-4" id="eco-stats"></div>
    <div class="glass rounded-xl p-6"><h3 class="font-semibold text-white mb-3">Redeem Code</h3><form onsubmit="redeemCode(event)" class="flex gap-3"><input type="text" id="redeem-input" class="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none font-mono" placeholder="NS-XXXXXXXX"><button type="submit" class="bg-brand-500 text-white px-6 py-2 rounded-lg hover:bg-brand-600 transition">Redeem</button></form></div>
    <div class="glass rounded-xl p-6"><h3 class="font-semibold text-white mb-3">Referral</h3><div id="referral-info"></div></div>
    <div class="glass rounded-xl p-6"><h3 class="font-semibold text-white mb-3">Transaction History</h3><div id="transactions" class="space-y-2 max-h-64 overflow-y-auto"></div></div></div>`;
  try {
    const [bal, ref, txns] = await Promise.all([api('/api/economy/balance'), api('/api/economy/referral'), api('/api/economy/transactions')]);
    document.getElementById('eco-stats').innerHTML = `
      <div class="glass rounded-xl p-5 text-center"><p class="text-gray-400 text-sm">Balance</p><p class="text-3xl font-bold text-brand-400">${bal.coins}</p></div>
      <div class="glass rounded-xl p-5 text-center"><p class="text-gray-400 text-sm">Total Earned</p><p class="text-3xl font-bold text-green-400">${bal.total_earned}</p></div>
      <div class="glass rounded-xl p-5 text-center"><p class="text-gray-400 text-sm">Total Spent</p><p class="text-3xl font-bold text-red-400">${bal.total_spent}</p></div>`;
    document.getElementById('referral-info').innerHTML = `<div class="flex items-center gap-3"><input type="text" value="${ref.referral_code}" readonly class="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-brand-400 font-mono"><button onclick="navigator.clipboard.writeText('${ref.referral_code}');toast('Copied!','success')" class="bg-white/5 px-4 py-2 rounded-lg hover:bg-white/10 transition text-sm">Copy</button></div><p class="text-sm text-gray-400 mt-2">${ref.referral_count} referrals • +${ref.coins_per_referral} coins per referral</p>`;
    document.getElementById('transactions').innerHTML = txns.transactions.length ? txns.transactions.map(t => `<div class="flex justify-between text-sm px-3 py-2 rounded bg-white/5"><span class="text-gray-300">${t.description||t.type}</span><span class="${t.amount>0?'text-green-400':'text-red-400'}">${t.amount>0?'+':''}${t.amount}</span></div>`).join('') : '<p class="text-gray-500 text-sm">No transactions yet</p>';
  } catch(e) { toast(e.message,'error'); }
}

async function claimDaily() { try { const d = await api('/api/economy/daily-reward', { method: 'POST' }); toast(`+${d.coins_earned} coins! Streak: ${d.login_streak}`, 'success'); } catch(e) { toast(e.message, 'error'); } }
async function redeemCode(e) { if (e && e.preventDefault) e.preventDefault(); const code = document.getElementById('redeem-input').value; try { const d = await api('/api/economy/redeem', { method: 'POST', body: { code } }); toast(d.message, 'success'); renderEconomy(); } catch(e) { toast(e.message, 'error'); } }

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────
async function renderLeaderboard() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6"><h2 class="text-2xl font-bold text-white">Leaderboard</h2><div id="lb-list" class="glass rounded-xl divide-y divide-white/5"></div></div>`;
  try {
    const data = await api('/api/economy/leaderboard');
    document.getElementById('lb-list').innerHTML = data.leaderboard.map((u, i) => `<div class="flex items-center gap-4 px-5 py-3">
      <span class="text-lg font-bold ${i<3?'text-yellow-400':'text-gray-500'} w-8">#${i+1}</span>
      <span class="text-xl">${u.avatar_emoji||'🤖'}</span>
      <div class="flex-1"><p class="font-medium text-white">${u.username}</p><p class="text-xs text-gray-400">${u.plan} • streak ${u.login_streak}</p></div>
      <span class="text-brand-400 font-bold">${u.coins} coins</span>
    </div>`).join('');
  } catch(e) { toast(e.message,'error'); }
}

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
async function renderNotifications() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6"><div class="flex items-center justify-between"><h2 class="text-2xl font-bold text-white">Notifications</h2><button onclick="markAllRead()" class="text-sm text-brand-400 hover:text-brand-300">Mark all read</button></div><div id="notif-list" class="space-y-3"></div></div>`;
  try {
    const data = await api('/api/notifications');
    document.getElementById('notif-list').innerHTML = data.notifications.length ? data.notifications.map(n => `<div class="glass rounded-lg px-5 py-3 ${n.read?'opacity-60':''}"><div class="flex justify-between"><span class="font-medium text-white">${n.title}</span><span class="text-xs text-gray-500">${timeAgo(n.created_at)}</span></div><p class="text-sm text-gray-400 mt-1">${n.message}</p></div>`).join('') : '<p class="text-gray-500">No notifications</p>';
  } catch(e) { toast(e.message,'error'); }
}

async function markAllRead() { try { await api('/api/notifications/read-all', { method: 'PUT' }); renderNotifications(); loadNotifBadge(); } catch(_){} }

// ─── PROFILE ─────────────────────────────────────────────────────────────────
function renderProfile() {
  const u = currentUser;
  document.getElementById('page-content').innerHTML = `<div class="space-y-6 max-w-xl"><h2 class="text-2xl font-bold text-white">Profile</h2>
    <div class="glass rounded-xl p-6"><div class="flex items-center gap-4 mb-6"><div class="w-16 h-16 rounded-full bg-brand-500/20 flex items-center justify-center text-3xl">${u.avatar_emoji||'🤖'}</div><div><h3 class="text-xl font-bold text-white">${u.username}</h3><p class="text-sm text-gray-400 capitalize">${u.plan} plan</p></div></div>
    <form onsubmit="updateProfile(event)" class="space-y-4">
      <div><label class="text-sm text-gray-400 block mb-1">Bio</label><input type="text" id="p-bio" value="${u.bio||''}" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none" placeholder="Tell us about yourself"></div>
      <div><label class="text-sm text-gray-400 block mb-1">Avatar Emoji</label><input type="text" id="p-emoji" value="${u.avatar_emoji||'🤖'}" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none" maxlength="2"></div>
      <div><label class="text-sm text-gray-400 block mb-1">Banner Color</label><input type="color" id="p-color" value="${u.banner_color||'#6366f1'}" class="w-12 h-10 bg-transparent border-0 cursor-pointer"></div>
      <button type="submit" class="bg-brand-500 text-white px-6 py-2 rounded-lg hover:bg-brand-600 transition">Save</button>
    </form></div></div>`;
}

async function updateProfile(e) { if (e && e.preventDefault) e.preventDefault(); try { const data = await api('/api/auth/me', { method: 'PUT', body: { bio: document.getElementById('p-bio').value, avatar_emoji: document.getElementById('p-emoji').value, banner_color: document.getElementById('p-color').value } }); currentUser = data.user; updateUserCard(); toast('Profile updated','success'); } catch(e) { toast(e.message,'error'); } }

// ─── SETTINGS ────────────────────────────────────────────────────────────────
function renderSettings() {
  document.getElementById('page-content').innerHTML = `<div class="space-y-6 max-w-xl"><h2 class="text-2xl font-bold text-white">Settings</h2>
    <div class="glass rounded-xl p-6"><h3 class="font-semibold text-white mb-4">Change Password</h3><form onsubmit="changePassword(event)" class="space-y-3">
      <input type="password" id="s-curpass" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none" placeholder="Current password" required>
      <input type="password" id="s-newpass" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" placeholder="New password" required minlength="6">
      <button type="submit" class="bg-brand-500 text-white px-6 py-2 rounded-lg">Update Password</button>
    </form></div>
    <div class="glass rounded-xl p-6"><h3 class="font-semibold text-white mb-4">Two-Factor Authentication</h3><p class="text-sm text-gray-400 mb-3">${currentUser.two_fa_enabled?'2FA is enabled ✅':'2FA is not enabled'}</p>${currentUser.two_fa_enabled?'<button onclick="disable2FA()" class="bg-red-500/20 text-red-400 px-4 py-2 rounded-lg text-sm">Disable 2FA</button>':'<button onclick="setup2FA()" class="bg-brand-500 text-white px-4 py-2 rounded-lg text-sm">Enable 2FA</button>'}</div>
    <div class="glass rounded-xl p-6 border border-red-500/20"><h3 class="font-semibold text-red-400 mb-3">Danger Zone</h3><button onclick="logout()" class="bg-red-500/20 text-red-400 px-4 py-2 rounded-lg text-sm hover:bg-red-500/30 transition">Log Out</button></div>
  </div>`;
}

async function changePassword(e) { if (e && e.preventDefault) e.preventDefault(); try { await api('/api/auth/change-password', { method: 'POST', body: { current_password: document.getElementById('s-curpass').value, new_password: document.getElementById('s-newpass').value } }); toast('Password updated','success'); } catch(e) { toast(e.message,'error'); } }

// ─── ADMIN PAGES ─────────────────────────────────────────────────────────────
async function renderAdminUsers() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6"><h2 class="text-2xl font-bold text-white">Admin: Users</h2><div id="admin-users-list" class="glass rounded-xl overflow-hidden"><p class="p-4 text-gray-400">Loading...</p></div></div>`;
  try {
    const data = await api('/api/admin/users');
    document.getElementById('admin-users-list').innerHTML = `<table class="w-full text-sm"><thead class="bg-white/5"><tr><th class="text-left p-3 text-gray-400">User</th><th class="text-left p-3 text-gray-400">Plan</th><th class="text-left p-3 text-gray-400">Coins</th><th class="text-left p-3 text-gray-400">Role</th><th class="p-3"></th></tr></thead><tbody>${data.users.map(u => `<tr class="border-t border-white/5"><td class="p-3 text-white">${u.avatar_emoji||'🤖'} ${u.username}</td><td class="p-3 capitalize text-gray-300">${u.plan}</td><td class="p-3 text-brand-400">${u.coins}</td><td class="p-3"><span class="text-xs px-2 py-1 rounded ${u.role==='admin'?'bg-red-500/20 text-red-400':'bg-white/5 text-gray-400'}">${u.role}</span></td><td class="p-3"><button onclick="adminEditUser('${u.id}')" class="text-xs text-brand-400 hover:text-brand-300">Edit</button></td></tr>`).join('')}</tbody></table>`;
  } catch(e) { toast(e.message,'error'); }
}

async function adminEditUser(userId) {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6"><div class="flex items-center gap-3"><button onclick="navigate('admin-users')" class="text-gray-400 hover:text-white"><i class="ri-arrow-left-line text-xl"></i></button><h2 class="text-2xl font-bold text-white">Edit User</h2></div><div id="admin-edit-form" class="glass rounded-xl p-6"><p class="text-gray-400">Loading...</p></div></div>`;
  try {
    const data = await api(`/api/admin/users`);
    const user = data.users.find(u => u.id === userId);
    if (!user) { toast('User not found','error'); navigate('admin-users'); return; }
    document.getElementById('admin-edit-form').innerHTML = `
      <div class="flex items-center gap-4 mb-6"><div class="w-12 h-12 rounded-full bg-brand-500/20 flex items-center justify-center text-2xl">${user.avatar_emoji||'🤖'}</div><div><h3 class="text-lg font-bold text-white">${user.username}</h3><p class="text-sm text-gray-400">${user.email||'No email'}</p></div></div>
      <form onsubmit="saveAdminUser(event,'${userId}')" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div><label class="text-sm text-gray-400 block mb-1">Role</label><select id="ae-role" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none"><option value="user" ${user.role==='user'?'selected':''}>User</option><option value="admin" ${user.role==='admin'?'selected':''}>Admin</option></select></div>
          <div><label class="text-sm text-gray-400 block mb-1">Plan</label><select id="ae-plan" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none"><option value="free" ${user.plan==='free'?'selected':''}>Free</option><option value="starter" ${user.plan==='starter'?'selected':''}>Starter</option><option value="basic" ${user.plan==='basic'?'selected':''}>Basic</option><option value="pro" ${user.plan==='pro'?'selected':''}>Pro</option><option value="business" ${user.plan==='business'?'selected':''}>Business</option><option value="enterprise" ${user.plan==='enterprise'?'selected':''}>Enterprise</option></select></div>
        </div>
        <div><label class="text-sm text-gray-400 block mb-1">Coins</label><input type="number" id="ae-coins" value="${user.coins||0}" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none"></div>
        <div class="flex items-center gap-3"><input type="checkbox" id="ae-banned" ${user.is_banned?'checked':''}><label for="ae-banned" class="text-sm text-gray-300">Banned</label></div>
        <button type="submit" class="bg-brand-500 hover:bg-brand-600 text-white px-6 py-2 rounded-lg transition">Save Changes</button>
      </form>`;
  } catch(e) { toast(e.message,'error'); }
}

async function saveAdminUser(e, userId) {
  if (e && e.preventDefault) e.preventDefault();
  try {
    await api(`/api/admin/users/${userId}`, { method: 'PUT', body: {
      role: document.getElementById('ae-role').value,
      plan: document.getElementById('ae-plan').value,
      coins: parseInt(document.getElementById('ae-coins').value) || 0,
      is_banned: document.getElementById('ae-banned').checked ? 1 : 0
    }});
    toast('User updated','success');
    navigate('admin-users');
  } catch(e) { toast(e.message,'error'); }
}

async function renderAdminSystem() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6"><h2 class="text-2xl font-bold text-white">Admin: System</h2><div id="sys-stats" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"></div><div class="glass rounded-xl p-6"><h3 class="font-semibold text-white mb-3">Broadcast Notification</h3><form onsubmit="sendBroadcast(event)" class="space-y-3"><input type="text" id="bc-title" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none" placeholder="Title" required><input type="text" id="bc-msg" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none" placeholder="Message" required><button type="submit" class="bg-brand-500 text-white px-6 py-2 rounded-lg">Send to All</button></form></div></div>`;
  try { const data = await api('/api/admin/stats'); document.getElementById('sys-stats').innerHTML = `<div class="glass rounded-xl p-5"><p class="text-gray-400 text-sm">CPU Load</p><p class="text-2xl font-bold text-white">${data.system.cpu_load}%</p></div><div class="glass rounded-xl p-5"><p class="text-gray-400 text-sm">RAM Usage</p><p class="text-2xl font-bold text-white">${data.system.ram_percent}%</p></div><div class="glass rounded-xl p-5"><p class="text-gray-400 text-sm">Total Users</p><p class="text-2xl font-bold text-white">${data.app.total_users}</p></div><div class="glass rounded-xl p-5"><p class="text-gray-400 text-sm">Running Bots</p><p class="text-2xl font-bold text-green-400">${data.app.running_bots}</p></div>`; } catch(e) { toast(e.message,'error'); }
}

async function renderAdminCodes() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6"><h2 class="text-2xl font-bold text-white">Admin: Codes</h2>
    <div class="glass rounded-xl p-6"><h3 class="font-semibold text-white mb-3">Create Code</h3><form onsubmit="createCode(event)" class="grid grid-cols-2 gap-3"><input type="text" id="cc-code" class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none" placeholder="Custom code (optional)"><input type="number" id="cc-value" class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none" placeholder="Coin value" required><input type="number" id="cc-uses" class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none" placeholder="Max uses" value="1"><button type="submit" class="bg-brand-500 text-white px-6 py-2 rounded-lg col-span-2">Create</button></form></div>
    <div class="glass rounded-xl p-6"><h3 class="font-semibold text-white mb-3">Active Codes</h3><div id="codes-list"></div></div></div>`;
  try { const data = await api('/api/admin/codes'); document.getElementById('codes-list').innerHTML = data.codes.length ? data.codes.map(c => `<div class="flex justify-between items-center py-2 border-b border-white/5"><span class="font-mono text-brand-400">${c.code}</span><span class="text-sm text-gray-400">${c.value} coins • ${c.used_count}/${c.max_uses} used</span></div>`).join('') : '<p class="text-gray-500 text-sm">No codes</p>'; } catch(e) { toast(e.message,'error'); }
}

async function createCode(e) { if (e && e.preventDefault) e.preventDefault(); try { await api('/api/admin/codes', { method: 'POST', body: { custom_code: document.getElementById('cc-code').value||undefined, value: parseInt(document.getElementById('cc-value').value), max_uses: parseInt(document.getElementById('cc-uses').value)||1 } }); toast('Code created','success'); renderAdminCodes(); } catch(e) { toast(e.message,'error'); } }
async function sendBroadcast(e) { if (e && e.preventDefault) e.preventDefault(); try { const d = await api('/api/admin/broadcast', { method: 'POST', body: { title: document.getElementById('bc-title').value, message: document.getElementById('bc-msg').value } }); toast(`Sent to ${d.recipients} users`,'success'); } catch(e) { toast(e.message,'error'); } }

// ─── ADMIN: INSTALL BOT ──────────────────────────────────────────────────────
function renderAdminInstallBot() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6"><h2 class="text-2xl font-bold text-white">Admin: Install Bot</h2>
    <div class="glass rounded-xl p-6">
      <div class="flex items-center gap-4 mb-6">
        <div class="w-14 h-14 rounded-xl bg-gradient-to-br from-brand-500 to-purple-500 flex items-center justify-center">
          <i class="ri-robot-2-line text-white text-2xl"></i>
        </div>
        <div>
          <h3 class="text-xl font-bold text-white">NovaSpark Bot</h3>
          <p class="text-sm text-gray-400">WhatsApp MD AutoChat Bot with 130+ commands</p>
        </div>
      </div>
      <p class="text-gray-300 text-sm mb-4">Deploy the official NovaSpark WhatsApp Bot directly from GitHub. Features include AI chat, stickers, TTS, news, trivia, XP system, coin economy, slow mode, anti-media, and much more.</p>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div class="bg-white/5 rounded-lg p-3 text-center"><p class="text-brand-400 font-bold text-lg">130+</p><p class="text-xs text-gray-400">Commands</p></div>
        <div class="bg-white/5 rounded-lg p-3 text-center"><p class="text-green-400 font-bold text-lg">v9.0</p><p class="text-xs text-gray-400">Version</p></div>
        <div class="bg-white/5 rounded-lg p-3 text-center"><p class="text-purple-400 font-bold text-lg">Node 20+</p><p class="text-xs text-gray-400">Runtime</p></div>
        <div class="bg-white/5 rounded-lg p-3 text-center"><p class="text-yellow-400 font-bold text-lg">Baileys</p><p class="text-xs text-gray-400">Engine</p></div>
      </div>
      <div class="border-t border-white/5 pt-4">
        <h4 class="text-sm font-semibold text-white mb-3">Deploy Configuration</h4>
        <form onsubmit="handleInstallNovaSpark(event)" class="space-y-4">
          <div><label class="text-sm text-gray-400 block mb-1">Bot Name</label><input type="text" id="install-name" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="NovaSpark Bot" required></div>
          <div><label class="text-sm text-gray-400 block mb-1">Description</label><input type="text" id="install-desc" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="WhatsApp MD AutoChat Bot - 130+ commands, AI, games, economy"></div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-sm text-gray-400 block mb-1">Branch</label><input type="text" id="install-branch" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="main"></div>
            <div><label class="text-sm text-gray-400 block mb-1">Entry Point</label><input type="text" id="install-entry" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="index.js"></div>
          </div>
          <div class="bg-white/5 rounded-lg p-3 flex items-center gap-3">
            <i class="ri-github-fill text-xl text-gray-300"></i>
            <div class="flex-1">
              <p class="text-sm text-white font-mono">mr-ntando-dev/NovaSpark-Bot</p>
              <p class="text-xs text-gray-400">https://github.com/mr-ntando-dev/NovaSpark-Bot</p>
            </div>
          </div>
          <button type="submit" id="install-btn" class="w-full bg-gradient-to-r from-brand-500 to-purple-500 text-white py-3 rounded-lg font-medium hover:opacity-90 transition flex items-center justify-center gap-2"><i class="ri-install-line"></i> Install & Deploy NovaSpark Bot</button>
        </form>
      </div>
    </div>
    <div class="glass rounded-xl p-6">
      <h3 class="font-semibold text-white mb-3">Features</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm text-gray-300">
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> AI Chat & Smart Detection</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> Sticker Creation (image/video)</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> Text-to-Speech (TTS)</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> News & RSS Feeds</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> Trivia, Wordle, Hangman</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> XP & Level System</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> Coin Economy</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> Night Mode & Anti-Toxic</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> Ghost Mode & VIP Mode</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> TikTok & YouTube Downloads</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> Chess & Akinator Games</div>
        <div class="flex items-center gap-2"><i class="ri-check-line text-green-400"></i> Pin Board & Timetable</div>
      </div>
    </div>
  </div>`;
}

async function handleInstallNovaSpark(e) {
  if (e && e.preventDefault) e.preventDefault();
  const btn = document.getElementById('install-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line animate-spin"></i> Installing...';
  try {
    const body = {
      name: document.getElementById('install-name').value,
      description: document.getElementById('install-desc').value,
      repo_url: 'https://github.com/mr-ntando-dev/NovaSpark-Bot',
      branch: document.getElementById('install-branch').value || 'main',
      entry_point: document.getElementById('install-entry').value || 'index.js'
    };
    const data = await api('/api/bots', { method: 'POST', body });
    await api(`/api/bots/${data.bot.id}/deploy`, { method: 'POST' });
    toast('NovaSpark Bot installed and deployed!', 'success');
    setTimeout(() => navigate('bots'), 1000);
  } catch(err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-install-line"></i> Install & Deploy NovaSpark Bot';
  }
}

// ─── 2FA ─────────────────────────────────────────────────────────────────────
async function setup2FA() {
  try {
    const data = await api('/api/auth/2fa/setup', { method: 'POST' });
    const el = document.getElementById('page-content');
    // Inject QR code + verify form below existing settings content
    const container = document.createElement('div');
    container.id = '2fa-setup-panel';
    container.className = 'glass rounded-xl p-6 space-y-4 mt-4 max-w-xl';
    container.innerHTML = `
      <h3 class="font-semibold text-white">Scan QR Code</h3>
      <img src="${data.qr_code}" alt="2FA QR" class="rounded-lg mx-auto w-48 h-48">
      <p class="text-xs text-gray-400 font-mono break-all">Secret: ${data.secret}</p>
      <form onsubmit="verify2FA(event)" class="flex gap-3">
        <input type="text" id="totp-verify" class="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:border-brand-500 focus:outline-none font-mono" placeholder="Enter 6-digit code" maxlength="6" required>
        <button type="submit" class="bg-brand-500 text-white px-6 py-2 rounded-lg hover:bg-brand-600 transition">Verify &amp; Enable</button>
      </form>`;
    el.appendChild(container);
  } catch (e) { toast(e.message, 'error'); }
}

async function verify2FA(e) {
  if (e && e.preventDefault) e.preventDefault();
  const code = document.getElementById('totp-verify').value;
  try {
    await api('/api/auth/2fa/verify', { method: 'POST', body: { code } });
    currentUser.two_fa_enabled = true;
    toast('2FA enabled successfully!', 'success');
    renderSettings();
  } catch (err) { toast(err.message, 'error'); }
}

async function disable2FA() {
  const password = prompt('Enter your password to disable 2FA:');
  if (!password) return;
  try {
    await api('/api/auth/2fa/disable', { method: 'POST', body: { password } });
    currentUser.two_fa_enabled = false;
    toast('2FA disabled', 'success');
    renderSettings();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── UTILS ───────────────────────────────────────────────────────────────────
function toast(msg, type='info') { const c = document.getElementById('toast-container'); const colors = { success:'bg-green-500/90', error:'bg-red-500/90', info:'bg-brand-500/90' }; const t = document.createElement('div'); t.className = `${colors[type]||colors.info} text-white px-5 py-3 rounded-lg shadow-lg text-sm backdrop-blur-sm fade-in`; t.textContent = msg; c.appendChild(t); setTimeout(()=>t.remove(), 4000); }
function formatUptime(s) { if(!s) return '0s'; const h=Math.floor(s/3600), m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; }
function timeAgo(d) { const s=Math.floor((Date.now()-new Date(d))/1000); if(s<60) return 'just now'; if(s<3600) return Math.floor(s/60)+'m ago'; if(s<86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; }
function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('hidden'); document.getElementById('sidebar').classList.toggle('flex'); }
function updateUserCard() { if(!currentUser) return; document.getElementById('user-avatar').textContent=currentUser.avatar_emoji||'🤖'; document.getElementById('user-name').textContent=currentUser.username; document.getElementById('user-plan').textContent=currentUser.plan+' plan'; }
function updateLiveStats(data) { /* update dashboard if visible */ }
async function loadNotifBadge() { try { const d = await api('/api/notifications'); if(d.unread>0) { document.getElementById('notif-badge').textContent=d.unread; document.getElementById('notif-badge').classList.remove('hidden'); } else { document.getElementById('notif-badge').classList.add('hidden'); } } catch(_){} }

// ─── INIT ────────────────────────────────────────────────────────────────────
async function init() {
  if (!token) { showAuth(); return; }
  try {
    const data = await api('/api/auth/me');
    currentUser = data.user;
    hideAuth();
    updateUserCard();
    if (currentUser.role === 'admin') document.getElementById('admin-nav').classList.remove('hidden');
    navigate('dashboard');
    connectWS();
    loadNotifBadge();
  } catch(e) {
    // Clear stale tokens and show auth
    token = null; refreshToken = null;
    localStorage.removeItem('ns_token');
    localStorage.removeItem('ns_refresh');
    showAuth();
  }
}

// Wait for DOM before calling init so auth modal elements exist
document.addEventListener('DOMContentLoaded', () => {
  init();
});
