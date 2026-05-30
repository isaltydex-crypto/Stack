# Omerta Server

This is the standalone Omerta server/dashboard/deploy package.

## Contents

- `omerta-core-server/` - API/auth/control server
- `omerta-creator-dashboard/` - creator dashboard
- `docker/` - nginx and deployment templates
- `scripts/` - VPS helper scripts
- `docs/CHANGELOG.md` - project changelog
- `docs/VPS_DEPLOY_CHEATSHEET.md` - VPS deploy guide

## Server Deploy

Use the VPS server/dashboard flow:

```bash
chmod +x deploy-server-dashboard.sh scripts/*.sh
./deploy-server-dashboard.sh
```

The deploy script creates `.env` when needed and asks for VPS API URL, creator email, Docker install and whether existing secrets should be reset.

After first deploy, use the simple server control menu:

```bash
chmod +x omerta-control.sh
./omerta-control.sh
```

For the full checklist, see:

```text
docs/VPS_DEPLOY_CHEATSHEET.md
```

## Android App

The Android app now lives separately in:

```text
C:\Users\Logii\Documents\omerta-app
```
