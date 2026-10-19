export function markerScale(zoom, minimum = 24) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const min = Number.isFinite(minimum) ? Math.max(16, Math.min(40, minimum)) : 24;
  return Math.max(min, Math.min(48, 28 * safeZoom)) / (28 * safeZoom);
}
