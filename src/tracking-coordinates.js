// World X/Z -> section X/Z. Existing sections were all flipped top-to-bottom.
export const DEFAULT_TRACKING_ORIENTATION = [1, 0, 0, -1];

export function worldToLocal(point, calibration, orientation = DEFAULT_TRACKING_ORIENTATION) {
  const [a, b, c, d] = orientation;
  // Waypoints identify cells; mirror continuous positions around their centers.
  const x = point.x - calibration.actual.x - 0.5, z = point.z - calibration.actual.z - 0.5;
  return { x: calibration.local.x + 0.5 + a * x + b * z, y: calibration.local.y + point.y - calibration.actual.y, z: calibration.local.z + 0.5 + c * x + d * z };
}

export function defaultTrackingRegion(blocks, calibration, orientation = DEFAULT_TRACKING_ORIENTATION) {
  if (!blocks.length) throw new Error('The section needs block geometry to initialize tracking limits.');
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const [a, b, c, d] = orientation;
  for (const block of blocks) {
    const x = block.x - calibration.local.x, z = block.z - calibration.local.z;
    // Signed permutation matrices are orthogonal: the inverse is the transpose.
    const world = { x: calibration.actual.x + a * x + c * z, y: calibration.actual.y + block.y - calibration.local.y, z: calibration.actual.z + b * x + d * z };
    for (const axis of ['x', 'y', 'z']) { min[axis] = Math.min(min[axis], world[axis]); max[axis] = Math.max(max[axis], world[axis] + 1); }
  }
  max.y += 3;
  return { min, max };
}

export function upgradeCalibration(calibration, blocks) {
  if (!calibration || calibration.coordinateVersion === 2) return calibration;
  const next = { ...calibration, coordinateVersion: 2 };
  if (calibration.invalidReason) next.invalidReason = 'This waypoint was invalidated before orientation tracking. Select its reference block again to replace it.';
  if (blocks.length && !calibration.invalidReason) {
    const oldDefault = defaultTrackingRegion(blocks, calibration, [1, 0, 0, 1]);
    const wasAutomatic = ['min', 'max'].every(side => ['x', 'y', 'z'].every(axis => oldDefault[side][axis] === calibration.region[side][axis]));
    if (wasAutomatic) next.region = defaultTrackingRegion(blocks, calibration);
  }
  return next;
}
