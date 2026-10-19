# Agreed design decisions

This records accepted interview answers. The [implementation spec](implementation-spec.md) now covers one Docker application for viewing and all authoring. Saving updates the visitor-facing map on refresh, with no separate preview or publish step. Whole-section movement and dotted section connections are agreed.

## Map readability exploration — 2026-10-18

- Prioritize recognizing passages, separating walls, and higher/lower terrain at full-map zoom while retaining recognizable Minecraft textures. These cues should help players judge routes and potential drops.
- Prefer equally strong shading for identical local geometry at different elevations, but readability takes precedence over strict elevation invariance.
- Passage ground can rise and fall; walls rise beside passages and need not form an abrupt vertical step. A sharp-height-change treatment is an acceptable first comparison, not a complete definition of a wall or a guarantee of impassability.
- Make the higher and lower sides of ledges visually distinguishable to help players interpret potential drops, without claiming a jump is safe. The specific visual treatment remains to be compared.
- Keep ordinary small steps and gradual slopes softly shaded; emphasize larger, steeper changes more strongly. Choose thresholds through visual comparison so stairs still read as continuous routes.
- Rendering method, handling of gradual wall sides, and visual distinction between steps and larger drops remain open. These answers do not select an algorithm or authorize replacing the renderer yet.

## Live player tracking exploration — 2026-10-18

- Track actual Minecraft players from `https://kaart.wereldbouw.net/tiles/players.json`. Website visitors are not tracked players.
- Display player head icons obtained using official Minecraft profile/skin services and cached locally. Keep the displayed heads upright rather than rotating with player facing.
- Start with one calibration waypoint per section and evaluate tracking accuracy before extending calibration. Add it from the selected block popup using + Waypoint, linking local block coordinates to actual Minecraft X/Y/Z.
- Keep section-local calibration independent of the arranged display layout. Sections without a waypoint remain viewable and editable, but do not participate in live player positioning; show Needs waypoint in the editor.
- Show a small right sidebar of players inside calibrated mapped sections across all floors, with their heads, names, floors, and sections. Exclude unrelated players elsewhere on the server.
- Assign each tracked player to at most one section at a time using a world identifier and a three-dimensional tracking region. Initialize the region from section geometry and calibration, include air above walkable blocks, and allow the editor to adjust its limits. Use Y to distinguish vertically stacked sections. Waypoint coordinates identify the selected block, not the player's standing position.
- Select floors by actual world Y before applying previous-section history. Among regions containing the player's world X/Y/Z, prefer the floor with the highest matching Min Y. This switches to an upper floor at its lower boundary even when the lower floor's box extends upward into it, and switches back when descending. Floor names and display order do not determine elevation. Within the chosen floor, retain the previous section only while it still matches; otherwise treat multiple matches as ambiguous. Equal-height floor ties retain the prior matching section or remain ambiguous. Flag overlapping tracking regions in the editor. Positions outside all calibrated regions remain unmapped.
- Clicking a player starts following, centers the player, and applies an appropriate initial zoom. Visitors can subsequently zoom in or out while following. Follow across section and floor changes; manual panning or floor selection stops following. Show the followed player's name and a Stop control.
- The owner confirmed all existing sections were flipped vertically (top / bottom). Use that known orientation for one-waypoint calibration; reverse world Z relative to local Z around block centers. Record subsequent rotations and flips with each section, moving the waypoint with its block and preserving world tracking limits, including undo/redo. New imports start unflipped and record their transforms before or after calibration. This supersedes invalidating calibration on transforms; upright head icons remain independent of section orientation.
- When a followed player leaves mapped space or disappears from a successful feed response, stop following, leave the camera in place, and briefly explain. On feed failure, freeze positions with a stale indicator; after 15 seconds without a successful update, hide positions and stop following.
- Poll the feed once every two seconds through a shared server-side request cycle. Smooth movement within a section; switch directly between floors or separated sections rather than animating through unrelated map space.
- Load head icons independently of position tracking, using a generic head while unavailable. Cache by UUID, refresh skins at most daily, and retain cached heads if the skin service fails.
- Waypoint controls are editor-only. Each section has at most one waypoint, supporting replacement, coordinate correction, and deletion. Persist calibration with the project and include it in backups. Moving a section in the displayed layout preserves calibration; deleting its waypoint disables tracking for that section.
- When creating calibration, suggest the world reported by the feed. Initialize the tracking region from the section's geometry, extending three blocks above its highest block, and allow editing of the world and all X/Y/Z limits. Keep saved limits stable during subsequent geometry edits so ordinary block changes do not silently reassign players.
- Provide an editor-only tracking diagnostic showing a player's world coordinates, calculated section-local coordinates, and matched section. Validate calibration against the waypoint and two distant known blocks, then test a section transition and a floor transition. Use these checks to distinguish calibration errors, feed delay, and incorrect tracking boundaries before extending calibration beyond one waypoint.
- The live feed was fetched successfully during this interview. Its top-level object contains max and players; the observed player entry contains world, name, uuid, x, y, z, yaw, health, and armor.
- The user accepted all interview recommendations, including the final waypoint lifecycle, tracking-region defaults, and accuracy checks. The design interview is complete. Implementation now includes calibration persistence, shared feed polling, official skin head caching, the player panel, following, and editor diagnostics. Live in-game calibration validation remains pending.

