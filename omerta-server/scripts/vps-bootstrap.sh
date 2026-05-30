#!/usr/bin/env bash
set -euo pipefail

if [ ! -f omerta-core-server/.env.production ]; then
  cp omerta-core-server/.env.production.example omerta-core-server/.env.production
  echo "Created omerta-core-server/.env.production. Edit secrets before starting production."
fi

mkdir -p backups certs

echo "Next:"
echo "1) Edit omerta-core-server/.env.production"
echo "2) Export POSTGRES_PASSWORD and VITE_API_URL"
echo "3) docker compose -f docker-compose.vps.yml up -d --build"
