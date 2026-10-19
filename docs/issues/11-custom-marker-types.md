# 11 — Create and maintain custom marker types

Status: in progress

## What to build

Provide marker-type management in the authenticated sidebar and connect custom types to marker editing, icons and legend groups.

User story: The owner can organize new kinds of points of interest without changing code.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [x] Create a type with stable ID, display name, color and bundled icon; validate inputs and persist through Save/autosave without terrain rendering.
- [x] Use custom types in marker forms and automatically group their markers under the current-floor legend heading.
- [x] Rename/restyle a type without changing membership. Preserve built-in types; only built-in stairs have navigation behavior.
- [x] Deleting a populated custom type requires choosing a replacement and atomically moving its markers. Reassignment to stairs creates unlinked stair markers.
- [x] Keep saved visitor data, filtering and icons consistent after refresh; handle filter preferences for deleted IDs.
- [x] Test unauthorized mutations, replacement validation, failed saves, session undo/redo and restart persistence.

## Blocked by

- [05 — Place markers and browse a grouped legend](05-markers-and-grouped-legend.md)

## Handoff

Custom marker types are stored in `custom_marker_types` with generated stable IDs, a 1–40 character plain-text name, a six-digit hex color, and an icon selected from the bundled `chest`, `relic`, `shop`, and `other` SVGs. Built-in types remain immutable. `GET/POST /api/project/marker-types`, `PUT/DELETE /api/project/marker-types/:id`, and the session-only `/undo` and `/redo` routes are authenticated and revision checked. Deleting a populated group requires an existing replacement and reassigns all matching marker rows inside the same SQLite transaction. Assigning `stairs` leaves markers unlinked; only the built-in `stairs` ID triggers stair linking/navigation behavior.

Marker types are included with each floor snapshot and public manifest. Type mutations use metadata-only saves, preserving terrain images. The sidebar offers create, rename/restyle, delete/replacement, icon/color selection, and type undo/redo. Marker forms and the grouped visitor legend load type IDs and presentation from the saved manifest. Deleted IDs are removed from saved browser filter preferences.

Verification: `npm.cmd test` (46/46 passed), `npm.cmd run typecheck` (passed), and `node --check public/viewer.js` (passed). The slice test covers unauthorized mutation, input/icon validation, stable IDs, type membership through restyle, immutable built-ins, replacement validation and stairs unlinking, metadata save failure/retry, undo/redo, restart persistence, and that type saves do not rerender terrain.

Remaining: interactive browser review and Docker acceptance remain open with the rest of the release gates. Keep this ticket in progress until those checks pass.

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

