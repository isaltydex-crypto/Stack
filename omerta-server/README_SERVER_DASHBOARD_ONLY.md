# Omerta Server + Dashboard

This package contains only the Omerta server, Creator Dashboard and deployment files. The Android app is not included.

## Included

- `omerta-core-server/` - Omerta API/server.
- `omerta-creator-dashboard/` - Creator Dashboard UI.
- `docker/` - nginx and infrastructure config.
- `scripts/` - VPS helper scripts.
- `docs/` - architecture, deployment, security and changelog docs.
- `docker-compose.vps.yml` - VPS deployment compose file.
- `.env.vps.example` - example environment config.

## Deploy

Use the deploy script or Docker Compose directly.

```bash
chmod +x deploy-server-dashboard.sh
./deploy-server-dashboard.sh --api-url http://YOUR_VPS_IP --creator-email you@example.com --install-docker
```

## Updating an existing VPS install

To apply this package over an existing server while keeping `.env` and database volumes:

```bash
chmod +x apply-dashboard-cleanup.sh
./apply-dashboard-cleanup.sh
```

## Changelog rule

All future version changes should be written in `docs/CHANGELOG.md`. Do not create a new release-notes file for every build.

