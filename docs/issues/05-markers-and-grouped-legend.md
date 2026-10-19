# 05 — Place markers and browse a grouped legend

Status: in progress

## What to build

Deliver marker creation, movement, editing and deletion with the five built-in types, section-local anchoring, and the visitor legend/popups.

User story: The owner can maintain points of interest; visitors can find and filter them.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [x] Support chest, relic, shop, stairs and other with distinct bundled icons; required name, optional plain-text description, and explicit owning section.
- [x] Store stable marker IDs and section-local X/Z; derive the floor from the section. Drag converts display coordinates to local coordinates, and ownership changes explicitly preserve displayed position on the same floor.
- [x] Create/edit/delete persists through shared Save/autosave without re-rendering terrain; validate types, finite coordinates, lengths and revisions. Confirm deletion and retain failed forms.
- [x] Use current-floor collapsible type groups containing individual marker names. Group visibility toggles persist in the visitor browser; legend entries center/highlight markers.
- [x] Ordinary markers open accessible name/description popups; an unlinked stair shows Destination not yet mapped. Keyboard labels and narrow-screen sidebar layout are implemented.
- [x] Verify known chest center alignment at local (61.5,34.5) and (27.5,8.5), visitor refresh, ownership conversion, restart persistence, authorization, and session undo/redo through tests.

## Blocked by

- [04 — Keep saves consistent during rendering and failures](04-reliable-save-and-refresh.md)

## Handoff

Implemented marker CRUD endpoints under `/api/project/markers`, with stable UUIDs, section-local anchors, required owning-section IDs, built-in type/name/description validation, and expected-revision checks. Section ownership derives the floor. Same-floor ownership changes preserve the existing displayed coordinate when the explicit checkbox is enabled; map dragging converts the displayed position back into the section-local frame. Marker-only releases advance the shared revision pointer and copy the prior PNGs into the new immutable release without invoking the renderer. The visitor manifest contains the marker collection, so refresh loads the new data with the same revision as the image.

The visitor map has distinct bundled SVG icons, current-floor collapsible type groups, persistent per-floor browser visibility toggles, centered/highlighted legend entries, and accessible popup dialogs. Unlinked stairs display “Destination not yet mapped.” The editor provides marker create/edit, pointer drag, explicit ownership, confirmed deletion, retained failed forms, and per-login bounded undo/redo (50 marker commands) with Ctrl+Z/Ctrl+Y shortcuts. Marker undo history is session-only and clears at logout/restart.

Verification: `npm.cmd test` (26/26 passed), `npm.cmd run typecheck` (passed), and `node --check public/viewer.js` (passed). Tests confirm the supplied schematic's chest centers map to section-local `(61.5,34.5)` and `(27.5,8.5)`, coordinate conversion when changing sections, revision conflicts, type/coordinate validation, unauthenticated denial, per-session undo/redo, anonymous manifest refresh, persistence after reopening the service, and that marker edits do not call the renderer.

Remaining: interactive browser review at desktop and narrow widths, Docker acceptance, and manual keyboard/screen-reader checks remain open. The local Docker Engine/browser acceptance gates were unavailable in this environment; keep this ticket in progress until those checks pass. Stair linking/navigation is owned by ticket 10.

