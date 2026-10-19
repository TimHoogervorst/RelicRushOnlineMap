const directions = {
  left: [-1, 0], right: [1, 0], top: [0, 1], bottom: [0, -1],
  'top-left': [-1, 1], 'top-right': [1, 1], 'bottom-left': [-1, -1], 'bottom-right': [1, -1],
};
export const sectionDirections = Object.keys(directions);
const bounds = section => section.localBounds ?? { minX: 0, minZ: 0, maxX: section.bounds.x, maxZ: section.bounds.z };

/** Z increases toward the top of the overhead map. Keep local geometry intact. */
export function sectionPlacement(sections, sectionId, direction, origin = { x: 0, z: 0 }, checkOccupied = true) {
  const middle = sections[0], section = sections.find(item => item.id === sectionId);
  if (!middle || !section) throw new Error('Choose a section on this floor.');
  if (section === middle || !direction) return { placementX: section.placementX + origin.x, placementZ: section.placementZ + origin.z };
  const vector = directions[direction];
  if (!vector) throw new Error('Choose a position beside the middle section.');
  const base = bounds(middle), target = bounds(section), gap = 4;
  const axis = (delta, min, max, ownMin, ownMax, placement) => placement + (delta < 0 ? min - gap - ownMax : delta > 0 ? max + gap - ownMin : Math.round((min + max - ownMin - ownMax) / 2));
  const x = axis(vector[0], base.minX, base.maxX, target.minX, target.maxX, middle.placementX);
  const z = axis(vector[1], base.minZ, base.maxZ, target.minZ, target.maxZ, middle.placementZ);
  if (checkOccupied) for (const other of sections) {
    if (other.id === sectionId) continue;
    const b = bounds(other);
    if (x + target.minX < other.placementX + b.maxX && x + target.maxX > other.placementX + b.minX && z + target.minZ < other.placementZ + b.maxZ && z + target.maxZ > other.placementZ + b.minZ) {
      throw new Error(`That position overlaps ${other.name}. Choose another direction.`);
    }
  }
  return { placementX: x + origin.x, placementZ: z + origin.z };
}

export function currentSectionDirection(sections, sectionId) {
  if (sections[0]?.id === sectionId) return 'middle';
  const section = sections.find(item => item.id === sectionId);
  if (!section) return '';
  return sectionDirections.find(direction => {
    const position = sectionPlacement(sections, sectionId, direction, undefined, false);
    return position.placementX === section.placementX && position.placementZ === section.placementZ;
  }) ?? '';
}
