# 07 — Move block selections and inspect lower heights

Status: blocked

## What to build

Extend block editing with multiple selection, a visible-height slice slider, and atomic vertical moves using Alt + wheel.

User story: The owner can adjust several blocks together and reach geometry hidden beneath upper blocks.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Select a block group with clear selection bounds and inspect its elevation; a height slider hides geometry above the chosen slice without deleting or changing it.
- [ ] Ordinary wheel zooms; Alt + wheel proposes whole-block vertical moves. Show the proposed placement before commit and keep controls discoverable.
- [ ] Preserve relative positions within a selection; reject collisions with occupied cells outside it. Treat original selected cells correctly when source/destination overlap.
- [ ] Move all affected chunks atomically, supporting chunk boundaries and negative Y. Update relevant block-entity positions.
- [ ] Undo/redo one group move as one action; failed operations leave geometry unchanged. Saved results regenerate and survive reopen.
- [ ] Verify multi-block selection and moves, hidden-layer selection, collision rejection, out-of-bounds extension and unchanged section/marker anchors.

## Blocked by

- [06 — Edit individual blocks with a block palette](06-single-block-editing.md)

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

