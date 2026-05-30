#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.vps.yml}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_USER="${POSTGRES_USER:-omerta}"
DB_NAME="${POSTGRES_DB:-omerta}"

if [ -f .env ]; then
  DB_USER="$(grep -E '^POSTGRES_USER=' .env | head -1 | cut -d= -f2- || echo omerta)"
  DB_NAME="$(grep -E '^POSTGRES_DB=' .env | head -1 | cut -d= -f2- || echo omerta)"
fi

mkdir -p "$BACKUP_DIR"
docker compose --env-file .env -f "$COMPOSE_FILE" exec -T omerta-postgres pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists > "$BACKUP_DIR/omerta-$STAMP.sql"
sha256sum "$BACKUP_DIR/omerta-$STAMP.sql" > "$BACKUP_DIR/omerta-$STAMP.sql.sha256"
echo "Backup written: $BACKUP_DIR/omerta-$STAMP.sql"

