# 02 — Unlock editing and configure Minecraft assets

Status: blocked

## What to build

Add the small Edit/login control and shared left sidebar mode switch, plus authenticated vanilla client-JAR setup. The map remains usable anonymously. Implement access boundaries before introducing arbitrary imports or mutations.

User story: The owner can log in, open editing tools, and supply persistent rendering assets.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Use the seeded local password relic-local with EDITOR_PASSWORD override, server validation, expiring unpredictable sessions, HttpOnly/SameSite cookies, logout, login throttling, and appropriate HTTPS/proxy settings.
- [ ] Editing replaces the collapsible legend sidebar with tools and restores it on exit without moving the map. The sidebar has an always-reachable reopen control.
- [ ] Import a client JAR through authenticated setup, persist extracted models/textures and version/hash metadata, and render the saved map with these assets without depending on the original upload.
- [ ] Validate archive paths and compressed/decompressed size limits; clean temporary uploads. Missing or incompatible assets produce actionable errors and preserve existing output.
- [ ] Unauthenticated mutation, import, setup, generation, project-data, and backup requests are denied; enforce this centrally and apply it to every later ticket. Reject cross-origin cookie-authenticated mutations.
- [ ] Passwords and sessions are excluded from public responses, frontend bundles, and logs. Verify login/logout, direct unauthorized requests, throttle behavior, and restart persistence.

## Blocked by

- [01 — Render the real starting map in Docker](01-render-starting-map-in-docker.md)

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

