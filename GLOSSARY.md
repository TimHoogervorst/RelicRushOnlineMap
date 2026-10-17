# Relic Dungeon Map

The map represents the dungeon explored by players searching for relics.

## Language

**Floor**:
A dungeon level viewed as one map containing all of its sections, which may be spaced apart for readability. Small terrain height changes can occur within a floor.
_Avoid_: Layer, elevation

**Section**:
A named area within a floor, such as a cave or mansion.

**Marker**:
A point of interest anchored within a section, such as a chest, relic location, shop, or stair connection. It moves with that section in the displayed floor layout.
_Avoid_: Pin

**Player**:
A visitor who views the dungeon map and chooses which marker types to display.

**Marker type**:
A category of point of interest, such as relic, shop, chest, or stairs. A marker's type determines its legend group; its name identifies the individual location within that group.

**Legend group**:
The collection of named markers sharing a marker type in the legend, such as Relic 1 and Relic 2 under Relics. It is independent of the dungeon's geographic sections.

**Editor**:
The dungeon owner who maintains the map's geometry, layout, markers, and marker types.

**Map project**:
The editable dungeon map, containing its floors, sections, and imported block geometry. Its geometry becomes independent of the source schematic after import.

**Stair connection**:
A bidirectional link between two stair markers, allowing a player to switch to the destination floor and location. An unlinked stair marker represents a destination that has not yet been mapped.

**Section connection**:
A connection between entrance points in two sections on the same floor, shown as a dotted line to explain dungeon connectivity across the displayed layout. Its endpoints move with their sections; the line does not navigate.
