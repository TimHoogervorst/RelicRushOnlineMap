# 12 — Refine map readability with cutaways and resource packs

Status: blocked

## What to build

Expose section cutaways/block exclusions and render controls, plus optional resource-pack override assets, through the integrated editor.

User story: The owner can expose obscured paths and tune map appearance without changing source schematics.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Create/edit/remove section-local cutaway boxes and excluded block-name settings; apply before rendering so underlying geometry appears without deleting stored blocks.
- [ ] Layer a resource pack over the vanilla asset set with validated paths, size limits, version/hash tracking and clear missing/unsupported asset diagnostics.
- [ ] Adjust documented pixel scale and restrained height shading; preserve true overhead geometry, texture alpha, first animation frames and consistent biome tint.
- [ ] Save automatically regenerates affected floors and reports failure without replacing previous output. Persist settings and assets across restarts.
- [ ] Declare tested rendering size/memory limits; reject over-limit jobs clearly instead of producing partial maps.
- [ ] Visually compare the actual fixture before/after a cutaway and asset override; test no source/geometry mutation, deterministic settings, authorization and undo/redo.

## Blocked by

- [06 — Edit individual blocks with a block palette](06-single-block-editing.md)

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

