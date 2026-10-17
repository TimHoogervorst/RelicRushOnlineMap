# 06 — Edit individual blocks with a block palette

Status: blocked

## What to build

Add block selection and a contextual inspector/palette, writing actual geometry through the shared save/render workflow rather than painting output pixels.

User story: The owner can make small geometry corrections directly in the map.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Select a block and display its section/local X/Y/Z, block ID and state. Add, replace or delete using a searchable/openable palette with drag placement.
- [ ] Edit valid block-state properties including stair orientation and slab half; preserve or clear block-entity data as appropriate when replacing a block.
- [ ] Persist affected palette chunks transactionally, including negative coordinates and expansion beyond imported bounds. Never renormalize the section origin.
- [ ] Regenerate affected floor images and height shading on save; visitors see the edited geometry after refresh. Invalid states or failed rendering preserve previous output.
- [ ] Support session undo/redo as further saves, including correct geometry and rendered results after reload.
- [ ] Demonstrate a stair/slab adjustment and decoration removal on the real fixture; test chunk round trips, source independence, coordinate stability and rejected unauthorized edits.

## Blocked by

- [04 — Keep saves consistent during rendering and failures](04-reliable-save-and-refresh.md)

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

