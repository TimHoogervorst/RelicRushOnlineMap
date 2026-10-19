# Player tracking accuracy: investigation and options

Date: 2026-10-19. Status: research and proposed options, not an accepted implementation specification. No application changes accompany this note.

Constraint confirmed during discussion: use only the existing player feed. Server integration is outside the current scope.

## Verified implementation facts

- `locatePlayers` filters by world and rectangular X/Y/Z limits, selects the floor with the highest matching region minimum Y, and only then uses the previous section to resolve ties. It does not inspect local geometry or route connectivity. Thus the previous section cannot prevent a higher matching floor from winning. [Source](../../src/player-tracking.js)
- Default limits use all imported non-air blocks and add three blocks above the maximum Y. Walls, ceilings, and irregular section shapes therefore affect the box. [Source](../../src/tracking-coordinates.js)
- Geometry is available as local X/Y/Z, Minecraft block ID, and properties. Section connections and linked stairs exist, but their endpoints store X/Z without a calibrated Y transition volume. [Source](../../src/project-store.js)
- The renderer's structural-block classification is for visual relief and explicitly not navigation; it should not be treated as authoritative collision or walkability data. [Source](../../src/terrain-shading.js)
- Upstream requests are throttled to at most one every two seconds. A successful fetch timestamps receipt, not the underlying game observation. The tracker retains only previous assignments, not timestamped movement history. [Source](../../src/player-tracking.js)

Likely explanation, not yet confirmed against a recorded failure: overly broad boxes and the global highest-minimum-Y rule can choose an upper section while a player is still beneath it or jumps near it. A section with a sloped floor cannot be described accurately by one global floor height. This is an ownership-classification problem; a second calibration waypoint would not by itself resolve overlapping regions.

## Primary-source evidence

Newson and Krumm's map-matching research combines geometric evidence with route connectivity and sequences of observations. It demonstrates why independent nearest-road decisions fail and evaluates degradation as observations become sparse. This is evidence for considering movement history and topology, not evidence that a Minecraft implementation will achieve any particular accuracy. Their experiment concerns noisy vehicle GPS, whereas this project may have accurate coordinates and uncertain section ownership. [Original paper, Microsoft Research](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/map-matching-ACM-GIS-camera-ready.pdf)

Recast represents multiple vertical spans in a column, constructs open-space heightfields, and filters using clearance and climb limits. This is a useful established representation for overlapping walkable levels. It does not imply that its default traversal assumptions match Minecraft jumping, ladders, swimming, flying, or partial blocks. [Recast span representation](https://recastnav.com/structrcSpan.html), [Recast construction and filtering API](https://recastnav.com/group__recast.html)

Paper exposes movement events through its plugin event system. If this server runs a compatible implementation and its owner permits a plugin, game-side reporting is an option. Neither condition has been verified here. [Paper event listeners](https://docs.papermc.io/paper/dev/event-listeners/)

## Proposed approaches and tradeoffs

| Approach | Expected benefit | Cost and limitations |
| --- | --- | --- |
| Editor-defined ownership volumes: several boxes or a polygon with local height bands per section | Directly removes known false overlaps; easiest controlled first step | Requires editor work at troublesome boundaries; a single polygon plus global Y band still fails on stacked/sloped geometry |
| Geometry-assisted walkable masks with per-column height spans | Distinguishes rooms and levels sharing the same large bounding box | Medium/high implementation cost; block occupancy is not walkability, partial blocks need care, incomplete imports require overrides |
| Short movement history plus soft transition preferences | Reduces jumping between close candidates and momentary jumping-induced floor changes | Adds some delay in ambiguous areas; cannot repair wrong geometry or missing observations; must allow recovery from a wrong prior assignment |
| Explicit transition volumes at stairs, doors, drops, ladders, and teleports | Adds strong evidence where ownership changes | Needs real world XYZ extents and intended ownership; current visual links are only a starting point, not sufficient gate definitions |
| Server plugin exporting section/floor identity and observation time (excluded from current scope) | Could supply semantic ownership directly if the game has authoritative region definitions | User requires the existing feed only; this alternative is unavailable for the proposed work |

These are design inferences informed by the sources and current code; they are not verified performance claims.

## Recommended staged experiment

1. Capture a short, bounded diagnostic trace around reproducible failures: raw world XYZ, receipt time, source time if supplied, every candidate and its reason, chosen section, previous section, and the player's expected section/floor. Include walking both directions, stationary jumps beneath an upper room, stairs, a drop, teleport, and first appearance in an overlap. Confirm coordinate Y semantics using a known standing position.
2. Start with a union of small editable 3D boxes per section in the failing areas, keeping the existing large box as a broad search filter. Show the boxes and highlight their overlaps so they can be corrected. A painted walkable mask is a richer alternative. Keep ownership regions separate from the one calibration waypoint and existing orientation transform.
3. Add geometry assistance to generate masks and local floor/ceiling spans where imports are complete. Keep multiple walkable spans per X/Z column, not just the highest surface. Account for player position convention and partial-block heights. Permit manual exclusions, additions, and special movement corridors.
4. Add modest temporal scoring only for remaining ambiguity: prefer physically plausible continuation and known transitions, but switch immediately on strong unambiguous spatial evidence. Never permanently lock the player to a stale assignment. On large discontinuities, world changes, or long outages, reset history and reacquire. Keep an explicit uncertain state rather than inventing certainty.
5. Consider a fuller probabilistic sequence matcher only if replayed evidence shows simple scoring is inadequate. More algorithmic complexity before accurate region geometry would mostly disguise wrong boundaries.

Use transitions as soft evidence initially. A player can cross an entire small gate between samples; requiring a sample inside it would miss the crossing. Segment-to-gate intersection can help for straight travel but is only an approximation: the real path can bend, jump, or teleport between observations. Missing intermediate observations cannot be reconstructed uniquely.

Update temporal state once per new upstream observation, not once per visitor request. Multiple visitors must not create artificial confirmation votes from the same cached snapshot. If source timestamps are unavailable, document the weaker freshness guarantee and avoid treating identical responses as proof of additional motion.

Measure incorrect section/floor assignments, ambiguous time, oscillation count, and transition delay against labeled traces. Compare each stage to today's matcher on the same traces. No target such as 99% accuracy is justified until these cases are measured. More frequent polling helps only if the upstream feed actually publishes newer observations; display interpolation cannot restore missing section identity.
