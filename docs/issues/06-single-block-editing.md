# 06 — Edit individual blocks with a block palette

Status: in progress

## What to build

Add block selection and a contextual inspector/palette, writing actual geometry through the shared save/render workflow rather than painting output pixels.

User story: The owner can make small geometry corrections directly in the map.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [x] Select a block and display its section/local X/Y/Z, block ID and state. Add, replace or delete using a searchable/openable palette with drag placement.
- [x] Edit valid block-state properties including stair orientation and slab half; preserve block-entity data when keeping the block identity and clear it when replacing/removing the owner.
- [x] Persist affected palette chunks transactionally, including negative coordinates and expansion beyond imported bounds. Never renormalize the section origin.
- [x] Regenerate floor images and height shading through the shared SaveQueue; visitors receive a new revision on refresh. Invalid property combinations are rejected; render failure leaves the previous public pointer intact and the geometry available for retry.
- [x] Support per-login session undo/redo as further geometry saves, including correct block entity/chunk restoration.
- [x] Exercise a real fixture slab adjustment and decoration removal; test chunk round trips, input source independence, coordinate stability, render failure/retry and rejected unauthorized edits.

## Blocked by

- [04 — Keep saves consistent during rendering and failures](04-reliable-save-and-refresh.md)

## Handoff

Implemented `/api/project/block-palette`, `/api/project/sections/:id/blocks`, and revisioned `POST /api/project/blocks` plus per-session undo/redo routes. The sidebar palette searches Minecraft blockstate assets, exposes allowed properties as selectors, supports click-to-inspect and drag-to-place, and displays section-local coordinates/state. Edits update the 16³ compressed palette chunk and project revision in one SQLite transaction, then regenerate all floor output using the existing generation queue. The floor display frame expands around negative and out-of-import geometry while stored section placement/origin stays unchanged. Existing block entity payloads stay attached when the block identity remains; replacement/deletion clears them. Undo/redo commands retain block entity payloads so restored saves are complete.

Verification: `npm.cmd test` (30/30 passed); `npm.cmd run typecheck` (passed); `node --check public/viewer.js` (passed). Added real-fixture tests that toggle a slab's `type` and remove decoration without modifying the source Litematic, negative-coordinate chunk round trips, palette state validation, unauthorized-write rejection, revisioned save and undo/redo/re-render, plus injected render failure proving the last public revision remains served until retry.

Remaining: browser pointer/drag interaction and visual review, Docker acceptance, plus manual block-entity and stair/slab UI exercise were not run in this environment. The tests demonstrate the actual fixture data path and renderer-save contract, but are not a substitute for opening the palette in a browser. Keep this ticket in progress until those gates pass.

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

