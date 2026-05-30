# Omerta v2 Architecture

Omerta v2 replaces IRC with a custom HTTPS + WebSocket backend.

## Components

- `omerta-app`: Android UI prototype + E2EE/WebSocket prep.
- `omerta-core-server`: invite-code flow, creator API, session bootstrap.
- `omerta-creator-dashboard`: VPN-only web dashboard.
- `docker`: reverse proxy and deployment scaffold.

## Security direction

- Invite codes are single use.
- Users choose nick after valid invite.
- Logout deletes the account/server session.
- DM payloads are routed encrypted.
- Creator dashboard is not exposed publicly; use WireGuard/IP allowlist.
- Remote app wipe and factory reset commands should be signed server-side before production.

## E2EE status

This build includes Crypto Layer v1 scaffolding. It is not production cryptography yet. Replace demo crypto helpers with `libsignal-client` sessions before real use.
