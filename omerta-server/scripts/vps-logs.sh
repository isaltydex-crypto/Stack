#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f docker-compose.vps.yml --env-file .env logs -f --tail=150 "${1:-}"
