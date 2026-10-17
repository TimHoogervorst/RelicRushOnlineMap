# 13 — Manage floors and sections without dangling references

Status: blocked

## What to build

Complete floor/section management around rename, reorder, reassignment and deletion, with explicit handling of dependent markers and both connection types.

User story: The owner can reorganize or remove areas without silently losing markers or breaking connections.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Rename/reorder floors and sections without changing stable IDs or marker ownership; reflect changes in selectors, labels and legend grouping.
- [ ] Reassign a section only when section connections and stair links remain valid, otherwise require relink/removal first.
- [ ] Before deletion, show dependent markers/connections and require explicit reassignment or confirmed deletion. Apply resolutions atomically.
- [ ] Retain/report unresolved records from incompatible restored or older data rather than silently discarding them; visitor destinations fail gracefully.
- [ ] Use shared Save/autosave and appropriate generation; retry/undo behavior preserves integrity.
- [ ] Verify protected built-ins, same-floor dotted links, different-floor stairs, ownership conversion, deletion rollback and visitor refresh.

## Blocked by

- [09 — Draw dotted connections between section entrances](09-dotted-section-connections.md)
- [10 — Connect stair markers and navigate between floors](10-stair-floor-navigation.md)
- [11 — Create and maintain custom marker types](11-custom-marker-types.md)

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

