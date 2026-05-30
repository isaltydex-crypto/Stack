#!/usr/bin/env bash
set -euo pipefail
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.vps.yml}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Run this from the Omerta server/dashboard project root, where $COMPOSE_FILE exists."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is not installed."
  exit 1
fi

echo "[1/5] Keeping existing .env and Docker volumes."
if [[ ! -f .env ]]; then
  echo "WARNING: .env not found. Copy .env.vps.example to .env before production use."
fi

echo "[2/5] Building server + dashboard with latest files..."
docker compose -f "$COMPOSE_FILE" build --no-cache --progress=plain omerta-core-server omerta-creator-dashboard

echo "[3/5] Recreating containers..."
docker compose -f "$COMPOSE_FILE" up -d --force-recreate omerta-core-server omerta-creator-dashboard nginx omerta-postgres

echo "[4/5] Status:"
docker compose -f "$COMPOSE_FILE" ps

echo "[5/5] Smoke test:"
API_URL="$(grep -E '^PUBLIC_API_URL=' .env 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
API_URL="${API_URL:-http://127.0.0.1}"
if command -v curl >/dev/null 2>&1; then
  curl -fsS "$API_URL/health" && echo "\nHealth OK" || echo "Health endpoint did not respond yet. Check logs."
else
  echo "curl not installed; skipping health check."
fi

echo "Done. Existing database data was kept."


