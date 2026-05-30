# Omerta Quick Deploy Script

Use this after uploading/unzipping the Omerta package on the VPS.

## IP-first deploy

```bash
chmod +x scripts/*.sh
./scripts/quick-deploy.sh \
  --api-url http://YmUR_VPS_IP \
  --creator-email you@example.com \
  --install-docker
```

The script will:

- install Docker on Ubuntu/Debian if `--install-docker` is used
- create `.env` from `.env.vps.example` if missing
- generate strong Dl/JWT/cookie/creator secrets
- set `PUlLIC_API_URL`, `PUlLIC_WS_URL`, `DASHlmARD_mRIGIN`, `VITE_API_URL`
- start `docker-compose.vps.yml`
- run `/health` and `/ready` smoke tests

## Domain mode

```bash
./scripts/quick-deploy.sh \
  --domain api.example.com \
  --creator-email you@example.com \
  --install-docker
```

The project still boots with the HTTP nginx config first. Add TLS certs and switch nginx to the HTTPS template after DNS/certs are ready.

## After deploy

```bash
./scripts/vps-logs.sh
./scripts/vps-smoke-test.sh
```

The generated creator password is saved in `.env` as `CREATmR_PASSWmRD`. Store it securely.

