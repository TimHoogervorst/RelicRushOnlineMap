# 10 — Connect stair markers and navigate between floors

Status: blocked

## What to build

Link two existing stair markers transactionally and implement bidirectional navigation with destination highlighting.

User story: Visitors can follow stairs to the corresponding location on another floor.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Use an editor destination picker to link two distinct stairs on different floors; a stair belongs to at most one connection.
- [ ] Clicking a map stair switches floor and centers its current transformed destination, maintaining useful clamped zoom. The destination highlight remains visible even when its type is filtered.
- [ ] A legend stair entry centers it without navigating; editing mode selects it. Unlinked/missing destinations show a clear unavailable state.
- [ ] Delete or change the type of a linked stair only after confirmation; remove its connection transactionally and leave its partner unlinked.
- [ ] Rearranging a section preserves connections and resolves the destination at its new display position. Reject ownership/floor changes that would invalidate a link.
- [ ] Use clearly labeled synthetic second-floor fixtures in tests, not default visitor content. Verify both directions, save/reload, type-change cleanup and authorization.

## Blocked by

- [08 — Arrange entire sections with their markers and labels](08-whole-section-layout.md)

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

