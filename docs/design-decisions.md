# Agreed design decisions

This records accepted interview answers. The [implementation spec](implementation-spec.md) now covers one Docker application for viewing and all authoring. Saving updates the visitor-facing map on refresh, with no separate preview or publish step. Whole-section movement and dotted section connections are agreed.

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
