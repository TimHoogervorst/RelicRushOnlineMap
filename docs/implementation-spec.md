# Relic dungeon map — implementation spec

Status: interview decisions consolidated, including whole-section movement and dotted section connections. One Docker app owns viewing, editing, imports, storage, and generation. Saving updates the public map; there is no separate preview or publish workflow. No application functionality has been implemented.

## Outcome

Build one Docker-hosted web application for viewing and authoring the Minecraft relic dungeon map. Import a schematic once into an editable map project, arrange sections on floors, refine blocks, and generate textured overhead map images. Visitors use the saved public map without logging in. The owner logs in to edit geometry, floors, sections, markers, and marker types. The same Docker application works locally and on a server; no separate local tool is required.

The first real source is `schematics/Start 0F.litematic`. The visual target is the supplied pixel-style overhead example: recognizable Minecraft materials, readable paths and walls, subtle height cues, and distinct marker icons. The initial implementation now includes a substantial integrated authoring workflow, not just a command-line converter. Plan staged integration with clear module boundaries suitable for multiple implementation agents.

Canonical domain terms are in [GLOSSARY.md](../GLOSSARY.md).

## Scope and viewer behavior

- Display one entire floor at a time, including all its named sections. Start on Floor 0 fitted to its bounds.
- Provide a floor selector, fit-floor control, mouse drag/wheel and touch pan/pinch. Preserve pixel textures when zoomed in.
- Show section labels and legible marker icons attached to map coordinates. Ordinary markers open a name/description popup; linked stairs switch floors and center/highlight their destination. Preserve a useful zoom within the destination's limits.
- Unlinked stairs display “Destination not yet mapped.” A destination highlight remains visible even if its type is filtered out, without changing saved filter settings.
- All successfully saved geometry and markers are public. No player accounts or discovery tracking. Remember visitor filters locally.
- Seed chest, relic, shop, stairs, and other marker types with distinct icons. Provide keyboard-accessible controls and marker labels.
- Group individual named markers under their marker type in the legend: for example, Relics contains Relic 1 and Relic 2, and Shops contains the named shop markers. Legend groups are separate from dungeon sections. Group membership follows the marker's type.
- List markers on the selected floor under collapsible type headings. Each heading toggles the group; clicking an entry centers and highlights its marker. A stair entry centers its marker without following the connection; clicking the stair on the map follows it.
- Allow the owner to create custom marker types with a name, color, and icon selected from a bundled set. Each type receives its own legend group. Navigation behavior is reserved for the built-in stairs type.

No player accounts, fog of war, discovery tracking, live Minecraft integration, route finding, 3D viewer, or interactive overlapping passage layers are included. Password-protected schematic import is part of the app. No automatic chest or relic marker creation: the owner places markers manually.

## Map authoring and generation

### Integrated map editor

Load a schematic once, decode its geometry into the map project's own storage, and assign the imported section to a floor. Subsequent edits and generation operate on that project data. Never overwrite the source schematic or depend on its continued presence. Reopening, editing, and generating must still work after the source file has been moved away. Source name/hash/version may be retained as provenance, but a source path is not a live dependency. Schematic export and automatic source synchronization are outside scope.

All authoring features are available after login in the same app, locally or on a server. Block changes must be reflected in generated textures and height shading, rather than merely painting over the output image.

Support individual block selection and multi-block selection, adding/replacing/deleting blocks, undo/redo, and editing block-state properties such as stair direction and slab half. Provide an openable block palette with drag-and-drop placement. Use an overhead view with a rendered preview. Alt + wheel moves the selection vertically in whole blocks; ordinary wheel zooms. A separate height slider hides geometry above its selected slice to expose lower blocks. Show proposed movement before committing it; reject movement into occupied cells outside the selection. Moves preserve relative positions within the selection and are atomic and undoable.

Provide a floor layout mode with section drag-and-drop, whole-block snapping, and editable placement offsets. Move section labels, markers, and connection endpoints with their section using section-relative anchors. Highlight conflicting occupied cells between sections and prevent committing a conflicting layout. Empty space may overlap and identical blocks may share a cell. Section placement changes do not modify its internal block coordinates.

### Whole-section layout and dotted connections

Provide tools to select and move an entire section as one unit within its floor. The owner may intentionally spread sections apart for readability even when they physically connect in the dungeon. Moving the section changes its display placement, not the arrangement of blocks inside it. Preserve the section's identity, elevation, and internal geometry.

