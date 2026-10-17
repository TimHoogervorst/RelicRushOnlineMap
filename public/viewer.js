const viewport = document.querySelector('#viewport');
const frame = document.querySelector('#map-frame');
const image = document.querySelector('#map');
const message = document.querySelector('#message');
const sidebar = document.querySelector('#sidebar');
const legendPanel = document.querySelector('#legend-panel');
const editorPanel = document.querySelector('#editor-panel');
const loginPanel = document.querySelector('#login-panel');
const setupPanel = document.querySelector('#setup-panel');
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

let editorOpen = false, sidebarOpen = true;
function renderSidebar() {
  sidebar.hidden = !sidebarOpen;
  document.querySelector('#sidebar-reopen').hidden = sidebarOpen;
  legendPanel.hidden = editorOpen;
  editorPanel.hidden = !editorOpen;
  const modeButton = document.querySelector('#edit-mode');
  modeButton.textContent = editorOpen ? 'Done editing' : 'Edit';
  modeButton.setAttribute('aria-pressed', String(editorOpen));
}
async function refreshSession() {
  const response = await fetch('/api/auth/session', { cache: 'no-store' });
  const state = await response.json();
  loginPanel.hidden = state.authenticated;
  setupPanel.hidden = !state.authenticated;
  if (state.authenticated) {
    const project = await fetch('/api/editor/project').then(result => result.json());
    document.querySelector('#setup-status').textContent = project.assetsConfigured
      ? `Minecraft ${project.assets.minecraftVersion} assets are configured.`
      : 'No matching assets are configured yet.';
  }
}
document.querySelector('#edit-mode').addEventListener('click', async () => {
  editorOpen = !editorOpen;
  if (editorOpen) await refreshSession();
  renderSidebar();
});
document.querySelector('#sidebar-close').addEventListener('click', () => { sidebarOpen = false; renderSidebar(); });
document.querySelector('#sidebar-reopen').addEventListener('click', () => { sidebarOpen = true; renderSidebar(); });
document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const status = document.querySelector('#login-status');
  const password = document.querySelector('#editor-password').value;
  const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const result = await response.json();
  status.textContent = response.ok ? '' : result.error;
  if (response.ok) { document.querySelector('#editor-password').value = ''; await refreshSession(); }
});
document.querySelector('#logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  await refreshSession();
});
document.querySelector('#upload-assets').addEventListener('click', async () => {
  const file = document.querySelector('#client-jar').files[0];
  const status = document.querySelector('#setup-status');
  if (!file) { status.textContent = 'Choose the Minecraft client JAR first.'; return; }
  status.textContent = 'Uploading and validating assets…';
  const response = await fetch('/api/assets/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const result = await response.json();
  status.textContent = response.ok ? `Minecraft ${result.assets.minecraftVersion} assets saved (${result.assets.blockTextures} textures).` : result.error;
});
renderSidebar();

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
