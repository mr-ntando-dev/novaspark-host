# NovaSpark V13 — Advanced Bot Hosting Platform

<p align="center">
  <img src="public/logo.svg" width="120" alt="NovaSpark Logo" />
</p>

Next-gen WhatsApp/Discord bot hosting with **Live Terminal**, **AI Anomaly Detection**, **Bot Event Bus**, **Plugin System**, **Secret Vault**, **CI/CD Pipelines**, **Status Pages**, **Resource Quotas**, **Rate Limiter**, **Geo-Distributed Regions**, and the full V12 feature suite.

---

## What's New in V13.0

- **Live Web Terminal** — Real-time shell access to bot containers via WebSocket. Execute commands, view output, debug bots in-place without SSH.
- **AI Anomaly Detection** — Intelligent monitoring using statistical analysis (z-score, trend detection, moving averages) to detect memory leaks, crash loops, CPU spikes, error rate anomalies, and performance degradation before bots go down. Auto-generates health scores (A-F grading).
- **Bot-to-Bot Event Bus** — Pub/sub messaging system for inter-bot communication. Named channels, message persistence, delivery confirmation. Build multi-bot workflows.
- **Plugin System with Hot-Reload** — Install, configure, and hot-reload plugins without restarting bots. Built-in plugins for auto-welcome, moderation, analytics, webhooks, anti-crash, and scheduled messages.
- **Secret Vault (Encrypted)** — AES-256-GCM encrypted environment variable storage with rotation support, version history, expiration dates, audit trails, and bulk injection into bots.
- **CI/CD Pipeline Builder** — Multi-step deployment pipelines: git pull → install → test → build → deploy → notify. GitHub webhook triggers, parallel execution, rollback on failure.
- **Public Status Pages** — Per-bot status pages (like statuspage.io) with 90-day uptime history, incident management, maintenance windows, and response time graphs.
- **Resource Quotas & Metering** — Per-plan resource limits (bots, RAM, storage, bandwidth, deploys/day). Real-time usage tracking, overage alerts, usage history export.
- **Per-Bot Rate Limiter** — Configurable DDoS protection with IP blocking/whitelisting, auto-block after repeated violations, burst detection, and real-time attack dashboards.
- **Geo-Distributed Regions** — Deploy bots to 8 global regions (US East, US West, EU Frankfurt, EU London, Asia Singapore, Asia Tokyo, Africa Johannesburg, South America São Paulo). Latency-based recommendations and multi-region failover.

## Previous Features (V12.x)

- **Bot Analytics & Metrics** — Real-time CPU, RAM, uptime tracking with historical data and hourly activity charts.
- **Team Collaboration** — Create teams, invite members with role-based access (owner/admin/developer/viewer).
- **Scheduled Tasks (Cron)** — Automate bot actions on any cron schedule.
- **Bot Marketplace** — Browse, publish, rate, and one-click deploy community bot templates.
- **Webhook Integrations** — Discord, Slack, or custom HTTP endpoint notifications.
- **Custom Domain Mapping** — Map domains to bots with DNS verification and SSL.
- **Automated Backups** — One-click backup/restore for bot files and config.
- **Bot Versioning & Rollback** — Every deploy tracked; instant rollback to any previous version.

## Previous Features (V11.x)

- **Auto-Config Detection** — Paste a GitHub URL and auto-reads `novaspark.config.json`.
- **Fixed Deploy Button** — Proper clone, install, start with full error reporting.
- **Advanced Deploy Settings** — Server tier, auto-restart, max RAM, custom install commands.
- **Crash Protection** — Global error boundaries on frontend and backend.
- **Coin Economy** — Earn/spend coins, daily rewards, referral system, leaderboard.
- **Bot Templates** — Pre-built WhatsApp bot templates for one-click deploy.

---

## Bot Config Auto-Read

Add a `novaspark.config.json` to your repo root:

```json
{
  "name": "My Bot",
  "description": "A WhatsApp bot with 130+ commands",
  "entry_point": "index.js",
  "branch": "main",
  "server_tier": "basic",
  "auto_restart": true,
  "max_ram_mb": 512,
  "region": "us-east-1",
  "plugins": ["anti-crash", "analytics-tracker"],
  "pipeline": "default",
  "env": {
    "BOT_TOKEN": { "description": "Your bot token", "required": true },
    "PREFIX": { "description": "Command prefix", "required": false, "default": "!" }
  }
}
```

---

## Deploy

### On Render (recommended)

