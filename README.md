# RR-Map

Single-service Docker application for viewing and authoring the Relic Rush dungeon map. The first slice imports the supplied `Start 0F.litematic` into editable SQLite section chunks and renders its real Minecraft block models from the matching client assets.

## Project documentation

- [Implementation spec](docs/implementation-spec.md) — proposed final scope, generation pipeline, architecture, and acceptance checks.
- [Agreed interview decisions](docs/design-decisions.md)
- [Domain glossary](GLOSSARY.md)
- [Implementation tickets and fresh-session handoff](docs/issues/README.md)

## Run locally

1. Provide the matching Minecraft 26.3 client JAR at `assets/minecraft-client.jar` (world version 5023). The application extracts only blockstates, block models, and block textures into the persistent data volume. The client JAR is not copied into the image or committed.
2. Copy `.env.example` to `.env` and change the editor password before authoring features are enabled.
3. Run `docker compose up --build` and open <http://localhost:3000>.

Compose publishes only on localhost. For remote use, place it behind an HTTPS reverse proxy; do not publish port 3000 directly to the internet. `/health` reports service initialization, while `/api/map/manifest` reports when a generated public map is available. A missing asset JAR leaves the service running with a clear unavailable state; adding it and restarting allows the initial render. Existing releases remain available without render assets.

Project SQLite state and immutable render releases live in the named `map-data` volume. The first run seeds Floor 0 and the Starting Area only when the database has no sections. Rebuilding the container or restarting the service does not replace existing project geometry. The imported schematic remains source provenance only after seeding; generation reads persisted chunks.

For host development, use Node.js 22 LTS and run `npm ci`, then `npm run typecheck`, `npm test`, and `npm start`. The typed renderer contract is in `src/renderer-adapter.ts`; Node 22's type stripping executes that narrow boundary while the worker and raster backend remain JavaScript. Set `DATA_DIR`, `MINECRAFT_CLIENT_JAR`, or `MINECRAFT_ASSETS` to use alternate locations. The initial import and rendering run in a worker thread, outside HTTP request handling.

## Rendering and coordinate contract

- Stored block and marker coordinates are section-local integer `(x, y, z)` coordinates. Image rows are reversed Z, but this transform stays inside the renderer/viewer and is never stored in project data.
- A section is split into 16³ chunks. Chunk coordinates use `floor(position / 16)`, including negative values. Each gzip payload is JSON version 1 with `minecraft:air` at palette index zero and exactly 4,096 palette indices in X-fastest, then Z, then Y order: `(y * 16 + z) * 16 + x`.
- The release manifest declares `projection: orthographic-xz`, image pixels and dimensions, floor/section identity, vertical bounds, materials, unsupported-block diagnostics, source asset version, and project revision. PNGs and manifests are written to a new immutable release before `current.json` is changed.
- Deepslate is pinned at 0.27.2 and was evaluated as the geometry engine. Its `StructureRenderer` defaults to perspective projection and requires a WebGL context; this service needs deterministic orthographic output in a headless container. The selected adapter rasterizes the matching client model JSON's actual top-face element geometry and samples the referenced block textures, preserving stairs, slabs, cutouts, and height changes in the overhead projection without a graphics driver. It shades by height and emits diagnostics for blocks with no renderable top surface. Full side faces and biome-dependent tint are not part of this initial overhead projection.

## Checks and current gates

`npm test` checks packed indices crossing long boundaries, the real fixture version/dimensions/non-air count/chest positions, one-time SQLite seeding, and compressed chunk round trips at negative chunk coordinates. The exact local 26.3 client JAR is independently validated against `version.json` (`id=26.3`, `world_version=5023`) before assets are extracted.

The supplied fixture has one section with dimensions 67 × 13 × 49, signed Y extent −13, and 3,484 non-air blocks. Its normalized chest block coordinates are `(61,9,34)` and `(27,10,8)`.

Docker startup and browser visual acceptance still need to be run on a host with Docker available. Review the generated PNG at 1:1 pixel scale for the supplied area before treating the rendering gate as visually accepted.
