# Operations

## Start the app

Use Docker Compose with Docker Engine running. From the repository directory:

```powershell
Copy-Item .env.example .env
# Edit .env and set EDITOR_PASSWORD to a private value before hosting remotely.
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://localhost:3000/health
```

Compose binds port 3000 to `127.0.0.1`, so it is available only on the Docker host by default. The named `map-data` volume stores the SQLite project, configured assets, immutable map releases, and recovery snapshots. Container rebuilds and restarts reuse this volume. Startup seeds Floor 0 and Starting Area only if the database contains no sections; it does not replace an existing project.

The default local password is `relic-local`. Set `EDITOR_PASSWORD` in `.env` before exposing the app through a proxy. Login sessions are in memory, expire after eight hours, and must be created again after a restart. The app does not store the password in the project or backup.

## Configure rendering assets

Open **Edit**, log in, and upload the matching Minecraft 26.3 client JAR (world version 5023). The app extracts the blockstates, models, and textures into the data volume and removes the temporary upload. The JAR itself is not retained. Alternatively, mount the JAR at `./assets/minecraft-client.jar`; Compose already mounts `./assets` read-only at `/seed-assets` and startup checks `/seed-assets/minecraft-client.jar`.

The app can start without the JAR, but the public map is unavailable until matching assets are configured and the initial render completes. `/health` reports service initialization; `/api/status` reports whether a public map is available. Check the in-app setup warning or `docker compose logs map` if rendering does not complete. Assets configured through the editor persist in `map-data`.

## Add floors and sections

In **Edit → Import a section**, choose a `.litematic` file and give the section a name. Select an existing floor to add the section there, or leave **Create a new floor** selected and enter the new floor name. The import is a one-time read: blocks and block entities are stored in SQLite chunks, while the uploaded source file is removed. Importing does not keep a link to the original file.

Use the section controls to rename floors and sections, reorder them, drag their labels or enter whole-block placement offsets, and set a local section-label position. Markers and dotted connection anchors stay attached to their section when it moves. To delete or move a section or floor, resolve the displayed marker, stair, and connection dependencies explicitly; the app rejects changes that would leave dangling links.

## Edit and save

The same **Edit** mode provides marker and custom marker type tools, stair linking, section connections, block selection and palette, height slicing, vertical selection movement, render cutaways, exclusions, and image settings. Visitors use the public map without logging in. Successfully saved edits appear to visitors on refresh; there is no draft or separate publish step.

The save indicator reports unsaved, saving, saved, or failed state. Geometry, section layout, and render-setting changes regenerate map images. Marker, marker-type, and connection changes update the public release metadata without rerendering terrain. If rendering fails, the last complete public map remains available and the editor reports the failure; retry with **Save** after correcting the cause. Refresh only after the status says **Saved** if the new map must be visible immediately.

## Supported limits

- Minecraft JAR and Litematic imports: 128 MiB compressed upload. Minecraft asset extraction allows 16 MiB per selected entry and 512 MiB total expanded data; resource-pack extraction allows 16 MiB per entry and 256 MiB total expanded data. Both select at most 100,000 ZIP entries.
- Imported Litematic region dimensions are bounded by the decoder, and a multi-region import is rejected when its combined volume exceeds 16 million cells.
- Block coordinates and section placement offsets are whole block coordinates up to ±1,000,000. A selection move can include at most 100,000 blocks.
- Rendered map images are limited to 8 million pixels. Pixel scale is 4–32 pixels per block. Large maps may need smaller pixel scale, cutaways, or block exclusions.
- Marker names are limited to 80 characters, descriptions to 500, floor and section names to 120, and connection labels to 120.
- Project backups accept ZIP files up to 3 GiB compressed, 2 GiB per entry, 16 GiB total decoded data, and 65,535 ZIP entries (including the manifest). Export and restore currently buffer files in memory, so large backups require sufficient container memory; these limits are not memory reservations.

These limits protect memory and archive handling. They do not imply a guaranteed render time for every project near the maximum image size.

## Download, restore, and move the project

While logged in, use **Project backup → Download full project** to download a ZIP containing a consistent SQLite snapshot, configured Minecraft and resource-pack assets, the currently published map release, and cached player heads. Older generated map revisions are excluded from the ZIP and left untouched on disk; this does not exclude any recorded runs. The backup panel shows the uncompressed total, component sizes, excluded render history, and the size limit; the completed download reports its actual compressed size. The database contains all floors, transformed block geometry (rotations and flips), marker types and markers, stairs and exits, calibration waypoints and tracking regions, tracker points and reach settings, render settings, run endpoints, recorded runs, participants, route samples, and encounters. Externally configured Minecraft assets are packaged into the standard assets directory for use on a fresh container. It excludes the editor password, login sessions, temporary uploads, and unfinished render jobs. The app also retains up to five recent recovery snapshots in the volume.

To restore, open Edit on the destination app, choose the backup ZIP, type the displayed confirmation phrase, and start restore. Restore replaces the whole project after validating the archive and takes a recovery backup of the destination first. Public map requests pause during the file swap; after restore, the page reloads to load the restored release and recordings. The destination retains its own editor password. Old editor undo history is cleared. Published images are used immediately without re-rendering.

