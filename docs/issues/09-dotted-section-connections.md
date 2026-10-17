# 09 — Draw dotted connections between section entrances

Status: blocked

## What to build

Add Connect sections: select an entrance in each of two sections, then display a persistent visual-only dotted line.

User story: Visitors can understand that sections separated in the displayed layout connect in the dungeon.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Create two local endpoint anchors on distinct sections of one floor. Resolve ambiguous overlapping sections explicitly; allow an optional plain-text label and multiple connections per section pair.
- [ ] Render straight dotted vector lines beneath markers with readable zoom behavior. Clicking lines does not navigate; include labels/endpoints in fit bounds.
- [ ] Select/relabel a connection, move an endpoint or delete it; save without terrain rendering and support undo/redo.
- [ ] Moving either section updates the line endpoints automatically after save and refresh without rewriting anchors.
- [ ] Validate same-floor/different-section membership and coordinates on the server, reject dangling endpoints, and prevent destructive section changes from invalidating existing lines.
- [ ] Verify multiple links, endpoint editing, non-navigation, persistence, authorized writes and transform correctness.

## Blocked by

- [08 — Arrange entire sections with their markers and labels](08-whole-section-layout.md)

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