Add a section connection type, drawn as a dotted line between two sections on the same floor, to communicate that the areas connect in the dungeon despite the displayed gap. This is distinct from a stair connection, which navigates between floors. Include section connections in persistent project data, backup/restore, and the saved visitor map. Saving a layout or connection change follows the existing Save/autosave workflow; visitors see it on refresh.

In the editor, choose Connect sections and click an entrance point in each of two distinct sections on the same floor. Store each endpoint relative to its section. Draw a straight dotted line between their transformed positions; allow an optional plain-text label and multiple connections between the same pair of sections. Lines communicate connectivity only: clicking them does not navigate. Stair markers retain their separate floor-navigation behavior. Render lines as vector overlays below marker icons, with a legible stroke across zoom levels, rather than baking them into terrain images.

Allow selecting, relabeling, repositioning endpoints, and deleting a section connection. The owner chooses the endpoint's section explicitly when necessary; never infer permanent ownership from overlapping image bounds. Moving a section updates its endpoint positions automatically without changing stored local coordinates. Include labels and endpoints when computing fit-floor bounds. Connection-only edits use Save without re-rendering terrain.

Markers, including stair markers, belong to a section and move with it. Section labels are anchored locally too. Stair navigation resolves the destination's current displayed position, so rearranging a section never breaks a stair link. Moving individual blocks within a section does not automatically move markers; their anchors are positions within the section, not references to particular blocks.

Validate connection endpoints and section IDs on the server. Reject connections between the same section or different floors. Before deleting a section, require explicit resolution of its dependent markers and connections (reassign or confirm deletion); no dangling references may be committed. Reject floor reassignment that would invalidate an existing connection until the owner removes or relinks it. Apply the same integrity check to stair links whose endpoints must remain on different floors.

### Saving and visitor refresh

Saving updates the map used by visitors. Provide Save to flush pending edits; the agreed autosave uses the same operation after completed actions, with debounced text input. No private draft, preview approval, Publish button, or separate generation step is required. Keep session undo/redo and bounded recovery backups. Undoing an already saved edit is another save and therefore updates the public map too.

Show unsaved, saving, saved, and failed states. A drag or selection move is one atomic operation. For marker/type/section-connection-only changes, commit the new data without rendering images. For geometry, layout, or render-setting changes, Save automatically generates the affected floor images from a consistent snapshot. Show progress and report Saved only when the project data and matching visitor-facing output are ready. Preserve the previous complete map while processing. On failure, show that the save did not complete, retain recoverable edits for retry, and keep serving the previous map.

A refresh after successful save must load the new map and marker data. Revalidate the current map manifest on page load and use revisioned image URLs so cached images cannot hide saved changes. Keep each visitor load consistent by referencing a single saved revision; existing open visitor tabs need not update live.

Serialize saves and use revision checks to reject stale writes from another tab. Editing can continue during rendering, but subsequent changes stay visibly unsaved until their own save completes. Autosave can coalesce changes waiting behind an active save; never combine different revisions into one visitor response or let an older job replace newer output. Generation is an internal part of saving, not a user-facing publication stage.

### Sidebar and visual design

Use a modern, restrained interface with the map as the primary surface, clear typography, consistent spacing, and compact controls. Place the legend in a left sidebar that can be hidden and reopened with a persistent visible control. A small Edit button enters editing mode and replaces the legend with editing tools in the same sidebar; exiting restores the legend. On the hosted map, require password login before showing functional editing tools. Keep map position stable when switching modes. Support a narrow-screen drawer for the public viewer; the block-editing workspace targets desktop mouse/keyboard interaction.

Organize editing tools into contextual panels for selection/properties, block palette, and floors/sections plus markers and marker types. Clearly show active tools, selection, height, and save/error state. Every authoring panel requires login; anonymous visitors see the saved public map and legend only.

### Inputs and coordinate contract

Maintain a versioned map project containing ordered floors and imported editable geometry. Each floor has a stable ID, display name, and sections. Each section has a stable ID, name, stored block data, integer X/Y/Z placement offset, and section-relative label anchor. Optional settings include excluded block names and explicit cutaway boxes in section coordinates. Store block-state properties and relevant block-entity data needed for rendering. Preserve the import origin as a stable section coordinate frame: deleting edge blocks or adding blocks outside initial bounds must not renormalize existing coordinates. Project storage must support schema validation and future migration.

