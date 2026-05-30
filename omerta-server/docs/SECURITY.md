# Security Notes

## Creator Dashboard

Recommended deployment:

```text
WireGuard VPN
→ Nginx allowlist for VPN CIDR
→ Creator Dashboard
→ Creator API
```

Do not expose the dashboard publicly.

## Invite codes

Invite codes are stored as SHA-256 hashes and returned only once when created.
They are marked used during activation.

## Sessions

Refresh tokens are Argon2id hashed in the database.
Access tokens are short-lived.

## E2EE

The server is designed to route encrypted payloads and store public identity keys only.
Private keys must remain on the device.
