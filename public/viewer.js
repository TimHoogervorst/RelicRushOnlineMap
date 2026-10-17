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

let editorOpen = false, sidebarOpen = true, projectRevision = 0, publicMap = null;
function setSaveStatus(state) {
  const target = document.querySelector('#save-status');
  if (!target) return;
  const progress = state.progress ? ` ${state.progress.phase} ${state.progress.percent}%` : '';
  target.textContent = state.state === 'failed' ? `Failed: ${state.error}. Your edits are recoverable; retry Save.${progress}` : `${state.state[0].toUpperCase()}${state.state.slice(1)}${progress}`;
}
async function refreshSaveStatus() {
  const response = await fetch('/api/generation/status', { cache: 'no-store' });
  if (response.ok) { const state = await response.json(); projectRevision = state.projectRevision; setSaveStatus(state); }
}
async function saveProject() {
  setSaveStatus({ state: 'saving', progress: { phase: 'Queued', percent: 0 } });
  const poll = setInterval(() => void refreshSaveStatus(), 500);
  try {
    const response = await fetch('/api/generation/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Save failed.');
    setSaveStatus(result.status);
  } catch (error) { setSaveStatus({ state: 'failed', error: error.message }); }
  finally { clearInterval(poll); }
}
async function loadFloor(floorId) {
  const response = await fetch(`/api/map/manifest?floor=${encodeURIComponent(floorId)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('The saved floor is unavailable.');
  const floorManifest = await response.json();
  image.src = `/api/map/image?revision=${encodeURIComponent(floorManifest.projectRevision)}&floor=${encodeURIComponent(floorId)}`;
  image.hidden = false; message.hidden = true;
  const sections = (floorManifest.sections ?? []).map(section => section.name).join(' · ');
  document.querySelector('#caption').textContent = `${sections || floorManifest.name} · ${floorManifest.name} · ${floorManifest.bounds.width} × ${floorManifest.bounds.depth}`;
}
document.querySelector('#floor').addEventListener('change', event => loadFloor(event.target.value).catch(error => { message.textContent = error.message; message.hidden = false; }));
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
    const floors = await fetch('/api/project/floors').then(result => result.json());
    projectRevision = floors.revision;
    const selector = document.querySelector('#import-floor');
    selector.replaceChildren(new Option('Create a new floor', ''));
    for (const floor of floors.floors) selector.add(new Option(floor.name, floor.id));
    document.querySelector('#import-floor-name').disabled = Boolean(selector.value);
    await refreshSaveStatus();
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
document.querySelector('#import-floor').addEventListener('change', event => { document.querySelector('#import-floor-name').disabled = Boolean(event.target.value); });
document.querySelector('#import-schematic').addEventListener('click', async () => {
  const file = document.querySelector('#schematic-file').files[0];
  const status = document.querySelector('#import-status');
  if (!file) { status.textContent = 'Choose a Litematic file first.'; return; }
  const sectionName = document.querySelector('#import-section-name').value.trim() || file.name.replace(/\.litematic$/i, '');
  const floorId = document.querySelector('#import-floor').value;
  status.textContent = 'Validating and importing schematic…';
  const headers = { 'content-type': 'application/octet-stream', 'x-project-revision': String(projectRevision), 'x-source-name': file.name, 'x-section-name': sectionName, 'x-floor-name': document.querySelector('#import-floor-name').value.trim() || 'Floor 0' };
  if (floorId) headers['x-floor-id'] = floorId;
  const response = await fetch('/api/project/import', { method: 'POST', headers, body: file });
  const result = await response.json();
  status.textContent = response.ok ? `Imported ${result.blockCount} blocks into ${sectionName}. The source upload was removed.` : result.error;
  if (result.status) setSaveStatus(result.status);
  if (response.ok) { await refreshSession(); await loadFloor(document.querySelector('#floor').value); }
});
document.querySelector('#save-project').addEventListener('click', saveProject);
renderSidebar();

try {
  const response = await fetch('/api/map/manifest', { cache: 'no-store' });
  if (!response.ok) { const state = await response.json(); throw new Error(state.error ?? 'The starting map is not available yet.'); }
  publicMap = await response.json();
  const selector = document.querySelector('#floor');
  selector.replaceChildren(...publicMap.floors.map(floor => new Option(floor.name, floor.id)));
  await loadFloor(selector.value);
} catch (error) {
  message.textContent = error.message;
}
