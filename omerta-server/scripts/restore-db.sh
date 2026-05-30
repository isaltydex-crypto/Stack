#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 1 ]]; then echo "Usage: $0 backups/omerta-YYYYMMDDTHHMMSSZ.sql" >&2; exit 1; fi
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.vps.yml}"
BACKUP_FILE="$1"
DB_USER="${POSTGRES_USER:-omerta}"
DB_NAME="${POSTGRES_DB:-omerta}"

if [[ ! -f "$BACKUP_FILE" ]]; then echo "Missing backup file: $BACKUP_FILE" >&2; exit 1; fi
if [ -f .env ]; then
  DB_USER="$(grep -E '^POSTGRES_USER=' .env | head -1 | cut -d= -f2- || echo omerta)"
  DB_NAME="$(grep -E '^POSTGRES_DB=' .env | head -1 | cut -d= -f2- || echo omerta)"
fi

echo "Restoring $BACKUP_FILE into postgres container..."
docker compose --env-file .env -f "$COMPOSE_FILE" exec -T omerta-postgres psql -U "$DB_USER" -d "$DB_NAME" < "$BACKUP_FILE"
echo "Restore complete. Run ./scripts/vps-smoke-test.sh next."

