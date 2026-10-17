const viewport = document.querySelector('#viewport');
const frame = document.querySelector('#map-frame');
const image = document.querySelector('#map');
const message = document.querySelector('#message');
let zoom = 1, offsetX = 0, offsetY = 0, pointer = null;

function drawTransform() { frame.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) scale(${zoom})`; }
function fitFloor() {
  if (!image.naturalWidth) return;
  zoom = Math.min((viewport.clientWidth - 64) / image.naturalWidth, (viewport.clientHeight - 64) / image.naturalHeight, 1.5);
  offsetX = 0; offsetY = 0; drawTransform();
}
function setZoom(value, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
  const next = Math.min(12, Math.max(.15, value));
  const rect = frame.getBoundingClientRect();
  const cx = anchorX - (rect.left + rect.width / 2), cy = anchorY - (rect.top + rect.height / 2);
  offsetX += cx * (1 - next / zoom); offsetY += cy * (1 - next / zoom); zoom = next; drawTransform();
}
document.querySelector('#fit').addEventListener('click', fitFloor);
document.querySelector('#zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
document.querySelector('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
viewport.addEventListener('wheel', event => { event.preventDefault(); setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY); }, { passive: false });
viewport.addEventListener('pointerdown', event => { pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; viewport.setPointerCapture(event.pointerId); frame.classList.add('dragging'); });
viewport.addEventListener('pointermove', event => { if (!pointer || pointer.id !== event.pointerId) return; offsetX += event.clientX - pointer.x; offsetY += event.clientY - pointer.y; pointer.x = event.clientX; pointer.y = event.clientY; drawTransform(); });
function endPointer(event) { if (pointer?.id === event.pointerId) { pointer = null; frame.classList.remove('dragging'); } }
viewport.addEventListener('pointerup', endPointer); viewport.addEventListener('pointercancel', endPointer);
image.addEventListener('load', fitFloor);

try {
  const response = await fetch('/api/map/manifest', { cache: 'no-store' });
  if (!response.ok) { const state = await response.json(); throw new Error(state.error ?? 'The starting map is not available yet.'); }
  const manifest = await response.json();
  image.src = `/api/map/image?revision=${encodeURIComponent(manifest.projectRevision)}`;
  image.hidden = false; message.hidden = true;
  document.querySelector('#caption').textContent = `${manifest.sectionName ?? 'Starting Area'} · Floor 0 · ${manifest.bounds.width} × ${manifest.bounds.depth}`;
} catch (error) {
  message.textContent = error.message;
}
