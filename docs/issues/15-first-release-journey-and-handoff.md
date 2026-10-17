# 15 — Verify the complete Docker workflow and document operation

Status: blocked

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

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

