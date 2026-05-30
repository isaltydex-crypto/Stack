# Omerta Changelog

## v3.0.1 — Omerta Logo Consistency Hotfix

- Rebuilt the Omerta app icon to better match the selected reference: controlled circular dotted ring, black background, clear center hole and subtle asymmetric brightness.
- Updated launcher foreground and splash mark from the same generated logo source.
- Changed in-app `BrandMark()` to use the same Omerta splash mark resource, so the logo is consistent across launcher, splash and app UI.
- Kept app name as Omerta and preserved internal package/API names to avoid breaking backend connections.

## v3.0 — Omerta Identity / UI Refresh

- Updated Android app display name to **Omerta**.
- Added Omerta-style dotted ring app icon based on the first icon option in the provided sketch.
- Added Omerta splash background with dotted ring mark and wordmark.
- Updated app theme palette to a darker black/charcoal/graphite style with subtle accent use.
- Reworked in-app branding from legacy labels to Omerta wordmark and Private Network subtitle.
- Replaced the simple BN brand mark with a dotted circular particle mark drawn in Compose.
- Adjusted chat bubbles, header, profile avatars and controls to better match the provided dark private messenger design direction.
- Kept the package name and internal project naming as Omerta now to avoid breaking backend/API references.

## v2.9 — App ↔ VPS Bridge

- Combined the latest Android app base with the cleaned server/dashboard VPS base.
- Added the v2.9 package direction: release-mode app should point at the VPS API while debug-mode can remain mock/local.
- Kept the cleaned dashboard/server structure from v2.8.7.
- Kept one central changelog instead of separate release note files.
- Prepared the package for the next implementation pass: invite-code login, nick-on-first-login, admin invite creation from app, server command polling and relay-backed DM/notes.

This file is the single place for project changes. Do not create a new release-notes file for every version. Add new entries at the top under the next version heading.

## v2.9 — App ↔ VPS Bridge (in progress)

- Merged the latest clean server/dashboard base with the latest Android app codebase.
- Direction: connect Android release builds to the VPS API instead of the local/mock bridge.
- Planned first bridge scope: invite activation, nick setup, admin invite creation/share, users/groups/notes runtime endpoints, encrypted relay, wipe command polling, and release check against VPS.
- Keep debug mode on local/mock bridge so UI testing remains possible without a live server.
- Continue writing all project changes in this changelog rather than creating per-version release files.

## v2.8.7 — Project Cleanup

- Cleaned server/dashboard package structure.
- Removed old per-version release note files.
- Removed stale Android/app-only documentation from the server/dashboard package.
- Removed generated `tsconfig.tsbuildinfo` from the dashboard package.
- Added `docs/CHANGELOG.md` as the single source for future changes.
- Added `docs/PROJECT_STRUCTURE.md` to explain the current package layout.
- Added `.gitignore` for safe GitHub usage.
- Kept only deployment, server, dashboard, security, architecture and operations documentation.

## v2.8.6 — Dashboard Functional Cleanup

- Cleaned up Creator Dashboard scope.
- Create container/workspace action now has loading, success and error feedback.
- Duplicate container/workspace names return a clear conflict message instead of failing silently.
- Container/workspace creation can generate an initial admin invite.
- Removed duplicate overview cards.
- Fixed overview active sessions stat.
- Removed stale recovery/device-migration references from dashboard settings.
- Renamed/clarified current container behavior: it registers a Omerta workspace/environment in the database; it does not yet provision a separate Docker runtime per customer.
- Added `apply-dashboard-cleanup.sh` to apply the update while keeping `.env` and database volumes.

## v2.8.5 — Server/Dashboard VPS Fixes

- Removed lockfiles that could point to internal/non-public registries.
- Added `.npmrc` files forcing `https://registry.npmjs.org/`.
- Added `.dockerignore` files.
- Switched server/dashboard Docker builds to `node:20-bookworm-slim`.
- Dashboard production runtime uses nginx.
- Server Docker build includes native build dependencies needed by packages such as `argon2`.
- Deploy script now sets the expected env names for creator password, cookie secret, dashboard origin and public websocket URL.

## v2.8.4 — Deployable Server Package

- Added server/dashboard-only package without Android app code.
- Added simple deploy script for VPS deployment.
- Included `omerta-core-server`, `omerta-creator-dashboard`, Docker compose files, nginx configs, scripts and docs.

## v2.8.x — VPS Deploy Bridge

- Added VPS-ready Docker Compose.
- Added nginx HTTP config for first deployment via VPS IP.
- Added HTTPS template for later domain/certificate setup.
- Added VPS scripts for init/start/stop/logs/update/smoke-test.
- Added bootstrap/deploy documentation.
- Added short-lived encrypted relay queue direction for messages/notes.

## v2.7.x — App/UI Direction and Wipe Engine

- Moved toward a discreet dark messenger UI.
- DMs and Groups restored as separate tabs.
- Added tab icons.
- Added DM settings wipe controls.
- Added separate App Wipe PIN and Phone Wipe PIN rules.
- Admin app wipe does not require PIN; admin phone wipe requires Phone Wipe PIN.
- Added FMD-style remote wipe concept using Android DevicePolicyManager, without copying FMD code.
- Removed recovery UI from app direction.

## v2.6 — Privacy-Preserving Hardening

- Runtime/hardening reporting is aggregate-only.
- Dashboard does not expose root/debug/tamper status per user/device.
- Removed sensitive runtime data such as device model, hardware fingerprint, IP, root app list and precise user-device mapping.
- Added privacy-focused audit/logging direction.

## v2.5 — Release Pipeline and Remote Updates

- Added release policy endpoints and dashboard tab.
- Added force update, maintenance mode, global kill switch and minimum app version policy.
- Added app-side release enforcement direction.

## v2.4.x — E2EE Foundation and Local-Only Data Direction

- Added E2EE foundation for messages, notes and group messages.
- Added device key concepts and group key rotation direction.
- Added note conflict/version guard direction.
- Later changed direction so messages/notes should not be permanent server history; server should act as control-plane and short-lived encrypted relay.

## v2.3 and earlier — Core Auth / Control Base

- Added core auth server, creator dashboard, audit logs, device/session concepts, wipe PIN gate and initial deployment structure.
