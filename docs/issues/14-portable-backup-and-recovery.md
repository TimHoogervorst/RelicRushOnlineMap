# 14 — Download, restore and recover a complete map project

Status: blocked

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

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