1. Fork this repo
2. Create a new Web Service on [Render](https://render.com/)
3. Connect your forked repo
4. Set environment variables from `.env.example`
5. Deploy — the platform auto-starts

### Local Development

```bash
cp .env.example .env  # Edit .env with your secrets
npm install
npm run dev
```

---

## Stack

- **Backend:** Node.js 22+, Express, SQLite (built-in `node:sqlite`), WebSocket
- **Frontend:** Vanilla JS SPA, Tailwind CSS, Remix Icons
- **Auth:** JWT with refresh tokens, optional 2FA (TOTP)
- **Bot Engine:** Process isolation, auto-restart with exponential backoff, health watchdog
- **Encryption:** AES-256-GCM (vault), bcrypt (passwords), HMAC-SHA256 (webhooks)
- **V13 Engine:** Anomaly detection (z-score/trend analysis), pub/sub event bus, pipeline executor

---

## API Endpoints

### Core

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/signup | Register |
| POST | /api/auth/login | Login |
| POST | /api/repo-config | Auto-detect bot config from GitHub |
| POST | /api/bots | Create a new bot |
| POST | /api/bots/:id/deploy | Clone + install + start |
| POST | /api/bots/:id/start | Start bot |
| POST | /api/bots/:id/stop | Stop bot |
| POST | /api/bots/:id/restart | Restart bot |
| GET | /api/bots/:id/logs | Get logs |
| GET | /api/health | Health check |

### Analytics (V12)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/analytics/overview | Account-wide analytics |
| GET | /api/analytics/:botId/metrics | Real-time bot metrics |
| GET | /api/analytics/:botId/analytics | Historical data (1h/6h/24h/7d/30d) |

### Teams (V12)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/teams | Create team |
| GET | /api/teams | List my teams |
| POST | /api/teams/:id/invite | Invite member |
| POST | /api/teams/join/:code | Join via invite code |

### Scheduler (V12)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/scheduler | Create scheduled task |
| GET | /api/scheduler/bot/:botId | List tasks for bot |
| POST | /api/scheduler/:id/run | Execute task now |

### Marketplace (V12)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/marketplace | Browse marketplace |
| POST | /api/marketplace/publish | Publish bot template |
| POST | /api/marketplace/:id/review | Review/rate a bot |

### Live Terminal (V13)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/terminal/:botId/start | Start terminal session |
| POST | /api/terminal/:botId/exec | Execute command |
| GET | /api/terminal/:botId/output | Get output buffer |
| POST | /api/terminal/:botId/stop | End terminal session |
| GET | /api/terminal/sessions | List active sessions |

### AI Anomaly Detection (V13)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/anomaly/overview | All bots anomaly summary |
| GET | /api/anomaly/:botId/alerts | Get anomaly alerts |
| GET | /api/anomaly/:botId/health-score | Bot health score (0-100, A-F) |
| GET | /api/anomaly/:botId/metrics-history | Raw metrics for charts |
| POST | /api/anomaly/:botId/alerts/:alertId/resolve | Dismiss alert |

### Event Bus (V13)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/event-bus/channels | Create channel |
| GET | /api/event-bus/channels | List channels |
| POST | /api/event-bus/channels/:ch/subscribe | Subscribe bot |
| POST | /api/event-bus/channels/:ch/unsubscribe | Unsubscribe bot |
| POST | /api/event-bus/channels/:ch/publish | Publish event |
| GET | /api/event-bus/channels/:ch/messages | Message history |
| DELETE | /api/event-bus/channels/:ch | Delete channel |
| GET | /api/event-bus/bots/:botId/subscriptions | Bot subscriptions |

### Plugin System (V13)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/plugins/available | List available plugins |
| POST | /api/plugins/:botId/install | Install plugin to bot |
| GET | /api/plugins/:botId | List installed plugins |
| PUT | /api/plugins/:botId/:pluginId | Update plugin config |
| POST | /api/plugins/:botId/:pluginId/reload | Hot-reload plugin |
| DELETE | /api/plugins/:botId/:pluginId | Uninstall plugin |

### Secret Vault (V13)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/vault | Create secret |
| GET | /api/vault | List secrets (metadata only) |
| GET | /api/vault/:id/reveal | Decrypt & reveal secret |
| POST | /api/vault/:id/rotate | Rotate secret value |
| GET | /api/vault/:id/history | Version history |
| DELETE | /api/vault/:id | Delete secret |
| POST | /api/vault/inject/:botId | Bulk inject secrets into bot |

### CI/CD Pipelines (V13)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/pipelines | Create pipeline |
| GET | /api/pipelines | List pipelines |
| POST | /api/pipelines/:id/run | Execute pipeline |
| GET | /api/pipelines/:id/runs | Run history |
| PUT | /api/pipelines/:id | Update pipeline |
| DELETE | /api/pipelines/:id | Delete pipeline |
| GET | /api/pipelines/step-types | Available step types |
| POST | /api/pipelines/webhook/github | GitHub webhook trigger |

### Status Pages (V13)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/status-pages | Create status page |
| GET | /api/status-pages | List my status pages |
| GET | /api/status-pages/public/:slug | Public status (no auth) |
| POST | /api/status-pages/:id/incidents | Create incident |
| POST | /api/status-pages/:id/incidents/:iid/update | Update incident |
| POST | /api/status-pages/:id/maintenance | Schedule maintenance |
| DELETE | /api/status-pages/:id | Delete status page |

### Resource Quotas (V13)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/quotas/usage | Current usage vs limits |
| GET | /api/quotas/history | Usage history (up to 90 days) |
| GET | /api/quotas/plans | Plan comparison |

### Rate Limiter (V13)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/rate-limiter/:botId/config | Configure rate limits |
| GET | /api/rate-limiter/:botId/config | Get config |
| GET | /api/rate-limiter/:botId/stats | Real-time stats |
| POST | /api/rate-limiter/:botId/block | Block an IP |
| POST | /api/rate-limiter/:botId/unblock | Unblock an IP |
| POST | /api/rate-limiter/:botId/whitelist | Add to whitelist |
| GET | /api/rate-limiter/:botId/events | Attack/event log |

### Geo Regions (V13)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/regions | List all regions |
| GET | /api/regions/recommend | Get recommended region |
| POST | /api/regions/:botId/deploy | Deploy to region |
| GET | /api/regions/:botId | Bot's active regions |
| DELETE | /api/regions/:botId/:region | Remove from region |
| POST | /api/regions/:botId/:region/primary | Set primary region |
| GET | /api/regions/health/all | All region health |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NovaSpark V13 Platform                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌────────────────────┐ │
│  │ Express │  │ WebSocket │  │  SQLite  │  │   Bot Engine       │ │
│  │  API    │  │  Server   │  │  (WAL)   │  │   (Process Mgr)    │ │
│  └────┬────┘  └─────┬─────┘  └────┬─────┘  └────────┬───────────┘ │
│       │              │             │                  │             │
│  ┌────┴──────────────┴─────────────┴──────────────────┴───────────┐ │
│  │                    Core Services                                │ │
│  ├─────────────────────────────────────────────────────────────────┤ │
│  │  Auth (JWT+2FA) │ Teams (RBAC) │ Economy (Coins) │ Marketplace │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─────────────────── V13 Services ──────────────────────────────┐  │
│  │                                                               │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐   │  │
│  │  │ Terminal │ │ Anomaly  │ │ Event    │ │ Plugin System  │   │  │
│  │  │ (Shell)  │ │ Detection│ │ Bus      │ │ (Hot-Reload)   │   │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────────────┘   │  │
│  │                                                               │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐   │  │
│  │  │ Vault    │ │ CI/CD    │ │ Status   │ │ Quotas &       │   │  │
│  │  │(AES-256) │ │ Pipeline │ │ Pages    │ │ Metering       │   │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────────────┘   │  │
│  │                                                               │  │
│  │  ┌──────────────────────┐ ┌──────────────────────────────┐   │  │
│  │  │ Rate Limiter (DDoS)  │ │ Geo Regions (8 locations)    │   │  │
│  │  └──────────────────────┘ └──────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Plan Limits

| Feature | Free | Starter | Pro | Enterprise |
|---------|------|---------|-----|------------|
| Bots | 2 | 5 | 20 | Unlimited |
| RAM | 512MB | 1GB | 2GB | 8GB |
| Storage | 500MB | 2GB | 10GB | 50GB |
| Deploys/day | 5 | 20 | 100 | Unlimited |
| Team members | 0 | 3 | 10 | 50 |
| Pipelines | 1 | 5 | 20 | 100 |
| Plugins | 3 | 10 | 50 | Unlimited |
| Secrets | 10 | 50 | 200 | Unlimited |
| Terminal | ❌ | ✅ | ✅ | ✅ |
| Custom Domains | 0 | 1 | 5 | 20 |
| Backup Retention | 7d | 14d | 30d | 90d |

---

## License

MIT
