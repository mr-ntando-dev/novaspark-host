# NovaSpark V11.1 — Bot Hosting Platform

Next-gen WhatsApp/Discord bot hosting with real-time dashboard, auto-config detection, coin economy, and Stripe-ready billing.

## What's New in V11.1

- **Auto-Config Detection** — Paste a GitHub URL and the platform auto-reads `novaspark.config.json`, `.env.example`, or `package.json` to pre-fill your deploy form (entry point, env vars, bot name, description).
- **Fixed Deploy Button** — Deploy now properly creates the bot, clones the repo, installs deps, and starts the process with full error reporting.
- **Advanced Deploy Settings** — Server tier, auto-restart toggle, max RAM, custom install commands.
- **Crash Protection** — Global error boundaries on both frontend and backend prevent the site from going blank on errors.
- **Better Error UX** — Deploy errors shown inline with clear messages instead of silent failures.

## Bot Config Auto-Read

Users deploying bots can add a `novaspark.config.json` to their repo root. The platform reads it automatically:

```json
{
  "name": "My Bot",
  "description": "A WhatsApp bot with 130+ commands",
  "entry_point": "index.js",
  "branch": "main",
  "server_tier": "basic",
  "auto_restart": true,
  "max_ram_mb": 512,
  "env": {
    "BOT_TOKEN": {
      "description": "Your bot token from the provider",
      "required": true
    },
    "PREFIX": {
      "description": "Command prefix",
      "required": false,
      "default": "!"
    }
  }
}
```

The platform also reads `.env.example` and `package.json` as fallbacks.

## Deploy

### On Render (recommended)

1. Fork this repo
2. Create a new Web Service on [Render](https://render.com)
3. Connect your forked repo
4. Set environment variables from `.env.example`
5. Deploy — the platform auto-starts

### Local Development

```bash
cp .env.example .env
# Edit .env with your secrets
npm install
npm run dev
```

## Stack

- **Backend:** Node.js 22+, Express, SQLite (built-in `node:sqlite`), WebSocket
- **Frontend:** Vanilla JS SPA, Tailwind CSS, Remix Icons
- **Auth:** JWT with refresh tokens, optional 2FA (TOTP)
- **Bot Engine:** Process isolation, auto-restart with exponential backoff, health watchdog

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/repo-config | Auto-detect bot config from GitHub repo |
| POST | /api/bots | Create a new bot |
| POST | /api/bots/:id/deploy | Clone repo + install deps + start bot |
| POST | /api/bots/:id/start | Start a stopped bot |
| POST | /api/bots/:id/stop | Stop a running bot |
| POST | /api/bots/:id/restart | Restart a bot |
| GET | /api/bots/:id/logs | Get bot logs |
| GET | /api/bots/:id/env | Get env vars (masked) |
| PUT | /api/bots/:id/env | Update env vars |
| GET | /api/health | Health check |

## License

MIT
