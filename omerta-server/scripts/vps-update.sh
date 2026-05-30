#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Creating pre-update backup..."
./scripts/backup-db.sh || true

docker compose -f docker-compose.vps.yml --env-file .env pull || true
docker compose -f docker-compose.vps.yml --env-file .env up -d --build
./scripts/vps-smoke-test.sh
