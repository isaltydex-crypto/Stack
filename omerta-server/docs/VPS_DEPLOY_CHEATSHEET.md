# Omerta VPS Deploy Cheatsheet

Från nyinstallerad VPS till fungerande Omerta server, dashboard och databas.

## 0. Vad Som Startas

- `omerta-core-server`: API, auth, invites, release, wipe, relay, E2EE endpoints.
- `omerta-creator-dashboard`: creator/admin dashboard.
- `omerta-postgres`: Postgres databas.
- `nginx`: publik reverse proxy på port 80. HTTPS kan läggas på efter första start.

## 1. Krav På VPS

Rekommenderat:

- Ubuntu 22.04/24.04 eller Debian 12.
- Minst 2 GB RAM.
- Root eller sudo access.
- DNS A-record om du använder domän, till exempel `api.dindoman.se -> VPS_IP`.
- Brandvägg med minst port `22` och `80` öppen. Öppna `443` först när TLS är klart.

## 2. Första Server-Setup

Logga in:

```bash
ssh root@YOUR_VPS_IP
```

Uppdatera systemet:

```bash
apt-get update
apt-get upgrade -y
apt-get install -y git curl nano unzip ca-certificates ufw
```

Brandvägg:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw enable
ufw status
```

## 3. Lägg Upp Projektet På VPS

Från din dator kan du skicka projektmappen med `scp`, Git, SFTP eller FileZilla.

Exempel med `scp` från Windows PowerShell:

```powershell
scp -r "C:\Users\Logii\Documents\omerta-server" root@YOUR_VPS_IP:/opt/omerta
```

På VPS:

```bash
cd /opt/omerta
```

Gör scripts körbara:

```bash
chmod +x deploy-server-dashboard.sh scripts/*.sh
```

Du kan även göra kontroll-skriptet körbart direkt:

```bash
chmod +x omerta-control.sh
```

## 4. Kör Första Deploy

Första enklaste start med IP och auto-install av Docker:

```bash
./deploy-server-dashboard.sh
```

Scriptet frågar efter:

- VPS API URL, till exempel `http://YOUR_VPS_IP`
- creator email, till exempel `creator@omerta.local`
- om Docker ska installeras automatiskt
- om befintlig `.env` ska behållas eller resetta secrets

Deploy-scriptet gör detta:

- Installerar Docker om du svarar ja eller använder `--install-docker`.
- Skapar `.env` från `.env.vps.example`.
- Genererar databaslösenord, JWT secret, cookie secret och creator-lösenord.
- Skriver creator-lösenordet till `creator-initial-password.txt`.
- Bygger och startar Docker-containers.

Visa creator-lösenordet:

```bash
cat creator-initial-password.txt
```

## 4.1 Enkel Server-Meny

Efter första deploy kan du styra det mesta från en siffermeny:

```bash
cd /opt/omerta
./omerta-control.sh
```

Menyn kan bland annat:

- visa health/status
- starta, stoppa, starta om och bygga om Docker-containers
- visa loggar per service
- backup och restore av databasen
- logga in som creator mot API:t
- skapa container/workspace
- skapa admin/sub-admin/user invite-koder
- resetta creator-lösenord
- konfigurera WireGuard och låsa dashboarden till VPN-subnet

## 5. Verifiera Att Allt Kör

Container-status:

```bash
docker compose -f docker-compose.vps.yml ps
```

Loggar:

```bash
docker compose -f docker-compose.vps.yml logs -f
```

Health checks:

```bash
curl http://YOUR_VPS_IP/health
curl http://YOUR_VPS_IP/ready
curl http://YOUR_VPS_IP/metrics
```

Dashboard:

```text
http://YOUR_VPS_IP
```

Logga in med:

- Email: den du gav med `--creator-email`.
- Password: värdet i `creator-initial-password.txt`.

## 6. Skapa Första Container Och Invite

I dashboard:

1. Gå till `Containers`.
2. Skapa container, till exempel `main`.
3. Sätt API URL till `http://YOUR_VPS_IP`.
4. Sätt WebSocket URL till `ws://YOUR_VPS_IP/ws`.
5. Kryssa i `Create first admin invite code`.
6. Spara invite-koden.

Den invite-koden är första vägen in för en admin i Android-appen när live onboarding kopplas.

## 7. Viktiga Kommandon

Starta:

```bash
docker compose -f docker-compose.vps.yml up -d
```

Stoppa:

```bash
docker compose -f docker-compose.vps.yml down
```

Bygg om:

```bash
docker compose -f docker-compose.vps.yml build --no-cache --progress=plain
docker compose -f docker-compose.vps.yml up -d
```

Följ loggar:

```bash
docker compose -f docker-compose.vps.yml logs -f omerta-core-server
docker compose -f docker-compose.vps.yml logs -f nginx
```

Se `.env`:

```bash
nano .env
```

## 8. Backup Och Restore

Skapa backup:

```bash
./scripts/backup-db.sh
```

Backup hamnar i:

```text
backups/omerta-YYYYMMDDTHHMMSSZ.sql
```

Återställ backup:

```bash
./scripts/restore-db.sh backups/omerta-YYYYMMDDTHHMMSSZ.sql
```

Efter restore:

```bash
docker compose -f docker-compose.vps.yml restart
curl http://YOUR_VPS_IP/ready
```

## 9. Uppdatera Servern

Lägg upp nya projektfiler till `/opt/omerta`, men behåll:

- `.env`
- `creator-initial-password.txt`
- `backups/`
- Docker-volymen `omerta-postgres`

Bygg om:

```bash
cd /opt/omerta
docker compose -f docker-compose.vps.yml build --no-cache --progress=plain
docker compose -f docker-compose.vps.yml up -d
docker compose -f docker-compose.vps.yml ps
```

## 10. Byta Från IP Till Domän

När DNS pekar mot VPS:

```bash
./deploy-server-dashboard.sh \
  --api-url http://api.dindoman.se \
  --creator-email creator@omerta.local
```

Om `.env` redan finns behålls den. Vill du återskapa `.env` och hemligheter:

```bash
./deploy-server-dashboard.sh \
  --api-url http://api.dindoman.se \
  --creator-email creator@omerta.local \
  --reset-env
```

Varning: `--reset-env` skapar nya secrets och nytt creator-lösenord. Använd medvetet.

## 11. HTTPS Och VPN

För MVP kan du starta på HTTP via IP. Innan riktig användning:

1. Lägg dashboard bakom WireGuard/VPN eller IP allowlist.
2. Lägg TLS/HTTPS på API och dashboard.
3. Öppna port `443`.
4. Byt appens API URL till `https://...` och WebSocket till `wss://...`.

Brandvägg när HTTPS är klart:

```bash
ufw allow 443/tcp
ufw status
```

## 12. Minsta Smoke Test Efter Deploy

Kör:

```bash
curl http://YOUR_VPS_IP/health
curl http://YOUR_VPS_IP/ready
curl http://YOUR_VPS_IP/metrics
docker compose -f docker-compose.vps.yml ps
```

Testa i dashboard:

- Login.
- Overview laddar.
- Create container.
- Create first admin invite.
- Release policy går att spara.
- Wipe PIN kan sättas.
- Audit visar events.

## 13. Viktiga Säkerhetsregler

- Dela aldrig `.env`.
- Dela aldrig `creator-initial-password.txt`.
- Byt creator-lösenord efter första login när vi har UI för det.
- Kör dashboard bakom VPN innan riktig användning.
- Ta backup innan varje större update.
- Använd HTTPS innan appen kopplas live utanför test.
- Lämna inte `CREATOR_PASSWORD`, `JWT_SECRET` eller `COOKIE_SECRET` på defaultvärden.

## 14. Felsökning

Containers startar inte:

```bash
docker compose -f docker-compose.vps.yml ps
docker compose -f docker-compose.vps.yml logs --tail=200
```

Databasen är inte redo:

```bash
docker compose -f docker-compose.vps.yml logs omerta-postgres
```

API svarar inte:

```bash
docker compose -f docker-compose.vps.yml logs omerta-core-server
curl http://127.0.0.1/health
```

Dashboard login fungerar inte:

```bash
cat creator-initial-password.txt
grep CREATOR_EMAIL .env
docker compose -f docker-compose.vps.yml logs omerta-core-server
```
