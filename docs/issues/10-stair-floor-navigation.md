# 10 — Connect stair markers and navigate between floors

Status: in progress

## What to build

Link two existing stair markers transactionally and implement bidirectional navigation with destination highlighting.

User story: Visitors can follow stairs to the corresponding location on another floor.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [x] Use an editor destination picker to link two distinct stairs on different floors; a stair belongs to at most one connection.
- [x] Clicking a map stair switches floor and centers its current transformed destination, maintaining useful clamped zoom. The destination highlight remains visible even when its type is filtered.
- [x] A legend stair entry centers it without navigating; editing mode selects it. Unlinked/missing destinations show a clear unavailable state.
- [x] Delete or change the type of a linked stair only after confirmation; remove its connection transactionally and leave its partner unlinked.
- [x] Rearranging a section preserves connections and resolves the destination at its new display position. Reject ownership/floor changes that would invalidate a link.
- [x] Use clearly labeled synthetic second-floor fixtures in tests, not default visitor content. Verify both directions, save/reload, type-change cleanup and authorization.

## Blocked by

- [08 — Arrange entire sections with their markers and labels](08-whole-section-layout.md)

## Handoff

Implemented reciprocal destinations in the existing `markers.stair_destination_id` column; no schema migration was needed. Authenticated `/api/project/stairs` lists available destinations, `POST /api/project/stairs/link` atomically links a pair, and `DELETE /api/project/stairs/:id/link` unlinks both. Link and unlink advance the project revision and publish metadata without rerendering terrain. Marker type changes and deletion require explicit unlink confirmation. Stair identity remains stable when its section moves, so navigation resolves the destination's current floor position from the latest saved manifest. Cross-floor ownership moves are rejected while linked. Undo restores reciprocal links when available.

Verification: `npm.cmd test` (41/41 passed), `npm.cmd run typecheck` (passed), and `node --check public/viewer.js` (passed). The new `tests/stairs.test.js` uses explicitly named Synthetic Lower/Upper Test Floors to check authorization, one-to-one cross-floor links, transformed destinations after section movement, type-change cleanup/undo, delete cleanup, both manifest directions and service restart persistence. Browser interaction has not been exercised in this headless ticket run.