For a server migration, either download and restore the full project through the editor, or stop the app and copy the named Docker volume with Docker's volume backup procedures. A project ZIP is portable across hosts running the same application version and does not require the original schematic or source JAR. Start a fresh container with its default configuration, sign in, and import the ZIP; no asset upload or manual path changes are needed. Browser preferences (including welcome-screen dismissal), deployment environment variables, and older recovery ZIPs are not project data and are not transferred. Keep an additional copy of the ZIP outside the Docker host. Restoring a backup replaces the destination project; confirm the target before proceeding.

## HTTPS reverse proxy

Keep the Compose port bound to localhost and terminate HTTPS at a reverse proxy on the same host. Configure the proxy to forward the original `Host` and `X-Forwarded-Proto: https` headers. Set these values in `.env` and recreate the app:

```dotenv
EDITOR_PASSWORD=use-a-long-private-password
TRUST_PROXY=true
COOKIE_SECURE=false
```

`TRUST_PROXY=true` configures Express to trust exactly one proxy hop. Use it only when the app is directly behind a proxy you control; do not expose port 3000 to clients that can forge forwarded headers. With this setting and a correctly forwarded HTTPS protocol, the login cookie receives the `Secure` attribute automatically. Set `COOKIE_SECURE=true` to force Secure cookies when the proxy topology does not let Express determine the external HTTPS scheme. Secure cookies require HTTPS in the browser.

Compose must be recreated after `.env` changes:

```powershell
docker compose up -d --force-recreate
```

No external hosting account or infrastructure is provisioned by this repository.

## Live Minecraft players

Open **Edit → Player tracking** to calibrate sections. Select an existing block on the map, choose **+ Waypoint**, and enter that block's actual Minecraft X/Y/Z and world identifier. Use block coordinates, not the position of a player standing on the block. The initial tracking region covers the section's stored blocks plus three blocks above its highest block. Its minimum limits are inclusive and maximum limits exclusive; edit all six limits when sections overlap or the initial region misses a passage. Saved limits stay fixed when blocks are edited. To regenerate limits, delete the waypoint and create it again.

Each section supports one waypoint. Uncalibrated sections remain usable but do not display live players. Waypoints are visible as reference symbols while editing; clicking one opens its calibration. Existing sections assume the owner's confirmed vertical flip (top / bottom): world Z maps in the opposite local direction, while X and height stay unchanged. Player positions are mirrored around block centers so the head stays on the correct block. Moving, rotating, or mirroring a section preserves calibration, including undo/redo. New imports start unflipped and record subsequent transforms, including transforms made before adding their waypoint. World tracking limits remain fixed during transforms.

Older valid waypoints are upgraded automatically. Bounds that still match the old generated defaults are corrected for the vertical flip; customized world limits are preserved. A waypoint already invalidated by the previous implementation must be replaced by selecting its reference block again because its former transform history was not recorded. Calibration and orientation are included in project backups.

The right-hand Players panel lists players inside calibrated sections across all floors. Click a player or their head to follow them with an initial close-up; zoom remains adjustable. Manual panning, selecting a floor, navigating to a marker, or Fit floor stops following. Section and floor transitions snap to the destination; movement within a section is smoothed. The shared upstream feed is polled every second while a player is in a calibrated dungeon region (including ambiguous overlaps), every 15 seconds when players are online elsewhere, every 30 seconds while the server is empty, and every 60 seconds after one continuous hour of confirmed emptiness. Player presence or a failed feed resets that empty-server timer. The recorder checks the shared cache every second even without viewers; browser requests reuse that cache and cannot bypass its upstream interval. New arrivals are detected on the next scheduled poll, then the faster interval applies. On failure, positions are marked stale and disappear after 15 seconds without a successful feed update. Leaving mapped space, ambiguous membership without a previous matching section, or disappearing from the feed stops following.

The server needs outbound HTTPS access to `kaart.wereldbouw.net`, `sessionserver.mojang.com`, and `textures.minecraft.net`. The feed supplies UUIDs, so no username lookup is needed. Heads are cropped from official skins with their hat overlay, stored under `DATA_DIR/player-heads`, and refreshed at most daily. Failed lookups use a generic head or the last cached head and never block positioning. Cached head images are included in project exports. Calibration is included in SQLite, along with recorded dungeon runs and their route samples. Current online positions are refreshed from the live feed. A run in progress at migration retains its recorded samples and is marked interrupted when recording resumes.

Use **Min Y / Max Y** in each section's tracking limits to set its vertical range in actual Minecraft coordinates. At the same world X/Z, entering an upper floor's Min Y selects that floor even if the previous floor's box overlaps it. Descending below that boundary selects the lower matching floor again. The camera follows these changes automatically while following a player. Floor names and list order do not determine height. A player outside every calibrated tracking region remains unmapped; calibrate the destination and adjust limits to cover its passages.

Use the editor's live diagnostic coordinates and matched tracking Y range to verify the waypoint, two distant known blocks, a section transition, and a floor transition in-game. Overlapping tracking regions are reported there. Synthetic tests validate the mapping and follow flow; real-world accuracy still requires those measurements against the server.
