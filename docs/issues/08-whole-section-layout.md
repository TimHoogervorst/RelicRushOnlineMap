# 08 — Arrange entire sections with their markers and labels

Status: blocked

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

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

