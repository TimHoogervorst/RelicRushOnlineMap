# 07 — Move block selections and inspect lower heights

Status: in progress

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

Implemented the following behavior:

- Shift-click toggles a multi-block selection, with a visible selection outline and selected Y range. The height slider requests a private rendered preview of blocks at or below its value; it filters only the preview snapshot and never changes project data. Clicking at a lower slice selects the top block at that slice, including blocks hidden by higher layers.
- Ordinary wheel zoom remains intact. Alt + wheel changes a whole-block vertical move proposal; the source selection, proposed Y range and preview outline stay visible until the owner commits or cancels.
- `POST /api/project/block-moves` moves a selection in one SQLite transaction/revision, allows destinations occupied by the selection itself, rejects outside collisions, relocates block entities, updates expanded bounds, and regenerates the saved floor. The operation is one undo/redo history command.
- Section placement and label anchors remain unchanged; marker coordinates remain section-local. The existing project database stores all moved geometry, so reopening reads the new chunk positions.

Verification on the ticket branch: `npm.cmd test` (35/35 passing), `npm.cmd run typecheck`, with focused fixture coverage for a real block entity and empty-above-cell move; storage tests cover negative Y, chunk edges, overlapping source/destination cells, collision rollback, and preserving anchors. Authenticated route tests cover slice preview without project mutation and move/save/undo/redo persistence.

The browser interaction and Docker Engine acceptance checks remain open, so this ticket stays in progress. No storage coordinate contract changed; the API adds the authenticated `/api/project/preview` GET and `/api/project/block-moves` POST endpoints.

