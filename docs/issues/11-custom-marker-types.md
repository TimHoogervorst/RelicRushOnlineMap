# 11 — Create and maintain custom marker types

Status: blocked

## What to build

Provide marker-type management in the authenticated sidebar and connect custom types to marker editing, icons and legend groups.

User story: The owner can organize new kinds of points of interest without changing code.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Create a type with stable ID, display name, color and bundled icon; validate inputs and persist through Save/autosave without terrain rendering.
- [ ] Use custom types in marker forms and automatically group their markers under the current-floor legend heading.
- [ ] Rename/restyle a type without changing membership. Preserve built-in types; only built-in stairs have navigation behavior.
- [ ] Deleting a populated custom type requires choosing a replacement and atomically moving its markers. Reassignment to stairs creates unlinked stair markers.
- [ ] Keep saved visitor data, filtering and icons consistent after refresh; handle filter preferences for deleted IDs.
- [ ] Test unauthorized mutations, replacement validation, failed saves, session undo/redo and restart persistence.

## Blocked by

- [05 — Place markers and browse a grouped legend](05-markers-and-grouped-legend.md)

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