At import, normalize the schematic coordinate bounds once before applying section placement. Preserve relative placement among regions inside that schematic. Support negative region sizes, palette states, packed indices crossing long boundaries, and multiple regions. Reject malformed files and conflicting occupied placements with actionable diagnostics rather than silently choosing a winner. Identical overlapping blocks may be deduplicated; air never erases a neighboring section.

Floor coordinates are block units: X increases right, Z increases down, and Y is elevation. The normalized starting section begins at X=0, Z=0. Its first block occupies [0,1) × [0,1), with center (0.5,0.5). Markers store a stable section ID and continuous section-local X/Z coordinates, never image pixels. Their floor is derived from the section. Displayed X/Z equals section placement X/Z plus local X/Z, for markers, labels, and connection endpoints alike. For example, a marker at local (2.5,3.5) in a section placed at (100,200) appears at (102.5,203.5). Section movement changes placement only; image bounds may grow without changing local anchors. The displayed layout need not preserve dungeon distances.

The original Minecraft world origin is not recoverable from the supplied file. Do not present these coordinates as original world coordinates. Rotation and automatic schematic registration are outside initial scope; export sections with a consistent orientation and align them using offsets.

### Texture assets and rendering

Provide an authenticated asset setup screen to import a Minecraft client JAR as the vanilla asset source, with an optional resource pack ZIP layered on top. Persist the required extracted models and textures in the data volume so later server-side generation does not depend on files on the owner's computer. The inspected local candidate is `%APPDATA%/PrismLauncher/libraries/com/mojang/minecraft/26.3/minecraft-26.3-client.jar`; its embedded data version 5023 matches the fixture. This machine-specific path is an example, not a hardcoded dependency.

Use a TypeScript rendering adapter with Deepslate as the first candidate for resolving block states, models, and textures. Run generation in a background worker within the same Docker service, using headless browser/WebGL if required. Keep CPU-heavy import/render jobs off the HTTP request event loop; allow one generation job at a time with progress and failure reporting. Include and verify all required graphics dependencies in the Docker image. The adapter must supply a true orthographic overhead camera; perspective with a high camera is insufficient. Pin the dependency version after validating it against the fixture.

Render all sections of a floor in the shared coordinate frame. Start at 16 image pixels per block, configurable in the editor, with a transparent exterior displayed against a dark neutral background. Use model geometry for stairs, slabs, fences, and ordinary decorations. Preserve texture alpha, sensible water transparency, and a consistent documented biome tint. Use the first frame of animated textures. Provide documented simplified representations for special block entities that the renderer cannot draw, such as chests, signs, and pots. Unsupported blocks must produce a visible fallback and a generation report; do not silently omit structural blocks.

Produce a surface-height pass from rendered geometry and add restrained local shading and height-discontinuity edges. Account for partial-height surfaces. Avoid a global darkest-lowest/brightest-highest gradient: a few low outliers would hide the small rises that matter. Height shading expresses geometry, not an inferred walkability classification. Preserve material recognition and avoid shading that resembles walls across ordinary slopes.

Apply exclusions and cutaways before rendering, revealing the geometry beneath them. Keep adjustments in configuration so re-generation is repeatable. Where passages overlap, show the upper surface; hidden passages may be described with manually placed markers.

The first implementation gate is a rendered preview of the actual starting schematic. Verify stair and slab models, vegetation, water, wall boundaries, and elevation readability before building the rest of the app around the renderer. Deepslate compatibility with the exact asset version is not yet demonstrated. If it cannot meet this gate, evaluate another renderer behind the same adapter and document the actual dependency/license choice. Do not silently replace the agreed textured output with flat block colors.

### Outputs and packaging

Generate a PNG per floor from the map project's current geometry, a versioned manifest, a height grid with empty cells explicitly represented, and a diagnostics report. The manifest records floor IDs/names, image paths, X/Z bounds, pixel scale, section IDs/placements/labels, section connections with anchored endpoints and labels, and content revision. Record generator version, project revision/hash, asset version/hash, and render settings hash for reproducibility. Never embed absolute local paths in public metadata.

