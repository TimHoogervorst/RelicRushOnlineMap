# 08 — Arrange entire sections with their markers and labels

Status: in progress

## What to build

Add floor-layout editing with whole-section drag snapping and numeric offsets. A section's displayed placement may differ from the dungeon layout; all local anchors must follow it.

User story: The owner can spread dungeon areas apart while preserving their points of interest.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Select an entire section, drag with whole-block snapping, and edit placement offsets. Preserve its ID, internal geometry and elevation during planar movement.
- [ ] Markers and labels move through section transforms, not by rewriting their local coordinates. Include an explicit local label-position control.
- [ ] Highlight conflicting occupied placements and reject committing them; allow empty overlap and identical blocks. Do not mutate source chunk coordinates.
- [ ] Saving automatically regenerates the affected floor and fit bounds; visitor refresh reflects the new layout and aligned marker positions.
- [ ] Support session undo/redo and stable coordinates when floor bounds expand or shrink.
- [ ] Test a nonzero-offset section with ordinary and stair markers, label placement, collision cases and restart. Provide transform hooks for upcoming connection endpoints.

## Blocked by

- [05 — Place markers and browse a grouped legend](05-markers-and-grouped-legend.md)

## Handoff

Implemented section placement fields were already present in SQLite; this slice now adds revisioned layout updates and undo/redo, an editor section selector with whole-block snapped dragging from the label handle, numeric floor placement offsets, and editable section-local label anchors. Section-local geometry and marker coordinates remain unchanged. Snapshot manifests transform blocks, markers, and labels through the section placement and a recomputed floor coordinate origin; consumers can use `sectionLocalToFloor` and `floorToSectionLocal` for future connection endpoints. Layout commits validate occupied cells server-side, highlight conflicts in the preview, reject different block states, and allow empty or identical-state overlap. Successful commits regenerate the floor release and update fit bounds.

Verification: `npm.cmd test` passes 39/39; `npm.cmd run typecheck` passes; `git diff --check` passes. Tests cover nonzero placement with chest and stairs anchors, local label edits, collision rollback and preview, empty/identical overlap, undo/redo, coordinate transform round trips, regenerated visitor manifests, and reopening after server restart.

Remaining acceptance gate: Docker Engine and an interactive browser session were unavailable during this slice, so the UI drag and real Docker runtime still need manual acceptance. No database schema migration was needed because placement and label columns were already included in the current integration base.

