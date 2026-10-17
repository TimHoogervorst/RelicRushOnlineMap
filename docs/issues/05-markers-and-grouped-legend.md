# 05 — Place markers and browse a grouped legend

Status: blocked

## What to build

Deliver marker creation, movement, editing and deletion with the five built-in types, section-local anchoring, and the visitor legend/popups.

User story: The owner can maintain points of interest; visitors can find and filter them.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] Support chest, relic, shop, stairs and other with distinct bundled icons; required name, optional plain-text description, and explicit owning section.
- [ ] Store stable marker IDs and section-local X/Z; derive the floor from the section. Drag converts display coordinates to local coordinates, and ownership changes explicitly preserve displayed position on the same floor.
- [ ] Create/edit/delete persists through shared Save/autosave without re-rendering terrain; validate types, finite coordinates, lengths and revisions. Confirm deletion and retain failed forms.
- [ ] Use current-floor collapsible type groups containing individual marker names. Group visibility toggles persist in the visitor browser; legend entries center/highlight markers.
- [ ] Ordinary markers open accessible name/description popups; an unlinked stair shows Destination not yet mapped. Keyboard labels and sidebar behavior work on narrow screens.
- [ ] Verify known chest center alignment at local (61.5,34.5) and (27.5,8.5), visitor refresh, ownership conversion, restart persistence, authorization, and session undo/redo.

## Blocked by

- [04 — Keep saves consistent during rendering and failures](04-reliable-save-and-refresh.md)

## Handoff

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