## Previously agreed decisions

- Visitors see the full published dungeon map without accounts or discovery tracking. A legend lets them filter marker types.
- Each floor is one continuous map containing all its sections. Small terrain height changes remain within the floor.
- Only the owner edits project geometry, layout, markers, and marker types, through a small password login. Use one server-configured password with a seeded local-testing default and an environment override. Enforce authorization on the server and limit login attempts. Internet hosting uses HTTPS.
- Import, edit, generate, and view maps in one Docker application, both locally and on a server. This supersedes the separate local-tool and packaged-static-map workflow. Anonymous visitors use the saved public map.
- Use overhead Minecraft textures from a local installation, optionally overridden by a resource pack, with subtle elevation shading.
- Account for stairs, slabs, and decorations. Editor generation settings can exclude blocks or define cutaway regions to expose paths. Do not rely on automatic semantic wall/floor classification.
- Where passages overlap, the initial map shows the upper surface. Hidden passages can be indicated manually; interactive underground layers are outside the initial scope.
- Initial marker types: chest, relic, shop, stairs, and other. Support creation, movement, deletion, a type, a name, and an optional plain-text description, with distinct icons and legend filters.
- Save each marker edit immediately and persist it across Docker restarts and map updates.
- Link two stair markers bidirectionally. Clicking a linked stair switches to its destination floor and centers on its destination. Unlinked stairs display that their destination is not yet mapped.
- Place sections using stable IDs and explicit block-coordinate offsets, starting with the supplied schematic as the origin.
- Anchor markers to stable section-local block coordinates. Moving a section moves its markers and labels automatically; re-generation preserves anchors. Flag markers outside new bounds.
- Provide pan/zoom, floor selection, marker filters, fit-floor, mouse/touch support, and section labels. Ordinary markers open popups; stairs navigate directly.
- Use a conventional small stack, one Docker service, persistent project storage, and an internal generation worker. Include setup and backup/restore instructions.
- Acceptance includes visual review of the real starting area, every marker type, persistence across container rebuilds, and stair navigation exercised with a clearly labeled test fixture until another real floor exists.
- Provide authenticated authoring tools to import schematics once into independent map project data, assign sections and floors, move sections, and refine blocks. Never overwrite or continue depending on the source schematic. This supersedes the earlier schematic-overwrite proposal.
- Support selecting blocks or groups, add/replace/delete, undo/redo, block properties, and a palette with drag-and-drop placement. Alt + wheel previews vertical selection moves in whole blocks; ordinary wheel zooms, and a separate slider controls the visible height slice. Reject moves into occupied blocks outside the selection.
- Group individual markers by type in the legend, such as Relic 1 and Relic 2 under Relics and shop markers under Shops. These groups are independent of dungeon sections.
- Show current-floor markers under collapsible type headings with group visibility toggles. Legend entries center and highlight markers; stair entries do not immediately navigate.
- Allow custom types with name, color, and a bundled icon. Reserve stair connection behavior for the built-in stairs type.
- Arrange sections with whole-block drag snapping and editable offsets. Markers, labels, and connection endpoints move with their section. Highlight conflicting blocks and prevent committing conflicting layouts; empty space and identical blocks may overlap.
- Deleting a custom type requires reassigning its markers. Built-in types remain available; renaming/restyling preserves membership.
- Provide a collapsible left legend sidebar. A small Edit button replaces the legend with editing tools; leaving edit mode restores it. Use a modern UI with clear state and controls.
- The owner is willing to invest in a larger initial implementation using multiple agents. Include the full agreed integrated authoring workflow in the initial release and structure implementation for staged integration.

- Save and autosave use the same operation, with visible status, recovery backups, and session undo/redo. Geometry saves automatically generate matching images; marker-only saves skip rendering. Successful saves become visible to visitors after refresh. Failed saves preserve the previous working map.
- Recommended storage is SQLite with compressed chunk geometry and persistent assets/generated PNGs, plus a portable full-project ZIP backup. No private draft or publication workflow is required.
- Allow moving whole sections apart within the displayed floor, preserving their internal geometry. Add dotted section connections to show that separated areas connect in the dungeon. Use Connect sections to place an entrance endpoint in each section. Anchor endpoints locally; support an optional label and multiple connections per section pair. Dotted lines are visual-only; stair markers handle floor navigation. This replaces the earlier fixed-floor marker positioning rule.
