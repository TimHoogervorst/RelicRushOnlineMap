# 15 — Verify the complete Docker workflow and document operation

Status: in progress

## What to build

Complete the first-release journey across the implemented slices. Close integration gaps in real use; this ticket is not a substitute for each feature's own tests or working UI.

User story: The owner can start locally, maintain the dungeon and move it to a server using documented steps.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] From an empty volume, Compose opens the real seeded map and never overwrites existing work on rebuild. Verify persistent assets, data, health checks and password override.
- [ ] Exercise login, import, block edits, selection heights, section movement, labels, dotted connections, custom types, stairs, save/refresh, failure recovery and full backup/restore as a single browser journey.
- [ ] Check public narrow-screen drawer, touch pan/pinch, fit-floor, keyboard labels, contrast and persistent sidebar controls; editor tools remain desktop-focused and preserve map position.
- [ ] Inspect the real rendered starting map for paths, walls, height changes, water and partial blocks. Synthetic floors remain test-only.
- [ ] Document asset setup, initial password, adding floors/sections, edits, save status, limits, backup/migration, and HTTPS reverse-proxy setup with explicit trust settings. No external hosting provisioning is required.
- [ ] Run relevant unit/integration/browser and Docker checks; record actual commands/results and remaining limitations. Confirm no draft/publish workflow, separate local tool, leaked private data or source-schematic dependency was introduced.

## Blocked by

- [14 — Download, restore and recover a complete map project](14-portable-backup-and-recovery.md)

## Handoff

- Added [Operations](../operations.md) covering startup, password override, asset persistence, floor/section imports, edits and save state, current input/render/backup limits, backup/restore and migration, and HTTPS proxy trust/cookie settings.
- Compose now forwards `TRUST_PROXY` and `COOKIE_SECURE`; `.env.example` documents both. Port 3000 remains localhost-only.
- Added `tests/release-journey.test.js`, which starts from an empty temporary data directory, seeds the supplied real schematic, checks seed idempotence and anonymous read, imports into existing/new floors, edits block geometry and section placement, moves a block selection vertically and checks height-range metadata, creates a custom marker type, markers, reciprocal stairs and a dotted connection, checks save status and visitor image/manifest refresh, exports a full archive, and restores into a second empty directory. It checks source upload cleanup and scans public output and extracted backup entries for the private password/source filename.
- Found and fixed a public drawer gap while using narrow Chrome: the visitor legend did not have a close button, and its reopen button was nested inside the hidden sidebar. The close control is now shared by visitor/editor views and the reopen control is outside the drawer. The mobile toolbar hides redundant zoom buttons to leave room for Fit floor and Edit.
- Verification on the host: `npm.cmd run typecheck` passed; `npm.cmd test` passed (67 tests); `docker compose config` passed and showed localhost binding plus the two proxy variables. Host service smoke with the local 26.3 JAR (`DATA_DIR=%TEMP%\rr-release-browser-smoke`, port 3127) returned `/health` 200, `/api/status` with `mapAvailable: true`, and a public manifest/image. Headless Chrome at 390×844 verified two-pointer pinch zoom, one-finger pan, and wheel zoom through CDP. The real map screenshot showed textured paths/walls, local elevation shading, and magenta unsupported-block diagnostics; this visual check does not prove every water or partial block surface is rendered correctly. On narrow width the legend starts closed with an external reopen control, leaving the map visible; drawer button operation, Fit floor activation, and editor map-position preservation were not verified.
- Docker acceptance remains open: `docker version` sees client 29.5.3 but cannot connect to the Engine (`permission denied` on `npipe:////./pipe/docker_engine`). No Compose container, volume-rebuild persistence, in-container health check, or Docker password override was exercised. Chrome was headless; keyboard navigation, drawer close/reopen interaction, Fit floor operation, and editor map-position preservation were not verified. Keep this ticket in progress until those environment-dependent checks are completed.
- The implementation currently uses static HTML/CSS/JavaScript with custom image-coordinate interactions and Express. The spec's proposed React/Vite, Leaflet, and Fastify stack was not adopted. Coordinate conversion is encapsulated in the viewer, but this remains an explicit architecture deviation from the spec.
- No external hosting resources were provisioned. No separate local authoring tool or draft/publish workflow was introduced; schematic upload files are removed after import, and backups do not contain the password or source schematic.

