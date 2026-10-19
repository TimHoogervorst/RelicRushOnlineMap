# Tracker points: handoff for a grilling session

Date: 2026-10-19
Status: design confirmed and implementation authorized on 2026-10-19. Implemented; owner testing of known in-game problem cases remains pending.

## Problem

The owner reports that current player tracking works roughly 80% of the time. Coordinate alignment is generally accurate, but nearby or overlapping sections and floors sometimes cause the map to assign a player to the wrong section. Only the existing public player feed is available; server changes are not an option.

## Agreed concept

Keep the existing calibration waypoint and normal tracking rules. Add **tracker points** as local corrections to section membership.

- A **calibration waypoint** maps Minecraft coordinates into a section's local map coordinates.
- A **tracker point** records: “At this Minecraft world X/Y/Z, the player belongs to this section and its floor.”

In edit mode, the owner selects their online player, clicks **Add tracker point**, and chooses the correct section. Capture the position directly from the player feed, even if the map currently assigns the player incorrectly.

Near a tracker point, use that point as stronger evidence for section membership than the normal broad tracking boxes. Outside its influence, continue using normal tracking. After selecting the section, use its existing calibration waypoint to calculate the exact displayed position.

The user explicitly confirmed that tracker points identify the correct section; they do **not** correct coordinate alignment within that section or snap the player icon to the tracker point. They are intended as saved location hints for tracking players generally, not just the player used to capture the point.

## Grilling answers — 2026-10-19

- Influence must account for all three world axes, especially Y because existing failures often involve vertical separation.
- Keep normal tracking as the default. An applicable nearby tracker point takes precedence to correct locations where normal tracking fails.
- Tracker points are based on the section's existing calibration waypoint and update along with calibration changes; fixed world coordinates independent of recalibration were not accepted.
- The owner will test known problem cases after implementation and provide feedback for refinement. Recorded route replay is not an agreed prerequisite.
- Influence controls belong in editing settings, not on individual tracker points or players. One shared set applies to all players and points and is saved with the project. Confirmed controls are horizontal reach (X/Z), initially 3 blocks, and vertical reach (Y), initially 1 block.
- Tracker points preserve their position relative to the calibrated section: correcting the waypoint's world Y by +5 also shifts the point's effective world Y by +5. Moving a section in the displayed layout does not change its world position.
- A tracker point may override the section's normal tracking box, including normal floor selection, provided the destination has valid calibration in the same Minecraft world.
- Among applicable points for different sections, the nearest point by three-dimensional world distance wins. Exact ties retain the previous section if it is a tied destination; otherwise the assignment is ambiguous. Points for the same section agree.
- In edit mode, list all players currently reported online by the feed, including outside and ambiguous players, and provide Add tracker beside Follow. Following is not a prerequisite. Capture the player's coordinates when Add tracker is clicked, hold that sample while the owner chooses the correct section, and save on confirmation relative to that section's calibration. Disable capture when the feed is stale. Receipt time cannot establish the age of the upstream game observation.
- Resume normal tracking immediately outside every point's reach. Enter and leave influence without added delay; defer hysteresis unless testing demonstrates a need.
- Show tracker points only in edit mode, on the map and in a section-specific list. Support selection, deletion, replacement from a player's current position, automatic names with optional renaming, selected-point reach visualization, and warnings for overlapping influence belonging to different sections. Include points and global reach settings in saves, backups, and undo/redo. Visitors benefit from corrections but do not see tracker points.
- Rotating or flipping a section preserves points' effective Minecraft locations through the waypoint relationship. Moving the section to another floor changes the assigned floor. Deleting the section deletes its points. Removing its waypoint retains points but makes them inactive until calibration is restored; points remain based on that calibration.

## Final confirmation

The owner confirmed the complete design and explicitly authorized implementation. Influence uses horizontal circular distance at most the shared X/Z reach AND absolute Y difference at most the shared Y reach (a vertical cylinder). Inside that region the point has full precedence, with no gradual strength weighting. Existing stale-feed display behavior remains applicable; each new position is matched directly, including teleports. Sliders support 0.25–64 blocks in quarter-block increments.

## Using the implementation

1. Enter Edit. The Players panel lists all players reported by the feed, including outside and ambiguous positions.
2. Click Add tracker beside a player. Select the correct calibrated section, optionally name the point, and save. Coordinates are frozen when the button is clicked.
3. In Player tracking, adjust the shared horizontal and vertical reach. Select a section to manage its points; select a point to see its horizontal reach on the map. Vertical reach is shown in the controls and point tooltip.
4. Rename, delete, or replace a point using an online player's position. Undo tracker edit and Redo cover these changes and reach settings.
5. Test a known bad route and nearby floors. Visitors receive corrected assignments without seeing the editor overlay.

Points use fractional section-local coordinates derived from the calibration waypoint. They persist with section data, while shared reach persists with project settings. Metadata-only saves publish these edits without terrain rendering; saves that cannot publish show a retry message. Tests cover vertical/horizontal boundaries, competing points, calibration changes, rotations/flips, lifecycle restore, authenticated API edits, history, publication, and backup restore.

## Existing implementation and context

- The feed supplies world, UUID, name, and X/Y/Z. Upstream requests are throttled to at most one every two seconds; actual upstream observation timing is not established.
- Current matching filters by world and section X/Y/Z bounds, prefers the matching floor with the highest minimum Y, then uses previous-section history to resolve remaining ambiguity.
- Public tracking lists only mapped players. Editor diagnostics expose outside and ambiguous players as well; the capture workflow should account for this distinction.
- Following already changes sections and floors automatically after assignment changes.
- Main files: [server matcher](../src/player-tracking.js), [coordinate transforms](../src/tracking-coordinates.js), [tracking UI](../public/player-tracking.js), [project storage](../src/project-store.js), and [tracking tests](../tests/player-tracking.test.js).
- Background: [accuracy research](research/player-tracking-accuracy.md), [existing design decisions](design-decisions.md), and [domain glossary](../GLOSSARY.md).

## Original grilling prompt (completed)

> Use grill-with-docs to grill the tracker-point concept in docs/tracker-points-handoff.md. Read the existing tracking implementation and research notes for context. The agreed purpose is local correction of section/floor membership while keeping the existing calibration waypoint for exact positioning. Resolve the open questions, record accepted decisions, and do not begin implementation during the grilling session.
