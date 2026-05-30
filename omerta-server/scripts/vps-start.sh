#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

test -f .env || { echo "Missing .env. Run ./scripts/vps-init.sh first."; exit 1; }
docker compose -f docker-compose.vps.yml --env-file .env up -d --build
./scripts/vps-smoke-test.sh
