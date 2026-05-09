#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# NovaSpark V13 — Pterodactyl Entrypoint
# Runs inside the panel container as the "container" user.
# ─────────────────────────────────────────────────────────────────

set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   NovaSpark V13  —  Starting up…     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Create data directories (panel wipes /home/container on reinstall) ──
mkdir -p /home/container/data/bots
mkdir -p /home/container/data/sessions
mkdir -p /home/container/data/backups

# ── 2. Install production dependencies ──
echo "[entrypoint] Installing npm dependencies…"
npm install --production --omit=dev 2>&1

# ── 3. Copy .env.example → .env only if .env doesn't exist yet ──
if [ ! -f /home/container/.env ]; then
  if [ -f /home/container/.env.example ]; then
    cp /home/container/.env.example /home/container/.env
    echo "[entrypoint] Created .env from .env.example — please set your secrets via panel env vars."
  fi
fi

# ── 4. Start NovaSpark ──
echo "[entrypoint] Launching NovaSpark V13…"
exec node --expose-gc --max-old-space-size=${MAX_OLD_SPACE_MB:-512} server.js
