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
  ws.onerror = (e) => console.warn('WS connection error', e);
  ws.onclose = (e) => { console.warn('WS closed (code:', e.code, ')'); setTimeout(connectWS, 5000); };
}

function handleWSMessage(data) {
  if (data.type === 'system_stats') updateLiveStats(data.data);
  if (data.type === 'notification') { loadNotifBadge(); toast(data.title || 'New notification', 'info'); }

  // Real-time bot status updates — refresh bot cards if visible
  if (data.type === 'bot_status') {
    const dot = document.querySelector(`.status-dot[data-bot-id="${data.botId}"]`);
    if (dot) {
      dot.className = `status-dot status-${data.status}`;
    }
    // Re-render bots/dashboard if currently showing
    const activePage = document.querySelector('.sidebar-link.active');
    if (activePage) {
      const page = activePage.getAttribute('data-page');
      if (page === 'bots' || page === 'dashboard') {
        // Debounce re-render
        clearTimeout(window._botStatusRefreshTimer);
        window._botStatusRefreshTimer = setTimeout(() => {
          if (page === 'bots') renderBots();
          else renderDashboard();
        }, 800);
      }
    }
  }

  // Real-time log streaming — append to open log view
  if (data.type === 'bot_log') {
    const logContainer = document.getElementById('log-container');
    const activeLogBotId = logContainer && logContainer.getAttribute('data-bot-id');
    if (logContainer && activeLogBotId === data.botId) {
      const div = document.createElement('div');
      div.className = `log-${data.level}`;
      div.innerHTML = `<span class="text-gray-600">${data.timestamp}</span> [${data.level.toUpperCase()}] ${escapeHtml(data.message)}`;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  // QR code from bot — show modal so user can scan
  if (data.type === 'bot_qr') {
    showBotQRModal(data.botId, data.qr);
  }
}

function showBotQRModal(botId, qrDataUrl) {
  // Remove existing QR modal if open
  const existing = document.getElementById('bot-qr-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'bot-qr-modal';
  modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4';
  modal.innerHTML = `
    <div class="glass rounded-2xl p-8 max-w-sm w-full text-center space-y-4 border border-brand-500/30">
      <div class="flex items-center justify-between">
        <h3 class="text-xl font-bold text-white">Scan QR Code</h3>
        <button onclick="document.getElementById('bot-qr-modal').remove()" class="text-gray-400 hover:text-white">
          <i class="ri-close-line text-xl"></i>
        </button>
      </div>
      <p class="text-gray-400 text-sm">Open WhatsApp → Linked Devices → Link a Device, then scan this code.</p>
      <div class="bg-white rounded-xl p-3 inline-block mx-auto">
        <img src="${qrDataUrl}" alt="WhatsApp QR Code" class="w-56 h-56 object-contain">
      </div>
      <p class="text-xs text-yellow-400"><i class="ri-time-line"></i> QR codes expire in ~60 seconds. A new one will appear automatically.</p>
      <button onclick="document.getElementById('bot-qr-modal').remove()" class="w-full bg-brand-500/20 text-brand-400 border border-brand-500/30 rounded-lg py-2 hover:bg-brand-500/30 transition text-sm">Close</button>
    </div>
  `;
  document.body.appendChild(modal);
  toast('WhatsApp QR code ready — scan it now!', 'info');
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
    case 'templates': renderTemplatesPage(); break;
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
      <div class="flex gap-2">${b.status==='running'?`<button onclick="botAction('${b.id}','stop')" class="text-xs bg-red-500/20 text-red-400 px-3 py-1 rounded hover:bg-red-500/30 transition">Stop</button>`:`<button onclick="botAction('${b.id}','start')" class="text-xs bg-green-500/20 text-green-400 px-3 py-1 rounded hover:bg-green-500/30 transition">Start</button>`}<button onclick="manageEnv('${b.id}')" class="text-xs bg-yellow-500/10 text-yellow-400 px-3 py-1 rounded hover:bg-yellow-500/20 transition"><i class="ri-key-2-line"></i></button></div>
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
      <button onclick="manageEnv('${b.id}')" class="text-xs bg-yellow-500/10 text-yellow-400 px-3 py-1.5 rounded hover:bg-yellow-500/20 transition"><i class="ri-key-2-line"></i> Env</button>
      <button onclick="deleteBot('${b.id}')" class="text-xs bg-red-500/10 text-red-400 px-3 py-1.5 rounded hover:bg-red-500/20 transition"><i class="ri-delete-bin-line"></i></button></div></div>
    </div>`).join('');
  } catch(e) { toast(e.message, 'error'); }
}

async function botAction(id, action) {
  try { await api(`/api/bots/${id}/${action}`, { method: 'POST' }); toast(`Bot ${action}ed`, 'success'); setTimeout(() => navigate('bots'), 500); } catch(e) { toast(e.message, 'error'); }
}

async function deleteBot(id) { if (!confirm('Delete this bot? This cannot be undone.')) return; try { await api(`/api/bots/${id}`, { method: 'DELETE' }); toast('Bot deleted', 'success'); renderBots(); } catch(e) { toast(e.message, 'error'); } }

async function manageEnv(botId) {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-6">
    <div class="flex items-center gap-3">
      <button onclick="navigate('bots')" class="text-gray-400 hover:text-white transition"><i class="ri-arrow-left-line text-xl"></i></button>
      <h2 class="text-2xl font-bold text-white">Environment Variables</h2>
    </div>

    <!-- SESSION ID SHORTCUT PANEL -->
    <div class="glass rounded-xl p-6 max-w-2xl border border-green-500/20">
      <div class="flex items-start gap-3 mb-4">
        <span class="text-2xl">📱</span>
        <div>
          <h3 class="font-semibold text-white">WhatsApp Session ID</h3>
          <p class="text-xs text-gray-400 mt-0.5">Skip QR scanning by pasting your session ID. Supports NovaSpark~, LEVANTER~, SUBZERO~ formats and raw base64.</p>
        </div>
      </div>
      <div class="flex gap-2">
        <input id="session-id-input" type="text" placeholder="Paste SESSION_ID here (e.g. NovaSpark~AAAA...)" class="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-xs focus:border-green-500 focus:outline-none">
        <button onclick="applySessionId('${botId}')" class="bg-green-500/20 text-green-400 border border-green-500/30 px-4 py-2 rounded-lg text-sm hover:bg-green-500/30 transition whitespace-nowrap">Apply &amp; Restart</button>
      </div>
      <div class="mt-3 flex items-center gap-3">
        <button onclick="exportSessionId('${botId}')" class="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1"><i class="ri-download-line"></i> Export my current session ID</button>
        <span class="text-gray-600 text-xs">|</span>
        <span class="text-xs text-gray-500">Export after connecting via QR to reuse the session elsewhere</span>
      </div>
    </div>

    <!-- ENV VARS -->
    <div class="glass rounded-xl p-6 max-w-2xl space-y-4">
      <p class="text-sm text-gray-400"><i class="ri-information-line"></i> These variables are injected into your bot's process at startup. Changes take effect on next restart.</p>
      <div id="env-manage-rows" class="space-y-2"><p class="text-gray-500 text-sm">Loading...</p></div>
      <button type="button" onclick="addEnvManageRow()" class="text-sm text-brand-400 hover:text-brand-300 flex items-center gap-1"><i class="ri-add-line"></i> Add Variable</button>
      <div class="pt-2 border-t border-white/5 flex gap-3">
        <button onclick="saveEnv('${botId}')" class="bg-brand-500 hover:bg-brand-600 text-white px-6 py-2 rounded-lg text-sm transition">Save &amp; Restart</button>
        <button onclick="navigate('bots')" class="bg-white/5 hover:bg-white/10 text-gray-300 px-6 py-2 rounded-lg text-sm transition">Cancel</button>
      </div>
    </div>
  </div>`;
  try {
    const data = await api(`/api/bots/${botId}/env`);
    const rows = document.getElementById('env-manage-rows');
    rows.innerHTML = '';
    const entries = Object.entries(data.env_vars || {});
    if (entries.length === 0) {
      rows.innerHTML = '<p class="text-gray-500 text-sm">No variables set yet.</p>';
    } else {
      entries.forEach(([k, v]) => addEnvManageRow(k, v));
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function applySessionId(botId) {
  const input = document.getElementById('session-id-input');
  const sessionId = input ? input.value.trim() : '';
  if (!sessionId) { toast('Paste a session ID first', 'error'); return; }
  try {
    const data = await api(`/api/bots/${botId}/session-id`, { method: 'POST', body: { session_id: sessionId } });
    toast(data.message, 'success');
    if (data.decoded) {
      // Restart bot so it picks up the new session
      await api(`/api/bots/${botId}/restart`, { method: 'POST' }).catch(() => {});
      toast('Bot restarting with new session...', 'info');
      setTimeout(() => navigate('bots'), 1500);
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function exportSessionId(botId) {
  try {
    const data = await api(`/api/bots/${botId}/session-id`);
    // Show copyable modal
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4';
    modal.innerHTML = `
      <div class="glass rounded-2xl p-6 max-w-lg w-full space-y-4 border border-brand-500/30">
        <div class="flex items-center justify-between">
          <h3 class="font-bold text-white">Your Session ID</h3>
          <button onclick="this.closest('.fixed').remove()" class="text-gray-400 hover:text-white"><i class="ri-close-line text-xl"></i></button>
        </div>
        <p class="text-xs text-yellow-400"><i class="ri-alert-line"></i> Keep this secret. Anyone with this string can access your WhatsApp account.</p>
        <textarea readonly class="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-green-400 font-mono text-xs h-28 resize-none focus:outline-none">${escapeHtml(data.session_id)}</textarea>
        <button onclick="navigator.clipboard.writeText(${JSON.stringify(data.session_id)}).then(()=>toast('Copied!','success')); this.closest('.fixed').remove()" class="w-full bg-brand-500/20 text-brand-400 border border-brand-500/30 rounded-lg py-2 hover:bg-brand-500/30 transition text-sm">Copy &amp; Close</button>
      </div>
    `;
    document.body.appendChild(modal);
  } catch(e) { toast(e.message, 'error'); }
}

function addEnvManageRow(key = '', value = '') {
  const container = document.getElementById('env-manage-rows');
  // Remove the "no variables" placeholder if present
  const placeholder = container.querySelector('p');
  if (placeholder) placeholder.remove();
  const row = document.createElement('div');
  row.className = 'env-manage-row flex gap-2 items-center';
  row.innerHTML = `<input type="text" placeholder="KEY" class="env-manage-key w-2/5 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-sm focus:border-brand-500 focus:outline-none" value="${escapeHtml(key)}">
    <input type="text" placeholder="new value (leave blank to keep existing)" class="env-manage-val flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-sm focus:border-brand-500 focus:outline-none" value="">
    <button type="button" onclick="this.closest('.env-manage-row').remove()" class="text-gray-500 hover:text-red-400 transition px-1"><i class="ri-close-line text-lg"></i></button>`;
  container.appendChild(row);
}

async function saveEnv(botId) {
  const env = {};
  document.querySelectorAll('.env-manage-row').forEach(row => {
    const k = row.querySelector('.env-manage-key').value.trim().toUpperCase();
    const v = row.querySelector('.env-manage-val').value;
    if (k) env[k] = v;
  });
  try {
    await api(`/api/bots/${botId}/env`, { method: 'PUT', body: { env_vars: env } });
    // Restart so new vars take effect
    await api(`/api/bots/${botId}/restart`, { method: 'POST' }).catch(() => {});
    toast('Environment variables saved. Bot restarting...', 'success');
    setTimeout(() => navigate('bots'), 1000);
  } catch(e) { toast(e.message, 'error'); }
}

async function viewLogs(id) {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="space-y-4">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <button onclick="navigate('bots')" class="text-gray-400 hover:text-white"><i class="ri-arrow-left-line text-xl"></i></button>
        <h2 class="text-2xl font-bold text-white">Bot Logs</h2>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-green-400 flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-400 inline-block animate-pulse"></span>Live</span>
        <button onclick="clearLogs('${id}')" class="text-sm text-red-400 hover:text-red-300">Clear Logs</button>
      </div>
    </div>
    <div id="log-container" data-bot-id="${id}" class="glass rounded-xl p-4 h-[32rem] overflow-y-auto font-mono text-xs space-y-1">
      <p class="text-gray-500">Loading...</p>
    </div>
  </div>`;
  try {
    const data = await api(`/api/bots/${id}/logs`);
    const c = document.getElementById('log-container');
    if (!c) return;
    c.innerHTML = data.logs.reverse().map(l => `<div class="log-${l.level}"><span class="text-gray-600">${l.timestamp}</span> [${l.level.toUpperCase()}] ${escapeHtml(l.message)}</div>`).join('') || '<p class="text-gray-500">No logs yet.</p>';
    c.scrollTop = c.scrollHeight;
  } catch(e) { toast(e.message,'error'); }
}

async function clearLogs(id) { try { await api(`/api/bots/${id}/logs`, { method: 'DELETE' }); toast('Logs cleared','success'); viewLogs(id); } catch(e) { toast(e.message,'error'); } }

// ─── DEPLOY ──────────────────────────────────────────────────────────────────
let _deployRepoTimeout = null;

function renderDeploy() {
  document.getElementById('page-content').innerHTML = `<div class="space-y-6"><h2 class="text-2xl font-bold text-white">Deploy a Bot</h2>

    <!-- Bot Templates Section -->
    <div class="glass rounded-xl p-6">
      <h3 class="text-lg font-semibold text-white mb-4 flex items-center gap-2"><i class="ri-apps-2-line text-brand-400"></i> Quick Deploy Templates</h3>
      <p class="text-sm text-gray-400 mb-4">Select a pre-configured bot to auto-fill the deploy form, or scroll down to deploy a custom repo.</p>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3" id="bot-templates-grid"></div>
    </div>

    <form id="deploy-form" class="glass rounded-xl p-6 space-y-5 max-w-2xl">
      <div><label class="text-sm text-gray-400 block mb-1">GitHub Repo URL *</label>
        <div class="relative">
          <input type="url" id="d-repo" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none pr-10" placeholder="https://github.com/user/repo" required>
          <div id="repo-scan-indicator" class="hidden absolute right-3 top-1/2 -translate-y-1/2"><i class="ri-loader-4-line animate-spin text-brand-400"></i></div>
        </div>
        <p id="repo-scan-status" class="text-xs text-gray-500 mt-1"><i class="ri-magic-line"></i> Paste a GitHub URL — we'll auto-detect your bot's config.</p>
      </div>
      <div><label class="text-sm text-gray-400 block mb-1">Bot Name *</label><input type="text" id="d-name" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" placeholder="My Awesome Bot" required></div>
      <div><label class="text-sm text-gray-400 block mb-1">Description</label><input type="text" id="d-desc" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" placeholder="What does your bot do?"></div>
      <div class="grid grid-cols-2 gap-4">
        <div><label class="text-sm text-gray-400 block mb-1">Branch</label><input type="text" id="d-branch" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="main"></div>
        <div><label class="text-sm text-gray-400 block mb-1">Entry Point</label><input type="text" id="d-entry" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="index.js"></div>
      </div>

      <!-- WhatsApp Session Credentials (prominent) -->
      <div class="border border-brand-500/30 rounded-xl p-4 bg-brand-500/5">
        <h4 class="text-sm font-semibold text-brand-400 mb-3 flex items-center gap-2"><i class="ri-whatsapp-line"></i> WhatsApp Session Credentials</h4>
        <p class="text-xs text-gray-400 mb-3">Required for WhatsApp bots. Get your Session ID from the bot's pairing process.</p>
        <div class="space-y-3">
          <div><label class="text-sm text-gray-400 block mb-1">Session ID *</label><input type="text" id="d-session-id" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none font-mono text-sm" placeholder="e.g. SUBZERO~abc123 or levanter_xyz"></div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-sm text-gray-400 block mb-1">Owner Number</label><input type="text" id="d-owner-number" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" placeholder="e.g. 263786831091"></div>
            <div><label class="text-sm text-gray-400 block mb-1">Prefix</label><input type="text" id="d-prefix" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" placeholder="." value="."></div>
          </div>
        </div>
      </div>

      <!-- Environment Variables -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <label class="text-sm text-gray-400">Additional Environment Variables</label>
          <button type="button" onclick="addEnvRow()" class="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1"><i class="ri-add-line"></i> Add Variable</button>
        </div>
        <div id="env-rows" class="space-y-2"></div>
        <p class="text-xs text-gray-500 mt-2"><i class="ri-lock-line"></i> Values are encrypted at rest and injected securely at runtime.</p>
      </div>

      <!-- Advanced Settings (collapsible) -->
      <div class="border-t border-white/5 pt-4">
        <button type="button" onclick="toggleAdvancedDeploy()" class="flex items-center gap-2 text-sm text-gray-400 hover:text-brand-400 transition">
          <i id="adv-chevron" class="ri-arrow-right-s-line transition-transform"></i> Advanced Settings
        </button>
        <div id="advanced-deploy" class="hidden mt-4 space-y-4 pl-2 border-l-2 border-brand-500/20">
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-sm text-gray-400 block mb-1">Server Tier</label>
              <select id="d-tier" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none">
                <option value="basic">Basic (512MB RAM)</option>
                <option value="standard">Standard (1GB RAM)</option>
                <option value="performance">Performance (2GB RAM)</option>
              </select>
            </div>
            <div><label class="text-sm text-gray-400 block mb-1">Max RAM (MB)</label><input type="number" id="d-maxram" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="512" min="128" max="4096"></div>
          </div>
          <div class="flex items-center gap-3">
            <input type="checkbox" id="d-autorestart" checked class="w-4 h-4 rounded bg-white/5 border-white/10 text-brand-500 focus:ring-brand-500">
            <label for="d-autorestart" class="text-sm text-gray-300">Auto-restart on crash</label>
          </div>
          <div><label class="text-sm text-gray-400 block mb-1">Install Command (override)</label><input type="text" id="d-install-cmd" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none font-mono text-sm" placeholder="npm install --production (default)"></div>
        </div>
      </div>

      <div id="deploy-error" class="hidden bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm text-red-400"></div>

      <button type="submit" id="deploy-btn" class="w-full bg-gradient-to-r from-brand-500 to-purple-500 text-white py-3 rounded-lg font-medium hover:opacity-90 transition flex items-center justify-center gap-2"><i class="ri-rocket-2-line"></i> Deploy Bot</button>
    </form></div>`;

  // Render bot templates
  renderBotTemplates();

  // Bind form submit
  document.getElementById('deploy-form').addEventListener('submit', handleDeploy);
  // Bind repo URL change for auto-config
  const repoInput = document.getElementById('d-repo');
  repoInput.addEventListener('input', () => {
    clearTimeout(_deployRepoTimeout);
    _deployRepoTimeout = setTimeout(() => scanRepoConfig(), 800);
  });
  repoInput.addEventListener('paste', () => {
    clearTimeout(_deployRepoTimeout);
    _deployRepoTimeout = setTimeout(() => scanRepoConfig(), 500);
  });
}

// ─── BOT TEMPLATES ───────────────────────────────────────────────────────────
const BOT_TEMPLATES = [
  {
    id: 'novaspark',
    name: 'NovaSpark Bot',
    description: 'WhatsApp MD Bot - 130+ commands, AI, games, economy',
    repo: 'https://github.com/mr-ntando-dev/NovaSpark-Bot',
    branch: 'main',
    entry: 'index.js',
    icon: '⚡',
    color: 'from-indigo-500 to-purple-500',
    env_keys: ['SESSION_ID', 'OWNER_NUMBER', 'PREFIX', 'OPENAI_API_KEY'],
    session_key: 'SESSION_ID',
    owner_key: 'OWNER_NUMBER',
    prefix_key: 'PREFIX',
    default_prefix: '.'
  },
  {
    id: 'subzero',
    name: 'Subzero MD',
    description: 'World Best WhatsApp Bot - Made in Zimbabwe by Mr Frank',
    repo: 'https://github.com/subzero-md/SUBZERO-DM',
    branch: 'main',
    entry: 'index.js',
    icon: '🧊',
    color: 'from-cyan-500 to-blue-500',
    env_keys: ['SESSION_ID', 'OWNER_NUMBER', 'PREFIX'],
    session_key: 'SESSION_ID',
    owner_key: 'OWNER_NUMBER',
    prefix_key: 'PREFIX',
    default_prefix: '.',
    config_file: 'settings.js',
    config_format: 'module.exports'
  },
  {
    id: 'levanter',
    name: 'Levanter',
    description: 'Feature-rich WhatsApp bot supporting multiple sessions',
    repo: 'https://github.com/lyfe00011/levanter',
    branch: 'master',
    entry: 'index.js',
    icon: '🌿',
    color: 'from-green-500 to-emerald-500',
    env_keys: ['SESSION_ID', 'VPS', 'AUTO_UPDATE'],
    session_key: 'SESSION_ID',
    owner_key: null,
    prefix_key: null,
    default_prefix: '.'
  },
  {
    id: 'silva-md',
    name: 'Silva MD Bot',
    description: 'Smart WhatsApp bot - motivation, media downloads, polls',
    repo: 'https://github.com/SilvaTechB/silva-md-bot',
    branch: 'main',
    entry: 'silva.js',
    icon: '🦊',
    color: 'from-orange-500 to-red-500',
    env_keys: ['SESSION_ID', 'PREFIX', 'OWNER_NUMBER'],
    session_key: 'SESSION_ID',
    owner_key: 'OWNER_NUMBER',
    prefix_key: 'PREFIX',
    default_prefix: '.'
  },
  {
    id: 'queen-anya',
    name: 'Queen Anya v3',
    description: 'Modular WhatsApp plugins bot powered by Baileys',
    repo: 'https://github.com/PikaBotz/AnyaBotV3',
    branch: 'proto',
    entry: 'index.js',
    icon: '👑',
    color: 'from-pink-500 to-rose-500',
    env_keys: ['SESSION_ID', 'OWNER_NUMBER'],
    session_key: 'SESSION_ID',
    owner_key: 'OWNER_NUMBER',
    prefix_key: null,
    default_prefix: '.'
  },
  {
    id: 'chatunity',
    name: 'ChatUnity Bot',
    description: 'Multilingual WhatsApp bot - ranked among the best globally',
    repo: 'https://github.com/chatunitycenter/chatunity-bot',
    branch: 'main',
    entry: 'main.js',
    icon: '🌍',
    color: 'from-yellow-500 to-amber-500',
    env_keys: ['SESSION_ID', 'OWNER_NUMBER', 'PREFIX'],
    session_key: 'SESSION_ID',
    owner_key: 'OWNER_NUMBER',
    prefix_key: 'PREFIX',
    default_prefix: '.'
  }
];

function renderTemplatesPage() {
  document.getElementById('page-content').innerHTML = `<div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-2xl font-bold text-white">Bot Templates</h2>
        <p class="text-sm text-gray-400 mt-1">Pre-configured WhatsApp bots ready to deploy. Just add your Session ID.</p>
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" id="templates-page-grid"></div>
  </div>`;

  const grid = document.getElementById('templates-page-grid');
  grid.innerHTML = BOT_TEMPLATES.map(t => `
    <div class="glass rounded-xl p-5 hover:border-brand-500/40 border border-white/10 transition-all group">
      <div class="flex items-center gap-3 mb-3">
        <div class="w-12 h-12 rounded-xl bg-gradient-to-br ${t.color} flex items-center justify-center text-2xl shadow-lg">${t.icon}</div>
        <div class="flex-1 min-w-0">
          <h3 class="text-base font-bold text-white truncate">${t.name}</h3>
          <p class="text-xs text-gray-400 font-mono">${t.repo.replace('https://github.com/', '')}</p>
        </div>
      </div>
      <p class="text-sm text-gray-300 mb-3">${t.description}</p>
      <div class="flex flex-wrap gap-1 mb-4">
        <span class="text-[10px] px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-400 border border-brand-500/20">WhatsApp MD</span>
        <span class="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">Baileys</span>
        <span class="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">Node.js</span>
      </div>
      <div class="text-xs text-gray-500 mb-3">
        <span class="font-medium text-gray-400">Required:</span> ${t.env_keys.map(k => '<code class="text-brand-300">' + k + '</code>').join(', ')}
      </div>
      <button onclick="selectBotTemplate('${t.id}'); navigate('deploy');" class="w-full bg-gradient-to-r ${t.color} text-white py-2 rounded-lg text-sm font-medium hover:opacity-90 transition flex items-center justify-center gap-2">
        <i class="ri-rocket-2-line"></i> Deploy ${t.name}
      </button>
    </div>
  `).join('');
}

function renderBotTemplates() {
  const grid = document.getElementById('bot-templates-grid');
  if (!grid) return;
  grid.innerHTML = BOT_TEMPLATES.map(t => `
    <div class="bg-white/5 hover:bg-white/10 border border-white/10 hover:border-brand-500/40 rounded-xl p-4 cursor-pointer transition-all group" onclick="selectBotTemplate('${t.id}')">
      <div class="flex items-center gap-3 mb-2">
        <div class="w-10 h-10 rounded-lg bg-gradient-to-br ${t.color} flex items-center justify-center text-xl shadow-lg">${t.icon}</div>
        <div class="flex-1 min-w-0">
          <h4 class="text-sm font-bold text-white truncate group-hover:text-brand-300 transition">${t.name}</h4>
        </div>
      </div>
      <p class="text-xs text-gray-400 line-clamp-2">${t.description}</p>
      <div class="mt-2 flex items-center gap-1">
        <span class="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-400 border border-brand-500/20">WhatsApp</span>
        <span class="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">Baileys</span>
      </div>
    </div>
  `).join('');
}

let _selectedTemplateId = null;

function selectBotTemplate(templateId) {
  const t = BOT_TEMPLATES.find(b => b.id === templateId);
  if (!t) return;

  _selectedTemplateId = templateId;

  // Auto-fill the deploy form
  document.getElementById('d-repo').value = t.repo;
  document.getElementById('d-name').value = t.name;
  document.getElementById('d-desc').value = t.description;
  document.getElementById('d-branch').value = t.branch;
  document.getElementById('d-entry').value = t.entry;
  document.getElementById('d-prefix').value = t.default_prefix;

  // Clear session fields so user can fill them
  document.getElementById('d-session-id').value = '';
  document.getElementById('d-owner-number').value = '';

  // Clear existing env rows and add template-specific ones (excluding session/owner/prefix which have dedicated fields)
  const container = document.getElementById('env-rows');
  container.innerHTML = '';
  const dedicatedKeys = [t.session_key, t.owner_key, t.prefix_key].filter(Boolean);
  for (const key of t.env_keys) {
    if (!dedicatedKeys.includes(key)) {
      addEnvRow(key, '', '', false);
    }
  }

  // Scroll to session ID field and highlight it
  const sessionField = document.getElementById('d-session-id');
  sessionField.scrollIntoView({ behavior: 'smooth', block: 'center' });
  sessionField.focus();
  sessionField.classList.add('border-brand-500');
  setTimeout(() => sessionField.classList.remove('border-brand-500'), 2000);

  toast(`${t.name} template loaded. Fill in your Session ID to deploy.`, 'success');
}

function toggleAdvancedDeploy() {
  const panel = document.getElementById('advanced-deploy');
  const chevron = document.getElementById('adv-chevron');
  panel.classList.toggle('hidden');
  chevron.style.transform = panel.classList.contains('hidden') ? '' : 'rotate(90deg)';
}

async function scanRepoConfig() {
  const repoUrl = document.getElementById('d-repo').value.trim();
  if (!repoUrl || !repoUrl.includes('github.com/')) return;

  const indicator = document.getElementById('repo-scan-indicator');
  const status = document.getElementById('repo-scan-status');
  indicator.classList.remove('hidden');
  status.innerHTML = '<i class="ri-search-eye-line"></i> Scanning repository for config...';
  status.className = 'text-xs text-brand-400 mt-1';

  try {
    const branch = document.getElementById('d-branch').value || 'main';
    const data = await api('/api/repo-config', { method: 'POST', body: { repo_url: repoUrl, branch } });

    // Auto-fill fields
    if (data.bot_name && !document.getElementById('d-name').value) {
      document.getElementById('d-name').value = data.bot_name;
    }
    if (data.description && !document.getElementById('d-desc').value) {
      document.getElementById('d-desc').value = data.description;
    }
    if (data.entry_point) {
      document.getElementById('d-entry').value = data.entry_point;
    }

    // Auto-fill env vars
    if (data.env_keys && data.env_keys.length > 0) {
      const container = document.getElementById('env-rows');
      container.innerHTML = ''; // Clear existing
      for (const envDef of data.env_keys) {
        addEnvRow(envDef.key, envDef.value || '', envDef.description || '', envDef.required !== false);
      }
    }

    const detected = [];
    if (data.has_package_json) detected.push('package.json');
    if (data.env_keys.length > 0) detected.push(`${data.env_keys.length} env vars`);
    if (data.entry_point) detected.push(data.entry_point);
    if (data.config) detected.push(data.config._source_file);

    status.innerHTML = `<i class="ri-check-line text-green-400"></i> Auto-detected: ${detected.join(', ')}`;
    status.className = 'text-xs text-green-400 mt-1';
  } catch (e) {
    status.innerHTML = `<i class="ri-information-line"></i> Could not auto-detect config. Fill in manually.`;
    status.className = 'text-xs text-yellow-400 mt-1';
  } finally {
    indicator.classList.add('hidden');
  }
}

function addEnvRow(key = '', value = '', description = '', required = true) {
  const container = document.getElementById('env-rows');
  const row = document.createElement('div');
  row.className = 'env-row flex gap-2 items-start';
  const reqBadge = required ? '<span class="text-red-400 text-xs">*</span>' : '';
  const descHtml = description ? `<p class="text-xs text-gray-500 mt-0.5 pl-1">${escapeHtml(description)}</p>` : '';
  row.innerHTML = `<div class="w-2/5">
      <input type="text" placeholder="KEY" class="env-key w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-sm focus:border-brand-500 focus:outline-none uppercase" value="${escapeHtml(key)}">
      ${descHtml}
    </div>
    <div class="flex-1 flex items-center gap-2">
      <input type="text" placeholder="value ${required ? '(required)' : '(optional)'}" class="env-val flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-sm focus:border-brand-500 focus:outline-none" value="${escapeHtml(value)}">
      ${reqBadge}
      <button type="button" onclick="this.closest('.env-row').remove()" class="text-gray-500 hover:text-red-400 transition px-1"><i class="ri-close-line text-lg"></i></button>
    </div>`;
  container.appendChild(row);
}

function collectEnvVars() {
  const env = {};
  document.querySelectorAll('#env-rows .env-row').forEach(row => {
    const k = row.querySelector('.env-key').value.trim().toUpperCase();
    const v = row.querySelector('.env-val').value;
    if (k) env[k] = v;
  });
  return env;
}

async function handleDeploy(e) {
  if (e && e.preventDefault) e.preventDefault();
  const btn = document.getElementById('deploy-btn');
  const errEl = document.getElementById('deploy-error');
  errEl.classList.add('hidden');

  // Validate
  const name = document.getElementById('d-name').value.trim();
  const repoUrl = document.getElementById('d-repo').value.trim();
  if (!name) { showDeployError('Bot name is required.'); return; }
  if (!repoUrl) { showDeployError('GitHub repo URL is required.'); return; }
  if (!repoUrl.includes('github.com/')) { showDeployError('Please enter a valid GitHub URL.'); return; }

  // Disable button
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line animate-spin"></i> Creating bot...';

  // Collect all env vars including session credentials
  const envVars = collectEnvVars();
  const sessionId = document.getElementById('d-session-id').value.trim();
  const ownerNumber = document.getElementById('d-owner-number').value.trim();
  const prefix = document.getElementById('d-prefix').value.trim();

  // Map session/owner/prefix to the correct env var key based on selected template
  const activeTemplate = BOT_TEMPLATES.find(t => t.repo === repoUrl);
  const sessionKey = (activeTemplate && activeTemplate.session_key) || 'SESSION_ID';
  const ownerKey = (activeTemplate && activeTemplate.owner_key) || 'OWNER_NUMBER';
  const prefixKey = (activeTemplate && activeTemplate.prefix_key) || 'PREFIX';

  if (sessionId) envVars[sessionKey] = sessionId;
  if (ownerNumber) envVars[ownerKey] = ownerNumber;
  if (prefix) envVars[prefixKey] = prefix;

  const body = {
    name,
    description: document.getElementById('d-desc').value,
    repo_url: repoUrl,
    branch: document.getElementById('d-branch').value || 'main',
    entry_point: document.getElementById('d-entry').value || 'index.js',
    env_vars: envVars,
    auto_restart: document.getElementById('d-autorestart') ? (document.getElementById('d-autorestart').checked ? 1 : 0) : 1,
    server_tier: document.getElementById('d-tier') ? document.getElementById('d-tier').value : 'basic'
  };

  try {
    // Step 1: Create bot
    const createData = await api('/api/bots', { method: 'POST', body });
    const botId = createData.bot.id;

    // Step 2: Deploy (clone + start)
    btn.innerHTML = '<i class="ri-loader-4-line animate-spin"></i> Cloning & deploying...';
    try {
      await api(`/api/bots/${botId}/deploy`, { method: 'POST' });
      toast('Bot deployed successfully!', 'success');
    } catch (deployErr) {
      // Bot was created but deploy failed — still navigate to bots so user can retry
      toast(`Bot created but deploy had an issue: ${deployErr.message}. You can retry from My Bots.`, 'warning');
    }

    navigate('bots');
  } catch (e) {
    showDeployError(e.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-rocket-2-line"></i> Deploy Bot';
  }
}

function showDeployError(msg) {
  const errEl = document.getElementById('deploy-error');
  if (errEl) {
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  }
  toast(msg, 'error');
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
    <p class="text-gray-400 text-sm">Quick-deploy any supported bot template for a user. Select a bot below, fill in session credentials, and deploy.</p>

    <!-- Bot selector tabs -->
    <div class="flex flex-wrap gap-2 mb-4" id="admin-bot-tabs"></div>

    <!-- Dynamic bot install form -->
    <div id="admin-install-content" class="glass rounded-xl p-6"></div>
  </div>`;

  // Render bot tabs
  const tabsEl = document.getElementById('admin-bot-tabs');
  tabsEl.innerHTML = BOT_TEMPLATES.map((t, i) => `
    <button onclick="selectAdminBotTemplate('${t.id}')" class="admin-bot-tab px-4 py-2 rounded-lg text-sm font-medium transition border ${i === 0 ? 'bg-brand-500/20 border-brand-500/40 text-brand-300' : 'bg-white/5 border-white/10 text-gray-400 hover:text-white hover:border-white/20'}" data-bot="${t.id}">
      ${t.icon} ${t.name}
    </button>
  `).join('');

  // Select first bot by default
  selectAdminBotTemplate(BOT_TEMPLATES[0].id);
}

function selectAdminBotTemplate(templateId) {
  const t = BOT_TEMPLATES.find(b => b.id === templateId);
  if (!t) return;

  // Update active tab styling
  document.querySelectorAll('.admin-bot-tab').forEach(tab => {
    if (tab.dataset.bot === templateId) {
      tab.className = 'admin-bot-tab px-4 py-2 rounded-lg text-sm font-medium transition border bg-brand-500/20 border-brand-500/40 text-brand-300';
    } else {
      tab.className = 'admin-bot-tab px-4 py-2 rounded-lg text-sm font-medium transition border bg-white/5 border-white/10 text-gray-400 hover:text-white hover:border-white/20';
    }
  });

  const content = document.getElementById('admin-install-content');
  content.innerHTML = `
    <div class="flex items-center gap-4 mb-6">
      <div class="w-14 h-14 rounded-xl bg-gradient-to-br ${t.color} flex items-center justify-center text-2xl shadow-lg">${t.icon}</div>
      <div>
        <h3 class="text-xl font-bold text-white">${t.name}</h3>
        <p class="text-sm text-gray-400">${t.description}</p>
      </div>
    </div>
    <div class="bg-white/5 rounded-lg p-3 flex items-center gap-3 mb-4">
      <i class="ri-github-fill text-xl text-gray-300"></i>
      <div class="flex-1">
        <p class="text-sm text-white font-mono">${t.repo.replace('https://github.com/','')}</p>
        <p class="text-xs text-gray-400">${t.repo}</p>
      </div>
    </div>
    <form onsubmit="handleAdminInstallBot(event, '${t.id}')" class="space-y-4">
      <div class="grid grid-cols-2 gap-4">
        <div><label class="text-sm text-gray-400 block mb-1">Bot Name</label><input type="text" id="install-name" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="${t.name}" required></div>
        <div><label class="text-sm text-gray-400 block mb-1">Entry Point</label><input type="text" id="install-entry" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="${t.entry}"></div>
      </div>
      <!-- Session Credentials -->
      <div class="border border-brand-500/30 rounded-xl p-4 bg-brand-500/5">
        <h4 class="text-sm font-semibold text-brand-400 mb-3 flex items-center gap-2"><i class="ri-whatsapp-line"></i> WhatsApp Session Credentials</h4>
        <div class="space-y-3">
          <div><label class="text-sm text-gray-400 block mb-1">Session ID *</label><input type="text" id="install-session-id" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none font-mono text-sm" placeholder="Paste your session ID here" required></div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-sm text-gray-400 block mb-1">Owner Number</label><input type="text" id="install-owner-number" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" placeholder="e.g. 263786831091"></div>
            <div><label class="text-sm text-gray-400 block mb-1">Prefix</label><input type="text" id="install-prefix" class="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:border-brand-500 focus:outline-none" value="${t.default_prefix}"></div>
          </div>
        </div>
      </div>
      <!-- Additional Env Vars -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <label class="text-sm text-gray-400">Additional Environment Variables</label>
          <button type="button" onclick="addInstallEnvRow()" class="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1"><i class="ri-add-line"></i> Add Variable</button>
        </div>
        <div id="install-env-rows" class="space-y-2"></div>
      </div>
      <button type="submit" id="install-btn" class="w-full bg-gradient-to-r ${t.color} text-white py-3 rounded-lg font-medium hover:opacity-90 transition flex items-center justify-center gap-2"><i class="ri-install-line"></i> Install & Deploy ${t.name}</button>
    </form>`;
}

async function handleAdminInstallBot(e, templateId) {
  if (e && e.preventDefault) e.preventDefault();
  const t = BOT_TEMPLATES.find(b => b.id === templateId);
  if (!t) return;

  const btn = document.getElementById('install-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line animate-spin"></i> Deploying...';

  // Collect env vars
  const envVars = collectInstallEnvVars();
  const sessionId = document.getElementById('install-session-id').value.trim();
  const ownerNumber = document.getElementById('install-owner-number').value.trim();
  const prefix = document.getElementById('install-prefix').value.trim();
  if (sessionId && t.session_key) envVars[t.session_key] = sessionId;
  if (ownerNumber && t.owner_key) envVars[t.owner_key] = ownerNumber;
  if (prefix && t.prefix_key) envVars[t.prefix_key] = prefix;

  const body = {
    name: document.getElementById('install-name').value.trim(),
    description: t.description,
    repo_url: t.repo,
    branch: t.branch,
    entry_point: document.getElementById('install-entry').value.trim() || t.entry,
    env_vars: envVars,
    auto_restart: 1,
    server_tier: 'basic'
  };

  try {
    const createData = await api('/api/bots', { method: 'POST', body });
    const botId = createData.bot.id;
    btn.innerHTML = '<i class="ri-loader-4-line animate-spin"></i> Cloning & starting...';
    try {
      await api(`/api/bots/${botId}/deploy`, { method: 'POST' });
      toast(`${t.name} deployed successfully!`, 'success');
    } catch (deployErr) {
      toast(`Bot created but deploy had an issue: ${deployErr.message}`, 'warning');
    }
    navigate('bots');
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = `<i class="ri-install-line"></i> Install & Deploy ${t.name}`;
  }
}

function addInstallEnvRow(key = '', value = '', description = '') {
  const container = document.getElementById('install-env-rows');
  const row = document.createElement('div');
  row.className = 'install-env-row flex gap-2 items-start';
  const descHtml = description ? `<p class="text-xs text-gray-500 mt-0.5 pl-1">${escapeHtml(description)}</p>` : '';
  row.innerHTML = `<div class="w-2/5">
      <input type="text" placeholder="KEY" class="install-env-key w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-sm focus:border-brand-500 focus:outline-none uppercase" value="${escapeHtml(key)}">
      ${descHtml}
    </div>
    <div class="flex-1 flex items-center gap-2">
      <input type="text" placeholder="value" class="install-env-val flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-sm focus:border-brand-500 focus:outline-none" value="${escapeHtml(value)}">
      <button type="button" onclick="this.closest('.install-env-row').remove()" class="text-gray-500 hover:text-red-400 transition px-1"><i class="ri-close-line text-lg"></i></button>
    </div>`;
  container.appendChild(row);
}

function collectInstallEnvVars() {
  const env = {};
  document.querySelectorAll('.install-env-row').forEach(row => {
    const k = row.querySelector('.install-env-key').value.trim().toUpperCase();
    const v = row.querySelector('.install-env-val').value;
    if (k) env[k] = v;
  });
  return env;
}

// Old handleInstallNovaSpark removed — replaced by handleAdminInstallBot above

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
function toast(msg, type='info') { const c = document.getElementById('toast-container'); if (!c) return; const colors = { success:'bg-green-500/90', error:'bg-red-500/90', info:'bg-brand-500/90', warning:'bg-yellow-500/90' }; const t = document.createElement('div'); t.className = `${colors[type]||colors.info} text-white px-5 py-3 rounded-lg shadow-lg text-sm backdrop-blur-sm fade-in`; t.textContent = msg; c.appendChild(t); setTimeout(()=>{ try { t.remove(); } catch(_){} }, 4000); }
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

// ─── GLOBAL ERROR BOUNDARY ───────────────────────────────────────────────────
// Prevents the site from crashing on unhandled errors
window.addEventListener('error', function(event) {
  console.error('[NovaSpark] Caught error:', event.error);
  // Don't crash the whole app — show a toast if possible
  try { toast('Something went wrong. Please try again.', 'error'); } catch(_) {}
  event.preventDefault();
});

window.addEventListener('unhandledrejection', function(event) {
  console.error('[NovaSpark] Unhandled promise rejection:', event.reason);
  // Only show toast for non-auth errors (auth errors are handled)
  const msg = event.reason?.message || String(event.reason);
  if (!msg.includes('Unauthorized') && !msg.includes('TOKEN_EXPIRED')) {
    try { toast('A background operation failed.', 'error'); } catch(_) {}
  }
  event.preventDefault();
});

// Wait for DOM before calling init so auth modal elements exist
document.addEventListener('DOMContentLoaded', () => {
  // Bind login/signup forms here — NOT via inline onsubmit in HTML
  // Using addEventListener ensures e.preventDefault() blocks the native form submit reliably
  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);
  if (signupForm) signupForm.addEventListener('submit', handleSignup);
  init();
});
