Omerta Server/Dashboard Project Structure

This package is server/dashboard only. It does not include the Android app.

Main folders

- `omerta-core-server/` - Fastify/Node API server for auth, creator control, relay, release policy, privacy controls and server operations.
- `omerta-creator-dashboard/` - React/Vite dashboard for creator/server/container management.
- `docker/` - nginx and optional infrastructure configs.
- `scripts/` - operational scripts for VPS start/stop/logs/backup/restore/smoke-test.
- `docs/` - permanent documentation.

Important root files

- `docker-compose.vps.yml` - main VPS Docker Compose file.
- `.env.vps.example` - example production environment config.
- `deploy-server-dashboard.sh` - deploy helper.
- `apply-dashboard-cleanup.sh` - applies dashboard cleanup update while keeping current `.env` and volumes.
- `README_SERVER_DASHBOARD_ONLY.md` - server/dashboard package overview.

Documentation rules

Use `docs/CHANGELOG.md` for all future version notes. Do not create separate `RELEASE_NOTES_V*.md` files for every build.

Keep docs focused on stable project areas:

- architecture
- deploy
- security
- changelog
- project structure
- VPS operations

Temporary one-off build notes should be moved into `docs/CHANGELOG.md` or removed before packaging.
