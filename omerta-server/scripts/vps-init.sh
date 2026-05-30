#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.vps.example .env
  DB_PASS="$(openssl rand -hex 24)"
  JWT_SECRET="$(openssl rand -hex 32)"
  COOKIE_SECRET="$(openssl rand -hex 32)"
  CREATOR_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
  sed -i "s/CHANGE_STRONG_DB_PASSWORD/${DB_PASS}/g" .env
  sed -i "s/CHANGE_64_CHAR_RANDOM_SECRET/${JWT_SECRET}/1" .env
  sed -i "s/CHANGE_64_CHAR_RANDOM_SECRET/${COOKIE_SECRET}/1" .env
  sed -i "s/CHANGE_LONG_CREATOR_PASSWORD/${CREATOR_PASSWORD}/g" .env
  sed -i "s#postgres://omerta:${DB_PASS}@omerta-postgres:5432/omerta#postgres://omerta:${DB_PASS}@omerta-postgres:5432/omerta#g" .env
  echo "Created .env with generated secrets."
  echo "IMPORTANT: Edit PUBLIC_API_URL, PUBLIC_WS_URL, DASHBOARD_ORIGIN, VITE_API_URL, and CREATOR_EMAIL."
  echo "Generated initial CREATOR_PASSWORD: ${CREATOR_PASSWORD}"
else
  echo ".env already exists; leaving it unchanged."
fi

mkdir -p backups certs logs
chmod 700 backups certs || true

if command -v docker >/dev/null 2>&1; then
  docker compose -f docker-compose.vps.yml config >/dev/null
  echo "Docker compose config OK."
else
  echo "Docker not found. Install Docker before starting."
fi