Validate all inputs before replacing output. Write a complete new output set and promote it only after success. A failed conversion leaves the last usable output intact. Keep project storage, imported texture/model assets, generated releases, and backups in the persistent data volume. The Docker image includes application and generation tooling. Anonymous routes expose only public map assets and data, never private project storage, uploads, or backups.

Use single images initially; this fixture does not require a tile pyramid. Declare a supported image-size limit based on tested memory use, fail clearly above it, and leave tiling for a future extension.

Run generation automatically as part of Save and expose validation diagnostics in the authenticated editor. Validation flags markers outside new floor bounds and missing floor IDs without deleting them. Imports are one-time reads; remove temporary upload files after successful conversion or failure cleanup. Bound compressed and decompressed input sizes and validate archive paths, format versions, dimensions, and resource use before processing.

## Marker editing and persistence

After login, show an unmistakable editing state and logout control. Clicking empty map space opens marker creation. The owner selects the owning section and a type, enters a required name and optional plain-text description, then saves. Allow moving markers by drag and editing or deleting existing markers. Dragging updates local coordinates using the owning section transform. Changing the owning section is explicit and preserves the displayed position by converting coordinates; require the owner to choose a new position if changing floors. Confirm deletion. Save each completed edit through the shared saving workflow. After success, visitors see it on refresh without a separate publish action. Show pending/error state and retain the form on failure. Never imply a failed edit was saved.

Use SQLite in a persistent mounted data directory. Minimum logical records:

- Marker: stable ID, section ID, local X/Z, type, name, description, revision, created/updated timestamps. Derive floor ID from the owning section.
- Section connection: stable ID, two endpoint section IDs with local X/Z, optional label, revision, and timestamps. Both sections must be distinct and belong to the same floor; multiple connections per pair are allowed.
- Marker type: stable ID, display name, color, bundled icon key, and built-in/custom status. Markers reference type IDs; renaming a type does not change membership. Custom types have no stair navigation behavior.
- Stair connection: stable ID and two distinct stair-marker IDs. Each stair belongs to at most one connection. Both endpoints must exist and be on different floors for this release.

Create or remove both directions transactionally through the single connection record. In editing mode, clicking a stair selects it instead of navigating; a destination picker allows selecting a floor and its target stair. Deleting a linked stair, or changing its type, removes the connection and leaves the other endpoint as an unlinked stair after confirmation.

Custom marker types can be renamed or restyled without changing membership. Deleting a populated custom type requires choosing a replacement type and transactionally reassigning its markers. Built-in types remain available. Reassignment to stairs creates unlinked stair markers, never implicit connections.

Validate types, finite coordinates, floor IDs, string lengths, and connection integrity on the server. Set concrete input bounds during implementation (suggested name 120 characters, description 4,000). Render descriptions as text. Use marker revisions to reject stale edits from another tab with an explicit reload/retry message.

Re-rendering or rebuilding the container does not reset the database. Growing or cropping an image does not change stored marker coordinates. Moving an entire section moves its anchored markers automatically. Editing blocks inside a section leaves marker anchors unchanged. If a deployment removes a floor, retain its markers and identify them as needing attention in the editor; never silently delete them. Broken destinations must show as unavailable rather than navigating to a nonexistent floor.

Provide authenticated full-project download and restore through the editor using the backup format below. Restore validates the entire archive before replacing data, requires explicit confirmation, and creates a pre-restore recovery backup. Never expose credentials or session information through public read endpoints.

## Password and service architecture

### Recommended persistent format

Use `/data/project.sqlite` for editable project state and `/data/assets`, `/data/releases`, and `/data/backups` for larger immutable assets and backups, all inside one persistent Docker volume. SQLite provides atomic multi-record edits without requiring a separate database service. This is an engineering recommendation in response to the owner's format question.

Store project schema version and revision, floors/order, sections/offsets/labels, render settings/cutaways, import provenance, block palettes, marker types, markers, stair connections, section connections, job metadata, and the current saved-map revision reference. Keep stable IDs separate from display names. Save actual editable geometry, not only images or changes relative to the imported schematic.

Partition each section's geometry into 16 × 16 × 16 block chunks keyed by integer chunk coordinates, supporting negative coordinates. Store each occupied chunk as a gzip-compressed, versioned JSON blob in SQLite: a palette of namespaced block IDs with state properties, and 4,096 palette indices in documented X-fastest, then Z, then Y order. Air is explicit palette index zero; absent chunks are all air. Preserve rendering-relevant block-entity data with local positions and typed values. A block edit rewrites affected chunks transactionally; a selection move updates source and destination chunks together. Prefer this simple inspectable representation initially over inventing a custom binary file format. Validate decoded sizes and palette indices.

