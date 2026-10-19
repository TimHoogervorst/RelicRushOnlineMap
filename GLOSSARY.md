# Relic Dungeon Map

The map represents the dungeon explored by players searching for relics.

## Language

**Floor**:
A dungeon level viewed as one map containing all of its sections, which may be spaced apart for readability. Small terrain height changes can occur within a floor.
_Avoid_: Layer, elevation

**Section**:
A named area within a floor, such as a cave or mansion.

**Passage**:
A route through the dungeon along which players can travel. Its ground may rise or fall within a floor.

**Wall**:
Raised terrain beside a passage that separates it from surrounding space or another passage. Its sides may rise abruptly or over several blocks.

**Marker**:
A point of interest anchored within a section, such as a chest, relic location, shop, or stair connection. It moves with that section in the displayed floor layout.
_Avoid_: Pin

**Player**:
A Minecraft player on the game server whose in-game position can be displayed on the dungeon map.

**Visitor**:
A person viewing the dungeon map website. Visiting the website does not create a tracked player position.

**Dungeon run**:
A player's or cooperating pair's attempt to traverse the dungeon, with each participant's route tracked individually and one shared outcome.

**Endpoint**:
The single designated dungeon exit location. A run succeeds when at least one participant's final tracked dungeon position is within its area when the run ends.

**Run replay**:
A time-based presentation of the recorded routes of a dungeon run's participants.

**Co-op run**:
A dungeon run shared by two players, with separate recorded routes and one shared outcome.

**Marker encounter**:
The first time either participant in a dungeon run comes within a marker's encounter area. Later visits to that marker in the same run are not new encounters.

**Interrupted run**:
A dungeon run whose outcome could not be established because tracking or recording was interrupted.

**Run duration**:
The observed elapsed time from the first participant's dungeon entry to the last recorded dungeon position across the run's participants. It excludes the final departure grace period.

**Calibration waypoint**:
A reference block within a section whose actual Minecraft coordinates are known, tying the section's local coordinates to its location in the game world.

**Tracking region**:
A section's three-dimensional region in a Minecraft world used to determine whether a player is inside that section. It is independent of the section's placement in the displayed map.

**Tracker point**:
A saved location in a Minecraft world identifying the section a nearby player belongs to, and therefore its floor. It is a local hint for section membership shared by all players, independent of the calibration waypoint used to position them within that section.

**Marker type**:
A category of point of interest, such as relic, shop, chest, or stairs. A marker's type determines its legend group; its name identifies the individual location within that group.

**Legend group**:
The collection of named markers sharing a marker type in the legend, such as Relic 1 and Relic 2 under Relics. It is independent of the dungeon's geographic sections.

**Editor**:
The dungeon owner who maintains the map's geometry, layout, markers, and marker types.

**Map project**:
The editable dungeon map, containing its floors, sections, and imported block geometry. Its geometry becomes independent of the source schematic after import.

**Stair connection**:
A bidirectional link between two stair markers, allowing a visitor to switch to the destination floor and location. An unlinked stair marker represents a destination that has not yet been mapped.

**Section connection**:
A link between two named exits in different sections. Each exit belongs to a section, retains local coordinates, and remains visible when unlinked. A dotted line joins linked exits on the same floor. Cross-floor exits show ?To ?? with the destination name and floor; clicking it navigates to the destination exit. Each exit can have one partner.
