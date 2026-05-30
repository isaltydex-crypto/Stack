# Quick deploy

1. Copy this folder to your VPS.
2. Edit domains in `docker/nginx/default.conf`.
3. Edit secrets in `omerta-core-server/.env.example` and rename it to `.env` later.
4. Start:

```bash
docker compose up -d --build
```

5. Put Creator Dashboard behind WireGuard before real use.

This is a scaffold, not production-ready until database persistence, TLS, backups and signed command verification are completed.

## v2.4 Server Deploy Ready

Production checklist:

1. Copy `omerta-core-server/.env.production.example` to `omerta-core-server/.env.production` and replace every `CHANGE_*` value.
2. Create `.env` beside `docker-compose.prod.yml` with:
   - `POSTGRES_PASSWORD=...`
   - `VITE_API_URL=https://api.example.com`
3. Replace domains in `docker/nginx/omerta-prod.conf`.
4. Add TLS certs to `certs/fullchain.pem` and `certs/privkey.pem`.
5. Start with `docker compose -f docker-compose.prod.yml up -d --build`.
6. Run `API_URL=https://api.example.com scripts/verify-prod.sh`.
7. Test `/health`, `/ready`, `/metrics`, creator login, wipe PIN gate, backup and restore.

Backups:

```bash
scripts/backup-db.sh
scripts/restore-db.sh backups/omerta-YYYYMMDDTHHMMSSZ.sql
```

Keep the creator dashboard behind WireGuard or another VPN. Public HTTPS alone is not enough for the control plane.