Store generated PNGs and a JSON manifest in immutable release directories. They are derived output, not the editable source. Record project revision and asset hashes to reuse unchanged outputs and verify each saved map uses matching data and images. Release directories are an internal storage detail, not a publication workflow. Retain the last working release until a complete replacement is validated; never overwrite files currently referenced by a public release in place.

Provide a versioned ZIP project backup containing a consistent SQLite snapshot, referenced texture/model assets, and generated release files, plus a manifest with checksums. Exclude passwords, sessions, temporary uploads, and unfinished jobs. Use SQLite's supported backup mechanism rather than copying a live database file without its transaction state. Backups must be downloadable/restorable through the authenticated app so local-to-server transfer needs no separate tool. Validate archive paths and checksums before atomic restore. Document a bounded recovery retention policy, initially the five latest recovery snapshots plus explicitly downloaded backups.

### Runtime and access

Use a small TypeScript application: React/Vite for the interface, Leaflet with a simple image coordinate system for map interaction, and Fastify for static assets and the JSON API. Encapsulate the X/Z-to-map-coordinate conversion and test it; image pixels and Leaflet latitude must not leak into stored marker positions.

Use a supported Node.js LTS version pinned during implementation and a compatible SQLite binding. One Docker service serves the UI, generated map assets, and API and runs its background generation worker. Import/render logic remains an internal module boundary. No separate local app, external database, or additional worker container is required.

Provide `EDITOR_PASSWORD` with a seeded local-testing default of `relic-local`. Include this in `.env.example` and setup instructions. The default supports immediate local testing and can be overridden without rebuilding. Do not include the configured password in frontend code or API responses.

Compare credentials on the server, issue unpredictable expiring sessions via HttpOnly SameSite cookies, and support logout. Use Secure cookies for HTTPS hosting. Protect every edit, import, asset setup, generation, export, and restore endpoint; verify same-origin requests for cookie-authenticated mutations and rate-limit login attempts. Configure proxy trust explicitly when deployed behind HTTPS termination. Do not log passwords or session tokens. Server restarts may require a fresh login; marker data must remain.

Provide Dockerfile and Compose configuration, a health endpoint, automatic schema initialization/migrations, a named data volume, and a documented local port. `docker compose up --build` must start the app with a persistent project. Seed the supplied starting project and a generated public map only on the first run of an empty volume; never overwrite existing work. If assets are missing, show an actionable editor setup state and a clear public map-unavailable state. Missing generation assets must not prevent serving an existing public map. Bind the documented local test setup to localhost; explain how to expose it behind an HTTPS reverse proxy for public hosting. Public hosting provisioning is outside this implementation.

## First fixture evidence

The source was inspected without modification:

| Property | Observed value |
| --- | --- |
| File | `schematics/Start 0F.litematic` |
| Format | Gzip NBT, Litematic version 7, subversion 1 |
| Minecraft data version | 5023 |
| Dimensions | 67 × 13 × 49 blocks |
| Regions | One, `Unnamed` |
| Region position / signed size | (0,12,0) / (67,-13,49) |
| Non-air blocks | 3,484 |
| Palette | 142 states, 78 block names |
| Highest occupied Y per column | Ranges from 0 to 11 |
| Chest coordinates after normalization | (61,9,34) and (27,10,8) |

This fixture includes partial blocks, vegetation, water/waterlogged blocks, and special block entities. Negative Y extent support is mandatory from the first import. Some columns have gaps between occupied blocks; this does not establish that they contain navigable tunnels. Ceiling removal and readability must be visually checked rather than assumed from metadata.

## Implementation sequence and acceptance

