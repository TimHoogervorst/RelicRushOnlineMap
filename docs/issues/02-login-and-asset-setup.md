# 02 — Unlock editing and configure Minecraft assets

Status: in progress

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

Integrated from ticket commits `b275851` and `07a77bb`. Implemented server-side password login, expiring random HttpOnly/SameSite sessions, logout, login throttling, same-origin checks, namespace protection, the Edit/sidebar mode switch, authenticated client-JAR upload, bounded asset extraction in a worker, version/hash metadata, and temporary-upload cleanup. Failed/incompatible setup preserves the previously configured assets.

**Verified on the host:** `npm.cmd test` (14/14) and `npm.cmd run typecheck`. Focused tests cover session expiry/cookies, throttling, cross-origin rejection, unauthenticated API boundaries, archive traversal/duplicates and compressed/expanded limits, successful version validation, prior-output preservation, and concurrent setup rejection.

**Still open:** browser interaction and asset persistence through a service restart have not been exercised. Docker Engine is currently unreachable (`docker info` reports access denied on `//./pipe/docker_engine`), so Docker runtime acceptance is unverified. Ticket 01 also remains in progress. Keep this ticket **in progress** until the remaining runtime/browser checks are recorded.

