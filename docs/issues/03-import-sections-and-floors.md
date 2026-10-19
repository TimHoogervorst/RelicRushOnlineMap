# 03 — Import a schematic into a saved floor and section

Status: in progress

## What to build

Create the browser workflow to import a Litematic, select or create its floor and section, and save a map visitors can open. Establish Save/autosave with automatic generation and immutable output revisions; later tickets reuse this path.

User story: The owner can add dungeon areas without retaining their source schematic.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Import into independent project geometry, preserving block states and rendering-relevant block entities. Source files remain unchanged and can be removed after import.
- [ ] Support negative region sizes, multiple regions and packed palette data; reject malformed files, unsupported formats and conflicting occupied region placements with useful diagnostics.
- [ ] Create stable floor/section IDs, names, ordering, placement offsets and local label anchors. Normalize only on import; later bounds changes never shift existing local coordinates.
- [ ] Save/autosave automatically render the affected floor from a consistent snapshot and show progress. Saved means matching project data and visitor output are ready; failure preserves the previous map and retryable edits.
- [ ] Visitors can select a floor, see all its sections and labels, and fit its bounds. Refresh after success loads the new revision using revalidated manifests and revisioned image URLs.
- [ ] Reopen after restart without the source schematic, and validate imported chunks including negative coordinates. Apply explicit size/resource limits and clear failure cleanup.

## Blocked by

- [02 — Unlock editing and configure Minecraft assets](02-login-and-asset-setup.md)

## Handoff

Implemented authenticated one-time Litematic upload at `POST /api/project/import`, floor listing, section assignment to an existing floor or creation of a new floor, and persistent floor/section IDs with normalized section bounds and local label anchors. Upload bytes are written with restrictive permissions and removed on success or failure. The project import combines decoded regions in their common schematic coordinate frame, preserving their relative offsets, block states, and block entities. Identical occupied cells are deduplicated; conflicting block states reject the whole transaction with region and cell details. Air is omitted by the decoder and cannot erase neighboring geometry. Chunk reads persist independently of the uploaded source.

Verification: `npm.cmd test` (17/17) and `npm.cmd run typecheck`. Coverage includes the real fixture through authenticated HTTP import, authentication boundary, temp upload cleanup, reopen from SQLite, negative chunk coordinates, multi-region offsets/entities, and conflicting placement rollback.

Remaining: imported project geometry is not yet wired to floor-specific public manifests/images or the Save/autosave render workflow; the current viewer and startup render still expose the seeded floor. That work depends on the project generation/save path and should be completed with tickets 04 and the floor-viewer integration. Browser interaction and Docker runtime checks were not run.

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

