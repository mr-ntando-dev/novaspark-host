# NovaSpark V13 — Pterodactyl Panel Deployment Guide

## Quick Install (3 steps)

### 1 — Import the Egg

1. Log into your Pterodactyl **Admin Panel**
2. Go to **Nests** → choose an existing nest or create one called *Bots*
3. Click **Import Egg** and upload `pterodactyl-egg.json` from this repo
4. Save

### 2 — Create a Server

1. Go to **Servers** → **Create New**
2. Under *Nest Configuration* select the nest and the **NovaSpark V13** egg
3. Set allocations:
   - **Port** — any free port (e.g. `3000`). This becomes `PORT` automatically.
   - Recommended RAM: **1 GB** minimum (2 GB if running many bots)
   - Recommended Disk: **5 GB** minimum
4. Fill in the **Startup Variables** (see below)
5. Click **Create Server** → Pterodactyl will run the install script automatically

### 3 — Start & Access

1. Start the server from the panel
2. Open `http://<your-server-ip>:<PORT>` in your browser
3. Log in with the **Admin Username / Password** you set

---

## Required Startup Variables

| Variable | Description | Example |
|---|---|---|
| `APP_URL` | Public URL of this instance | `http://123.45.67.89:3000` |
| `PORT` | Port to listen on | `3000` |
| `ADMIN_USERNAME` | First admin account username | `admin` |
| `ADMIN_PASSWORD` | First admin account password | `SecurePass123!` |

> **Security:** `JWT_SECRET` and `JWT_REFRESH_SECRET` are auto-generated on first boot if left blank. Set them manually for reproducible restarts.

---

## Optional Variables

| Variable | Description |
|---|---|
| `DISCORD_WEBHOOK_URL` | Alert notifications to a Discord channel |
| `GITHUB_TOKEN` | For cloning private bot repos |
| `STRIPE_SECRET_KEY` | Billing/subscription features |
| `VAULT_ENCRYPTION_KEY` | Custom AES-256 key for the Secret Vault |
| `BOT_MAX_RAM_MB` | RAM cap per bot process (default: 512) |
| `MAX_BOTS_GLOBAL` | Hard limit on total bots (default: 100) |
| `MAX_OLD_SPACE_MB` | Node.js heap size — set to ~80% of container RAM |
| `ANOMALY_SENSITIVITY` | AI detection sensitivity 1–10 (default: 5) |

---

## Data Persistence

All persistent data lives under `data/` inside the server's working directory:

```
data/
  novaspark.db     ← SQLite database (all users, bots, logs)
  bots/            ← Cloned bot repos & node_modules
  sessions/        ← WhatsApp session files
  backups/         ← Bot backup archives
```

> Pterodactyl preserves `data/` across restarts and reinstalls **as long as you do not wipe the server volume**. Back up `data/novaspark.db` regularly.

---

## Updating NovaSpark

SSH into the container (or use the panel's file manager) and run:

```bash
git pull
npm install --production --omit=dev
# then restart the server from the panel
```

Or simply trigger a **Reinstall** from the panel — it will pull the latest code while preserving your `data/` directory.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Server starts but is unreachable | Check the port is open in your server's firewall (`ufw allow <PORT>`) |
| `EADDRINUSE` on startup | Another process is using the port — change `PORT` in panel vars |
| Bots fail to clone | Set `GITHUB_TOKEN` for private repos; check the bot's GitHub URL |
| `node:sqlite` not found | Ensure the egg uses **Node.js 22** — the built-in SQLite module requires it |
| High RAM usage | Lower `BOT_MAX_RAM_MB` or reduce `MAX_BOTS_GLOBAL` |
