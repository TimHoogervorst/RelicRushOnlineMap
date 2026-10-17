# RR-Map

Single-service Docker application for viewing and authoring the Relic Rush dungeon map. It imports schematics into editable SQLite section chunks, renders floor maps from matching Minecraft models and textures, and supports markers, block edits, section layout, links, and project backup/restore.

## Project documentation

- [Implementation spec](docs/implementation-spec.md) — proposed final scope, generation pipeline, architecture, and acceptance checks.
- [Agreed interview decisions](docs/design-decisions.md)
- [Domain glossary](GLOSSARY.md)
- [Implementation tickets and fresh-session handoff](docs/issues/README.md)

## Run locally

1. Copy `.env.example` to `.env`. `EDITOR_PASSWORD` defaults to `relic-local` for local testing; set a private value before hosting the app remotely.
2. Run `docker compose up --build` and open <http://localhost:3000>.
3. Select **Edit**, sign in with `EDITOR_PASSWORD`, choose the matching Minecraft 26.3 client JAR (world version 5023), and save assets. The JAR is written to a temporary private file, version checked, then removed. Only blockstates, block models, and block textures are stored in the persistent volume.

Compose publishes only on localhost. For remote use, place it behind an HTTPS reverse proxy; do not publish port 3000 directly to the internet. `/health` reports service initialization, while `/api/map/manifest` reports when a generated public map is available. A missing asset JAR leaves the service running with a clear unavailable state; adding it and restarting allows the initial render. Existing releases remain available without render assets.

The Edit button overlays a left sidebar without changing the map position. Close it with the visible reopen control; **Done editing** restores the public legend. Login sessions use a random eight-hour HttpOnly, SameSite=Lax cookie. Failed login attempts are limited per client IP. Cookie-authenticated writes and login/logout requests require a same-origin request. Uploads are capped at 128 MiB compressed, 16 MiB per extracted file, 512 MiB total extracted, and 100,000 selected ZIP entries. One asset setup may run at a time; concurrent uploads receive HTTP 409. Asset extraction runs in a worker thread, rejects duplicate/traversal paths, and removes the temporary JAR after success or failure. Set `TRUST_PROXY=true` only when the service is directly behind a trusted HTTPS-terminating proxy; this enables Express's single-hop forwarded protocol handling and Secure cookies. `COOKIE_SECURE=true` can force Secure cookies when TLS is terminated outside the configured proxy hop.

Project SQLite state and immutable render releases live in the named `map-data` volume. The first run seeds Floor 0 and the Starting Area only when the database has no sections. Rebuilding the container or restarting the service does not replace existing project geometry. The imported schematic remains source provenance only after seeding; generation reads persisted chunks.

For host development, use Node.js 22 LTS and run `npm ci`, then `npm run typecheck`, `npm test`, and `npm start`. The typed renderer contract is in `src/renderer-adapter.ts`; Node 22's type stripping executes that narrow boundary while the worker and raster backend remain JavaScript. Set `DATA_DIR`, `MINECRAFT_CLIENT_JAR`, or `MINECRAFT_ASSETS` to use alternate locations. The initial import and rendering run in a worker thread, outside HTTP request handling.

See [Operations](docs/operations.md) for persistent asset setup, adding floors and sections, editing and save behavior, supported limits, portable backup and restore, data-volume migration, and HTTPS reverse-proxy configuration. Compose passes `TRUST_PROXY` and `COOKIE_SECURE` through to the app.

## Rendering and coordinate contract

- Stored block and marker coordinates are section-local integer `(x, y, z)` coordinates. Image rows are reversed Z, but this transform stays inside the renderer/viewer and is never stored in project data.
- A section is split into 16³ chunks. Chunk coordinates use `floor(position / 16)`, including negative values. Each gzip payload is JSON version 1 with `minecraft:air` at palette index zero and exactly 4,096 palette indices in X-fastest, then Z, then Y order: `(y * 16 + z) * 16 + x`.
- Each immutable floor release contains a PNG, manifest, diagnostics, and a height grid with explicit `null` entries for empty cells. The manifest records `projection: orthographic-xz`, floor/section identity, image pixels and dimensions, vertical bounds, materials, unsupported-block diagnostics, source asset version, and project revision before `current.json` is changed.
- Deepslate is pinned at 0.27.2 and was evaluated as the geometry engine. Its `StructureRenderer` defaults to perspective projection and requires a WebGL context; this service needs deterministic orthographic output in a headless container. The selected adapter rasterizes the matching client model JSON's actual top-face element geometry and samples the referenced block textures, preserving stairs, slabs, cutouts, and height changes in the overhead projection without a graphics driver. It shades by height and emits diagnostics for blocks with no renderable top surface. Full side faces and biome-dependent tint are not part of this initial overhead projection.

## Checks and current gates

`npm test` checks packed indices crossing long boundaries, the real fixture version/dimensions/non-air count/chest positions, one-time SQLite seeding, and compressed chunk round trips at negative chunk coordinates. The exact local 26.3 client JAR is independently validated against `version.json` (`id=26.3`, `world_version=5023`) before assets are extracted.

The supplied fixture has one section with dimensions 67 × 13 × 49, signed Y extent −13, and 3,484 non-air blocks. Its normalized chest block coordinates are `(61,9,34)` and `(27,10,8)`.

Docker startup and browser visual acceptance still need to be run on a host with Docker available. Review the generated PNG at 1:1 pixel scale for the supplied area before treating the rendering gate as visually accepted.
