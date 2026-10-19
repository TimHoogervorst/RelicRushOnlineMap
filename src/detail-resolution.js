// Match the rasterizer's per-image memory ceiling; render the two levels serially.
export function detailPixelSize(dimensions, basePixelSize) {
  const maximum = Math.min(32, Math.floor(Math.sqrt(16_000_000 / (dimensions.x * dimensions.z))));
  return maximum > basePixelSize ? maximum : null;
}
