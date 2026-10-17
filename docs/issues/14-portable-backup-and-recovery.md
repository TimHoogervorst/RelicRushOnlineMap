# 14 — Download, restore and recover a complete map project

Status: in progress

## What to build

Provide authenticated full-project ZIP download/restore and bounded recovery snapshots covering all geometry, settings, assets and connection features.

User story: The owner can move the entire project between local and hosted Docker instances and recover mistakes.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Export a consistent SQLite snapshot plus referenced assets and generated map files with versioned manifest/checksums; include all IDs, chunk states, types and both connection kinds.
- [ ] Use a safe SQLite backup mechanism. Exclude passwords, sessions, temporary uploads and unfinished jobs.
- [ ] Validate archive paths, checksums, decoded limits, schema compatibility and all references before replacing anything. Invalid archives leave the existing project untouched.
- [ ] Require explicit restore confirmation, take a pre-restore backup and restore atomically with truthful progress/error UI.
- [ ] Retain five latest recovery snapshots with bounded cleanup that cannot remove active assets/output. Provide actionable backup/restore instructions.
- [ ] Restore to a fresh volume and verify geometry, section-relative anchors, resource packs, markers, links and anonymous map refresh. Test rollback and anonymous access denial.

## Blocked by

- [07 — Move block selections and inspect lower heights](07-selection-height-and-slices.md)
- [12 — Refine map readability with cutaways and resource packs](12-render-readability-controls.md)
- [13 — Manage floors and sections without dangling references](13-floor-section-lifecycle.md)

## Handoff

- Added `GET /api/backups/export`, authenticated recovery snapshot listing/download, and `POST /api/backups/restore`.
- The version 1 ZIP contains a SQLite Online Backup API snapshot, extracted Minecraft/resource-pack assets, every immutable release (including the active map and project snapshot), and a SHA-256/size manifest. Sessions, secrets, temporary uploads and `.building-*` jobs are excluded.
- ZIP paths, duplicates, symlinks, CRCs, decoded byte limits, manifest hashes, schema version, SQLite integrity/foreign keys, and release pointer/image references are checked before staging. Restore requires the exact `RESTORE PROJECT` confirmation, drains active authenticated project requests, stages on the data volume, makes a pre-restore recovery archive, then swaps the project database/assets/releases with rollback. If rollback itself cannot finish, it retains and reports the rollback directory.
- Recovery archives live under `/data/backups/recovery`; retention removes only snapshots older than the latest five. It does not clean the active asset or release directories.
- The editor exposes download, restore, progress/error status and recovery links, and gives local-to-Docker transfer instructions.
- Verification: `npm.cmd test -- --test-name-pattern="portable backup|corrupt archive|recovery keeps|backup archive|authenticated owner downloads"` (16 passing, 0 failing); `npm.cmd run typecheck` (pass). Includes authenticated API, unauthorized access, fresh-volume file/database restore, corrupted archive preservation and five-snapshot retention.
- Remaining acceptance gate: run the restore journey with Docker Engine/browser available and verify anonymous map refresh against the restored generated image. Contract: restore is a destructive, explicitly confirmed whole-project replacement; ZIP v1 is limited to 1 GiB compressed, 512 MiB per file and 2 GiB decoded.

