// The detail image shares the base image's layout dimensions. It never changes
// map coordinates, selection bounds, or the current camera position.
export function wantsMapDetail(zoom, pixelRatio = 1) {
  return zoom * Math.max(1, pixelRatio) > 1.25;
}

export function mountMapDetail(base, { createImage = () => new Image(), pixelRatio = () => window.devicePixelRatio || 1 } = {}) {
  let detail = null;
  let source = null, requested = null, ready = false, failed = false, wanted = false;
  function display() {
    if (detail) detail.hidden = !wanted || !ready;
    // Keep the base's layout and hit target, without showing its coarse edges
    // through transparent pixels of the higher-resolution render.
    base.style.opacity = wanted && ready ? '0' : '';
  }
  return {
    setFloor(floor) {
      const next = floor.detailImage ? `/api/map/image?revision=${encodeURIComponent(floor.projectRevision)}&floor=${encodeURIComponent(floor.id)}&v=${encodeURIComponent(floor.imageVersion)}&detail=1` : null;
      if (source === next) return;
      source = next; requested = null; ready = false; failed = false; wanted = false;
      detail?.remove(); detail = null;
      if (source) {
        const node = createImage(); detail = node;
        node.className = 'map-detail'; node.alt = ''; node.draggable = false; node.hidden = true;
        node.addEventListener('load', () => { if (node !== detail) return; ready = true; display(); });
        node.addEventListener('error', () => { if (node !== detail) return; failed = true; ready = false; display(); });
        base.after(node);
      }
      display();
    },
    update(zoom, preview = false) {
      wanted = Boolean(source) && !preview && wantsMapDetail(zoom, pixelRatio());
      display();
      if (wanted && !failed && requested !== source) { requested = source; detail.src = source; }
    },
  };
}
