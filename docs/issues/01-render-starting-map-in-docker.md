# 01 — Render the real starting map in Docker

Status: in progress

## What to build

Deliver the first working path from the real Litematic fixture through project storage and rendering to a browser map served by one Docker service. Establish the TypeScript application and persistent volume only as needed for this path. This is the rendering feasibility gate for all later work, not a standalone scaffolding task.

User story: A visitor can open the supplied starting area as a textured overhead map.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Decode the supplied starting fixture as Litematic v7/subversion 1, data version 5023; verify 67 × 13 × 49 dimensions, negative Y extent, 3,484 non-air blocks, and normalized chest coordinates (61,9,34) and (27,10,8). Test packed indices crossing long boundaries and region normalization.
- [ ] Persist an imported initial project with stable section-local coordinates and versioned 16³ compressed palette chunks in SQLite. Seed only an empty volume; never overwrite existing data.
- [ ] Use explicitly supplied matching Minecraft assets; evaluate Deepslate behind an adapter and pin the verified dependency. Render true orthographic PNG plus bounds/height metadata inside Docker, including any required headless graphics dependencies.
- [ ] Display the real map with basic pan/zoom and fit-floor. Materials, stairs/slabs, water, decorations, wall edges, and local height changes are visually inspected; document special-block fallbacks and unsupported-block diagnostics.
- [ ] Keep rendering off the HTTP request event loop. Compose starts one service with a health endpoint and persistent data; existing output remains viewable if rendering assets are unavailable.
- [ ] Record the chosen renderer and coordinate/storage/manifest contracts in repository documentation so downstream agents can implement against them. A flat-color stand-in or mocked map does not satisfy this gate.

## Blocked by

None - can start immediately.

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

