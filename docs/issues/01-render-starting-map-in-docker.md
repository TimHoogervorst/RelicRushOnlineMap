# 01 — Render the real starting map in Docker

Status: in progress

## What to build

Deliver the first working path from the real Litematic fixture through project storage and rendering to a browser map served by one Docker service. Establish the TypeScript application and persistent volume only as needed for this path. This is the rendering feasibility gate for all later work, not a standalone scaffolding task.

User story: A visitor can open the supplied starting area as a textured overhead map.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [x] Decode the supplied starting fixture as Litematic v7/subversion 1, data version 5023; verify 67 × 13 × 49 dimensions, negative Y extent, 3,484 non-air blocks, and normalized chest coordinates (61,9,34) and (27,10,8). Test packed indices crossing long boundaries and region normalization.
- [x] Persist an imported initial project with stable section-local coordinates and versioned 16³ compressed palette chunks in SQLite. Seed only an empty volume; never overwrite existing data.
- [ ] Use explicitly supplied matching Minecraft assets; evaluate Deepslate behind an adapter and pin the verified dependency. Render true orthographic PNG plus bounds/height metadata inside Docker, including any required headless graphics dependencies.
- [ ] Display the real map with basic pan/zoom and fit-floor. Materials, stairs/slabs, water, decorations, wall edges, and local height changes are visually inspected; document special-block fallbacks and unsupported-block diagnostics.
- [ ] Keep rendering off the HTTP request event loop. Compose starts one service with a health endpoint and persistent data; existing output remains viewable if rendering assets are unavailable.
- [x] Record the selected orthographic rasterizer and coordinate/storage/manifest contracts in repository documentation so downstream work can implement against them.

## Blocked by

None - can start immediately.

## Handoff

Implemented in integration commit `389e6f6`: bounded Litematic v7 decoder; one-time SQLite project seed; gzip-compressed, versioned 16³ chunks; matching Minecraft 26.3 asset extraction; orthographic top-face model rasterizer behind a TypeScript adapter; worker-thread generation; immutable release files; public manifest/image endpoints; basic pan/zoom/fit viewer; Dockerfile and Compose service.

**Verified on the host:** `npm test` (5/5), `npm run typecheck`, fixture dimensions/count/chest coordinates, packed indices crossing long boundaries, negative chunk round-trip, one-time persistence, exact asset version/hash extraction, 1,072 × 784 PNG generation, and `/health`, manifest, and image endpoints. The PNG was visually inspected. Unsupported blocks now render as a visible magenta cross and appear in the generation diagnostics.

**Still open:** Docker daemon access is denied in this environment, so Docker build/start and browser smoke remain unverified. Visual acceptance still needs review of transparent regions, height cues, and special-block fallbacks. The selected renderer projects textured top-face model geometry; it does not render full side faces or biome tint. Deepslate 0.27.2 is pinned and evaluated but is not the selected backend. Ticket remains **in progress** until these gates are resolved.

**Follow-up implementation:** the renderer now uses neighbor-relative local height shading, emits partial surface heights in a per-floor grid with explicit empty cells, and publishes the grid with the immutable release. Host fixture rendering was inspected; Docker visual acceptance and complete water/partial-surface review remain open.

