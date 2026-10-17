# 09 — Draw dotted connections between section entrances

Status: in progress

## What to build

Add Connect sections: select an entrance in each of two sections, then display a persistent visual-only dotted line.

User story: Visitors can understand that sections separated in the displayed layout connect in the dungeon.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [x] Create two local endpoint anchors on distinct sections of one floor. Endpoint section selectors resolve overlap explicitly; labels are optional and multiple connections per pair are supported.
- [x] Render straight dotted SVG lines beneath labels and markers with fixed-screen stroke sizing. The SVG has no links or click handlers and uses `pointer-events: none`; fit includes line endpoints and labels.
- [x] Select/relabel a connection, edit either endpoint, or delete it; revisioned metadata saves reuse terrain images and session undo/redo restores edits.
- [x] Section-local anchors are transformed from current section placement each time the visitor manifest is generated, so moving a section moves its connection endpoint without rewriting it.
- [x] Validate same-floor/different-section membership and section-local bounds on the server. Foreign keys prevent dangling section references; SQLite triggers reject cross-floor reassignment while connected.
- [x] Verify multiple links, endpoint edits, metadata-only saves, authentication, revisions, undo/redo, restart persistence, and layout transform correctness with automated tests.

## Depends on

- [08 — Arrange entire sections with their markers and labels](08-whole-section-layout.md) (implementation integrated)

## Handoff

Connections are stored in `section_connections` with both owning section IDs, local X/Z anchors, and a plain-text label. `POST`, `PUT`, `DELETE`, and per-session undo/redo routes use the normal project revision and publish new metadata manifests without invoking terrain rendering. Public floor manifests contain `connections`, each with local anchors plus transformed `displayA` and `displayB` coordinates. The editor allows explicit section selection and local coordinate editing; the visitor overlay is a non-interactive SVG under section labels and markers.

Verification: `npm test` passes (42 tests), `npm run typecheck` passes, `node --check public/viewer.js` passes, and `git diff --check` passes. Tests cover two links for one section pair, ownership and bounds validation, floor-reassignment and deletion guards, section movement transforms, authorized revisioned route mutations, undo/redo, metadata-only image reuse, and visitor manifest persistence through process restart. Browser interaction and Docker acceptance remain pending the shared runtime check; the SVG overlay is non-navigating by construction (`pointer-events: none`, no anchor elements or navigation handler).