1. Build the import/render adapter and generate the starting area using the matching local assets. Verify decoded counts and bounds, signed extents, and chest positions. Produce the preview and diagnostics; visually assess materials, walls, traversable-looking paths, partial blocks, water, and height cues. Record limitations and generation settings. Renderer success gates subsequent integration.
2. Build the versioned map project and integrated authoring tools. Verify one-time import, reopening after removal of the source schematic, block-state edits, palette placement, multiple selection, atomic height moves, undo/redo, section assignment/placement, and collision rejection. Check stable coordinates when geometry bounds change and verify regenerated shading reflects edits. Source schematics must remain byte-for-byte unchanged.
3. Add manifest handling and the read-only viewer with the collapsible left sidebar. Verify floor fit, zoom/pan, mobile controls, labels, grouped filters, legend entry centering, and coordinate alignment. Check that known chest block centers align with temporary test markers at (61.5,34.5) and (27.5,8.5).
4. Add login, SQLite persistence, marker/type CRUD, export/restore, and transactional stair connections. Verify rejected unauthorized writes, failed-login throttling, stale-edit handling, save failures, input validation, type reassignment, connection deletion/type-change behavior, and sidebar mode switching.
5. Package the runtime and document authenticated authoring, generation, backup/restore, and Compose startup. Verify markers survive service restart and image rebuild, password override works, backups restore, and regenerated image bounds preserve marker alignment.
6. Exercise multiple floors with an explicitly labeled development/test fixture. Check bidirectional navigation, destination centering, missing destinations, and an unlinked stair. Do not present synthetic floors as real dungeon content in the default map.

Include focused automated tests for parsing and coordinate transformations, authentication boundaries, marker persistence, connection integrity, and export/restore. Include a browser smoke test for creating a marker and following stairs. Test moving a section with a label, ordinary marker, stair marker, and multiple dotted connections: all anchors must follow it through save, visitor refresh, and backup/restore, while internal block coordinates stay unchanged. Check destination centering after section movement, endpoint editing, visual-only line behavior, and rejection of invalid or dangling connections. Visual acceptance requires inspection of the real rendered map; passing parsing tests alone is insufficient.

Also verify Save/autosave and reopen, visitor refresh after marker and geometry saves, cache revalidation, failed-save feedback, chunk round trips including negative coordinates and block properties, and recovery after interrupted generation. Generate the actual fixture inside Docker, not just on the developer host. Verify anonymous requests cannot import, edit geometry, trigger generation, read internal project data, or read backups. Verify a full backup restores to a fresh Docker volume with geometry, asset dependencies, markers, and the public map intact. Confirm concurrent editing does not change the snapshot being rendered and a failed job preserves the previous public output.

For a multi-agent implementation, separate ownership around project/import/storage, rendering/jobs, editor interactions, viewer/markers, and Docker/integration. Agree the project schema, coordinate contract, revision rules, and API shapes before parallel work. Integrate through the real schematic early; a collection of independently working mock screens is not release acceptance.

Deliver application source including the integrated editor and background generator, an initial editable map project imported from the starting schematic, generated starting-area assets, Docker/Compose files, `.env.example`, tests, and README instructions. Explain how to import and edit a new section, assign its floor, arrange sections, adjust cutaways, save/reopen the project, validate marker positions, and connect stairs without losing existing markers.

## Research references and unresolved implementation risks

- [Litematica schematic source](https://github.com/sakura-ryoko/litematica/blob/1.21.4/src/main/java/fi/dy/masa/litematica/schematic/LitematicaSchematic.java), [block-state container](https://github.com/sakura-ryoko/litematica/blob/1.21.4/src/main/java/fi/dy/masa/litematica/schematic/container/LitematicaBlockStateContainer.java), and [packed bit array](https://github.com/sakura-ryoko/litematica/blob/1.21.4/src/main/java/fi/dy/masa/litematica/schematic/container/LitematicaBitArray.java) informed the format inspection. Actual fixture decoding is the acceptance evidence for this file.
- [Deepslate](https://github.com/misode/deepslate) is the first renderer candidate. Its [renderer source](https://github.com/misode/deepslate/blob/master/src/render/Renderer.ts) uses a perspective default and basic face shading, so orthographic projection and elevation shading need explicit work.
- [deepslate-mcp](https://github.com/Philogag/deepslate-mcp) provides a reference for an offline Litematic-to-image pipeline. [Schem-at](https://github.com/Schem-at/schematic-renderer) is an alternative to evaluate if necessary, with different dependency and license implications.

No rendering dependency has yet been installed or tested against the fixture. Compatibility with the matching asset pack, special block rendering, generation runtime/memory, and final visual quality remain implementation validation tasks. These do not change the agreed user-facing scope.
