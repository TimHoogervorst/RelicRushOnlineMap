# Implementation tickets

Status: breakdown approved by the owner on 2026-10-17. Tickets are maintained locally; no GitHub issues have been created. All 15 ticket implementations are integrated and remain in progress pending the acceptance checks recorded in their handoffs. Docker Engine acceptance remains blocked by unavailable Engine access; headless Chrome verified pan/zoom/pinch, while the full interactive journey and accessibility review remain open.

The [implementation spec](../implementation-spec.md) and [glossary](../../GLOSSARY.md) are authoritative. These tickets represent vertical slices: every feature includes storage, API, UI and focused verification as applicable. Each can be demonstrated after its blockers are complete. Ticket numbers are local identifiers.

## Approved order

| Ticket | User outcome | Status | Blocked by |
| --- | --- | --- | --- |
| [01 — Render the real starting map in Docker](01-render-starting-map-in-docker.md) | A visitor can open the supplied starting area as a textured overhead map. | In progress | — |
| [02 — Unlock editing and configure Minecraft assets](02-login-and-asset-setup.md) | The owner can log in, open editing tools, and supply persistent rendering assets. | In progress | 01 |
| [03 — Import a schematic into a saved floor and section](03-import-sections-and-floors.md) | The owner can add dungeon areas without retaining their source schematic. | In progress | 02 |
| [04 — Keep saves consistent during rendering and failures](04-reliable-save-and-refresh.md) | The owner can keep editing while saves run, and visitors always receive a complete saved map. | In progress | 03 |
| [05 — Place markers and browse a grouped legend](05-markers-and-grouped-legend.md) | The owner can maintain points of interest; visitors can find and filter them. | In progress | 04 |
| [06 — Edit individual blocks with a block palette](06-single-block-editing.md) | The owner can make small geometry corrections directly in the map. | In progress | 04 |
| [07 — Move block selections and inspect lower heights](07-selection-height-and-slices.md) | The owner can adjust several blocks together and reach geometry hidden beneath upper blocks. | In progress | 06 |
| [08 — Arrange entire sections with their markers and labels](08-whole-section-layout.md) | The owner can spread dungeon areas apart while preserving their points of interest. | In progress | 05 |
| [09 — Draw dotted connections between section entrances](09-dotted-section-connections.md) | Visitors can understand that sections separated in the displayed layout connect in the dungeon. | In progress | 08 |
| [10 — Connect stair markers and navigate between floors](10-stair-floor-navigation.md) | Visitors can follow stairs to the corresponding location on another floor. | In progress | 08 |
| [11 — Create and maintain custom marker types](11-custom-marker-types.md) | The owner can organize new kinds of points of interest without changing code. | In progress | 05 |
| [12 — Refine map readability with cutaways and resource packs](12-render-readability-controls.md) | The owner can expose obscured paths and tune map appearance without changing source schematics. | In progress | 06 |
| [13 — Manage floors and sections without dangling references](13-floor-section-lifecycle.md) | The owner can reorganize or remove areas without silently losing markers or breaking connections. | In progress | 09, 10, 11 |
| [14 — Download, restore and recover a complete map project](14-portable-backup-and-recovery.md) | The owner can move the entire project between local and hosted Docker instances and recover mistakes. | In progress | 07, 12, 13 |
| [15 — Verify the complete Docker workflow and document operation](15-first-release-journey-and-handoff.md) | The owner can start locally, maintain the dungeon and move it to a server using documented steps. | In progress | 14 |

## Fresh-session start

Read the implementation spec, glossary, and the relevant handoffs. All feature slices are implemented; continue with Docker startup/volume acceptance and interactive browser/accessibility checks. Recheck the recorded limitations before marking any ticket done.

Do not implement the entire backlog in one shared checkout concurrently. After 04, marker work (05) and block work (06) can proceed in parallel. After 05, custom types (11) can proceed alongside section layout (08). After 06, selection/height (07) and readability (12) can proceed in parallel. After 08, dotted connections (09) and stairs (10) can proceed in parallel. Coordinate shared schema/API changes and integration ownership. Prefer isolated branches/worktrees for parallel implementation; integrate each completed slice and its checks before marking its dependents ready.

At each handoff, record completed acceptance criteria, verification commands/results, unresolved problems, and any agreed contract changes. Read actual repository state: tickets describe intended behavior, not existing code. Renderer compatibility remains unproven until 01 passes.

Use local ticket status values: proposed, ready, in progress, blocked, done. Mark blocked tickets ready as their listed blockers complete. Do not call a ticket done because its UI exists while its persistence or visitor-refresh path is missing.

