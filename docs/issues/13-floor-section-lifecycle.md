# 13 — Manage floors and sections without dangling references

Status: in progress

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

Implemented protected, revisioned API operations for floor/section rename and ordering, section ownership changes, dependency listing, and floor/section deletion. Section deletion returns marker/connection/stair dependents until the caller supplies an explicit marker delete/reassign choice and the complete connection deletion list; all relationship cleanup and row deletion run in one SQLite transaction. Stable IDs are retained on rename, reorder, and reassignment. Floor 0 and the starting section are protected. Section moves reject existing same-floor dotted links and stair links that would become same-floor. Floor removal either requires an empty floor or a destination floor and validates its section/stair/connection topology. Lifecycle controls are available in the authenticated editor. Metadata saves now carry floor name/order and section order into visitor manifests.

Verification: `npm test` (60/60 passed); `npm run typecheck` passed. New tests cover stale revisions, both connection constraints, dependency reporting, failed reassignment rollback, built-in protection, authenticated API access, visitor manifest refresh after rename, and delete/undo restoration.

Undo/redo is session scoped, bounded to ten lifecycle commands, revision checked, and restores floors, sections, markers, stair links, connections, chunks, and render settings transactionally. Undo and redo create new generated visitor revisions. Restored legacy references are exposed in authenticated project metadata as `unresolvedRecords`; visitor stair navigation reports missing or incompatible destinations without throwing. Browser interaction and Docker acceptance remain open, so the ticket stays in progress.

