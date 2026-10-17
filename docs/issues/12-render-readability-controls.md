# 12 — Refine map readability with cutaways and resource packs

Status: in progress

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

Implementation in progress on `ticket/12-render-readability-controls`:

- Persisted section-local cutaway boxes and excluded namespaced block IDs in SQLite. Render jobs filter a copied floor snapshot by each block's section-local coordinates, retaining stored geometry and block entities.
- Added editor controls to add/edit/remove cutaway rows, edit exclusions, and tune global pixel scale (4 to 32) and height shading (0 to 0.05). Settings edits save and regenerate floor output with session undo/redo.
- Added optional authenticated resource-pack ZIP upload. Entries are bounded (128 MiB compressed, 16 MiB each, 256 MiB expanded, 100,000 entries), reject duplicate/traversal paths, require `pack.mcmeta`, and are staged/atomically swapped. The renderer checks the pack before vanilla blockstates/models/textures; metadata includes pack format, description, source name, SHA-256 and entry count and appears in the visitor manifest.
- Rendering rejects images over 8,000,000 pixels before allocating raster buffers (about 64 MiB for the two main buffers). Pixel scale and shading are validated. Tinted model faces use deterministic default biome colors; animation uses the source PNG's first frame. Actual biome sampling remains unavailable.
- Focused tests cover settings validation and reopen, immutable geometry snapshots, auth, undo/redo, resource-pack layering/hash/restart/path safety, render dimension limits, and pack replacement preservation. `npm test` and `npm run typecheck` pass on this branch.

The real supplied fixture was rendered locally at 16 pixels per block, then compared against a section cutaway and a resource-pack texture override (a temporary recolored copy of the Minecraft block textures). Both variations rendered with the expected visual change. Docker acceptance remains open because Docker Engine is unavailable in this environment; browser interaction has not been smoke-tested. No storage/coordinate contract change; `section_render_settings` and project `render_options` are additive SQLite state.

