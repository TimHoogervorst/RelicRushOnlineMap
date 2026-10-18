const viewport = document.querySelector('#viewport');
const frame = document.querySelector('#map-frame');
const image = document.querySelector('#map');
const message = document.querySelector('#message');
const sidebar = document.querySelector('#sidebar');
const legendPanel = document.querySelector('#legend-panel');
const editorPanel = document.querySelector('#editor-panel');
const loginPanel = document.querySelector('#login-panel');
const setupPanel = document.querySelector('#setup-panel');
const defaultHiddenBlocks = ['minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:decorated_pot', 'minecraft:player_head'];
let zoom = 1, offsetX = 0, offsetY = 0, pointer = null, slicePreviewActive = false;
const mapPointers = new Map();
let pinch = null, suppressMapClick = false;

function drawTransform() { frame.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) scale(${zoom})`; }
function fitFloor() {
  if (!image.naturalWidth) return;
  let minX = 0, minY = 0, maxX = image.naturalWidth, maxY = image.naturalHeight;
  const pixels = floorManifest?.renderer?.pixelSize ?? 16, depth = floorManifest?.bounds?.depth ?? 1;
  const include = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const section of floorManifest?.sections ?? []) {
    const x = (section.placementX + section.labelX) * pixels, y = (depth - 1 - section.placementZ - section.labelZ) * pixels;
    const halfWidth = Math.max(17, section.name.length * 3.5 + 8); include(x - halfWidth, y - 14); include(x + halfWidth, y + 14);
  }
  for (const marker of floorManifest?.markers ?? []) include(marker.x * pixels, marker.z * pixels);
  for (const link of floorManifest?.connections ?? []) {
    for (const point of [link.displayA, link.displayB]) include(point.x * pixels, (depth - 1 - point.z) * pixels);
    if (link.label) {
      const x = (link.displayA.x + link.displayB.x) * pixels / 2, y = (depth - 1 - (link.displayA.z + link.displayB.z) / 2) * pixels;
      include(x - link.label.length * 3.5, y - 12); include(x + link.label.length * 3.5, y + 3);
    }
  }
  const width = maxX - minX, height = maxY - minY;
  zoom = Math.min((viewport.clientWidth - 64) / width, (viewport.clientHeight - 64) / height, 1.5);
  offsetX = -((minX + maxX) / 2 - image.naturalWidth / 2) * zoom;
  offsetY = -((minY + maxY) / 2 - image.naturalHeight / 2) * zoom;
  drawTransform();
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
viewport.addEventListener('wheel', event => {
  event.preventDefault();
  if (event.altKey && editorOpen && editorAuthenticated && selectedBlocks.length) {
    pendingMoveDelta += event.deltaY > 0 ? 1 : -1; renderSelection();
    document.querySelector('#block-selection-status').textContent = `Preview: move ${selectedBlocks.length} blocks ${pendingMoveDelta > 0 ? 'up' : 'down'} ${Math.abs(pendingMoveDelta)} block${Math.abs(pendingMoveDelta) === 1 ? '' : 's'}. Click Move selection to commit.`;
    return;
  }
  setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY);
}, { passive: false });
viewport.addEventListener('pointerdown', event => {
  if (event.target.closest('.map-marker, .section-label, #marker-popup, #cell-popup, #block-inspector')) return;
  mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, target: event.target, moved: false, shiftKey: event.shiftKey });
  viewport.setPointerCapture(event.pointerId);
  if (mapPointers.size === 1) {
    pointer = { id: event.pointerId };
    frame.classList.add('dragging');
  } else {
    pointer = null;
    suppressMapClick = true;
    frame.classList.remove('dragging');
    if (mapPointers.size === 2) {
      const [a, b] = [...mapPointers.values()];
      pinch = { distance: Math.hypot(b.x - a.x, b.y - a.y), midpointX: (a.x + b.x) / 2, midpointY: (a.y + b.y) / 2 };
    }
  }
});
viewport.addEventListener('pointermove', event => {
  const moved = mapPointers.get(event.pointerId);
  if (!moved) return;
  if (Math.hypot(event.clientX - moved.startX, event.clientY - moved.startY) > 4) moved.moved = true;
  const previousX = moved.x, previousY = moved.y;
  moved.x = event.clientX; moved.y = event.clientY;
  if (mapPointers.size === 1 && pointer?.id === event.pointerId) {
    offsetX += event.clientX - previousX; offsetY += event.clientY - previousY;
    drawTransform();
    return;
  }
  if (mapPointers.size !== 2 || !pinch) return;
  const [a, b] = [...mapPointers.values()];
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const midpointX = (a.x + b.x) / 2, midpointY = (a.y + b.y) / 2;
  // Move the map with the gesture midpoint, then scale around that midpoint.
  offsetX += midpointX - pinch.midpointX; offsetY += midpointY - pinch.midpointY;
  if (pinch.distance > 0 && distance > 0) setZoom(zoom * distance / pinch.distance, midpointX, midpointY);
  else drawTransform();
  pinch = { distance, midpointX, midpointY };
});
function endPointer(event) {
  const ended = mapPointers.get(event.pointerId);
  if (!ended) return;
  mapPointers.delete(event.pointerId);
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  const wasPinching = pinch !== null || suppressMapClick;
  pinch = null;
  pointer = null;
  frame.classList.remove('dragging');
  if (mapPointers.size === 1) {
    const [id, remaining] = mapPointers.entries().next().value;
    pointer = { id };
    remaining.x = remaining.startX = remaining.x;
    remaining.y = remaining.startY = remaining.y;
    remaining.moved = true;
    if (viewport.hasPointerCapture(id)) viewport.setPointerCapture(id);
  }
  if (mapPointers.size === 0) {
    const click = !wasPinching && !ended.moved, target = ended.target, shiftKey = ended.shiftKey;
    suppressMapClick = false;
    if (click && editorOpen && floorManifest && target === image) void inspectBlockAt(event.clientX, event.clientY, shiftKey);
  }
}
viewport.addEventListener('pointerup', endPointer); viewport.addEventListener('pointercancel', endPointer); viewport.addEventListener('lostpointercapture', endPointer);
image.addEventListener('load', () => { if (!slicePreviewActive) fitFloor(); if (pendingCenterMarker) { const target = pendingCenterMarker; pendingCenterMarker = null; centerMarker(target); } renderSelection(); });

let editorOpen = false, editorAuthenticated = false, sidebarOpen = !window.matchMedia('(max-width: 600px)').matches, projectRevision = 0, publicMap = null, floorManifest = null, markerDrag = null, highlightedMarker = null, pendingCenterMarker = null;
let initialMarkerSection = null, initialMarkerDisplay = null;
let blockCatalog = [], paletteChoice = null, inspectedBlock = null, inspectedSection = null, inspectedCoords = null;
let selectedBlocks = [], pendingMoveDelta = 0, visibleHeight = 256, sliceMaximum = 256, slicePreviewTimer = null;
let layoutPreviewTimer = null, layoutConflicts = [];
const builtInMarkerTypes = [
  { id: 'chest', name: 'Chests', color: '#d89032', icon: 'chest', builtIn: true },
  { id: 'relic', name: 'Relics', color: '#a478d0', icon: 'relic', builtIn: true },
  { id: 'shop', name: 'Shops', color: '#55ae70', icon: 'shop', builtIn: true },
  { id: 'stairs', name: 'Stairs', color: '#57a9d6', icon: 'stairs', builtIn: true },
  { id: 'other', name: 'Other', color: '#aab3ba', icon: 'other', builtIn: true }
];
const markerTypes = () => floorManifest?.markerTypes ?? builtInMarkerTypes;
const markerType = id => markerTypes().find(type => type.id === id) ?? builtInMarkerTypes.find(type => type.id === id) ?? builtInMarkerTypes.at(-1);
const markerIcon = id => `/icons/${markerType(id).icon}.svg`;
const markerTitle = id => markerType(id).name;
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
  floorManifest = await response.json();
  slicePreviewActive = false;
  if (editorAuthenticated) {
    const rangeResponse = await fetch(`/api/project/height-range?floor=${encodeURIComponent(floorId)}`);
    if (rangeResponse.ok) {
      const range = await rangeResponse.json(), slider = document.querySelector('#block-slice');
      slider.min = String(Math.min(-1, range.minY)); slider.max = String(Math.max(1, range.maxY));
      sliceMaximum = Number(slider.max); visibleHeight = sliceMaximum; slider.value = String(sliceMaximum);
    }
  }
  image.src = `/api/map/image?revision=${encodeURIComponent(floorManifest.projectRevision)}&floor=${encodeURIComponent(floorId)}&v=${encodeURIComponent(floorManifest.imageVersion)}`;
  image.hidden = false; message.hidden = true;
  const sections = (floorManifest.sections ?? []).map(section => section.name).join(' · ');
  document.querySelector('#caption').textContent = `${sections || floorManifest.name} · ${floorManifest.name} · ${floorManifest.bounds.width} × ${floorManifest.bounds.depth}`;
  renderMarkers();
  renderConnections();
  renderSectionLabels();
  renderLayoutConflicts();
}

function renderSectionLabels() {
  if (!floorManifest) return;
  const layer = document.querySelector('#section-label-layer');
  layer.querySelectorAll('.section-label').forEach(label => label.remove());
  const pixels = floorManifest.renderer?.pixelSize ?? 16, depth = floorManifest.bounds?.depth ?? 1;
  const selector = document.querySelector('#layout-section');
  const previous = selector.value;
  selector.replaceChildren(...(floorManifest.sections ?? []).map(section => new Option(section.name, section.id)));
  if ((floorManifest.sections ?? []).some(section => section.id === previous)) selector.value = previous;
  else if (selector.options.length) selector.selectedIndex = 0;
  const selectedId = selector.value;
  for (const section of floorManifest.sections ?? []) {
    const label = document.createElement('button'); label.type = 'button'; label.className = `section-label${section.id === selectedId ? ' selected' : ''}`; label.dataset.sectionId = section.id; label.textContent = section.name;
    label.style.left = `${(section.placementX + section.labelX) * pixels}px`;
    label.style.top = `${(depth - 1 - section.placementZ - section.labelZ) * pixels}px`;
    label.title = 'Drag to move this whole section in snapped blocks';
    label.addEventListener('click', event => { event.stopPropagation(); selector.value = section.id; renderSectionLabels(); populateSectionLayout(); });
    label.addEventListener('pointerdown', event => {
      if (!editorOpen || !editorAuthenticated) return;
      event.stopPropagation(); event.preventDefault(); label.setPointerCapture(event.pointerId);
      selector.value = section.id; layer.querySelectorAll('.section-label').forEach(item => item.classList.toggle('selected', item.dataset.sectionId === section.id)); populateSectionLayout();
      label.dataset.drag = JSON.stringify({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, placementX: section.placementX, placementZ: section.placementZ });
    });
    label.addEventListener('pointermove', event => {
      if (!label.dataset.drag) return;
      const drag = JSON.parse(label.dataset.drag); if (drag.pointerId !== event.pointerId) return;
      const dx = Math.round((event.clientX - drag.x) / (pixels * zoom));
      const dz = -Math.round((event.clientY - drag.y) / (pixels * zoom));
      label.style.left = `${(section.placementX + section.labelX + dx) * pixels}px`;
      label.style.top = `${(depth - 1 - section.placementZ - section.labelZ - dz) * pixels}px`;
      scheduleLayoutPreview(section.id, section.placementX + dx, section.placementZ + dz);
    });
    const finishDrag = async event => {
      if (!label.dataset.drag) return;
      const drag = JSON.parse(label.dataset.drag); if (drag.pointerId !== event.pointerId) return;
      label.dataset.drag = '';
      const dx = Math.round((event.clientX - drag.x) / (pixels * zoom)), dz = -Math.round((event.clientY - drag.y) / (pixels * zoom));
      if (dx || dz) await saveSectionLayout(section, { placementX: drag.placementX + dx, placementZ: drag.placementZ + dz });
      else renderSectionLabels();
    };
    label.addEventListener('pointerup', finishDrag); label.addEventListener('pointercancel', finishDrag);
    layer.append(label);
  }
  populateSectionLayout();
}

function selectedLayoutSection() { return floorManifest?.sections.find(section => section.id === document.querySelector('#layout-section').value) ?? null; }
function populateSectionLayout() {
  const section = selectedLayoutSection(); if (!section) return;
  document.querySelector('#section-x').value = section.placementX;
  document.querySelector('#section-z').value = section.placementZ;
  document.querySelector('#section-label-x').value = section.labelX;
  document.querySelector('#section-label-z').value = section.labelZ;
  const settings = section.renderSettings ?? { cutaways: [], excludedBlocks: [], pixelSize: 16, heightShadePerBlock: 0.018 };
  document.querySelector('#render-cutaway').value = settings.cutaways.map(box => [box.x,box.y,box.z,box.width,box.height,box.depth].join(',')).join('\n');
  document.querySelector('#render-excluded').value = [...new Set([...defaultHiddenBlocks, ...settings.excludedBlocks])].join(', ');
  document.querySelector('#render-pixel-size').value = settings.pixelSize;
  const shadeStrength = Math.round(settings.heightShadePerBlock * 2000);
  document.querySelector('#render-height-shade').value = shadeStrength;
  document.querySelector('#render-height-shade-value').value = `${shadeStrength}%`;
}
function readRenderSettings() {
  const lines = document.querySelector('#render-cutaway').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const cutaways = lines.map(line => {
    const values = line.split(',').map(value => Number(value.trim()));
    if (values.length !== 6 || values.some(value => !Number.isSafeInteger(value))) throw new Error('Each cutaway line needs six whole numbers: x,y,z,width,height,depth.');
    const [x,y,z,width,height,depth] = values; return { x,y,z,width,height,depth };
  });
  return { cutaways, excludedBlocks: document.querySelector('#render-excluded').value.split(',').map(value => value.trim()).filter(Boolean), pixelSize: Number(document.querySelector('#render-pixel-size').value), heightShadePerBlock: Number(document.querySelector('#render-height-shade').value) / 2000 };
}
async function saveRenderSettings() {
  const section = selectedLayoutSection(), status = document.querySelector('#render-settings-status'); if (!section) return;
  try {
    const settings = readRenderSettings(); status.textContent = 'Saving settings and regenerating map…';
    const response = await fetch(`/api/project/sections/${encodeURIComponent(section.id)}/render-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, settings }) });
    const result = await response.json();
    if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
    projectRevision = result.revision; setSaveStatus(result.status ?? { state: 'saved' });
    if (!result.saved) { status.textContent = `Settings retained; ${result.warning}. Use Save to retry.`; return; }
    status.textContent = 'Render settings saved. The visitor map was regenerated.'; await loadFloor(floorManifest.id); await refreshSaveStatus();
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#render-settings-save').addEventListener('click', () => void saveRenderSettings());
document.querySelector('#render-shade-save').addEventListener('click', () => void saveRenderSettings());
document.querySelector('#render-height-shade').addEventListener('input', event => { document.querySelector('#render-height-shade-value').value = `${event.target.value}%`; });
async function renderSettingsHistory(direction) {
  const status = document.querySelector('#render-settings-status');
  const response = await fetch(`/api/project/render-settings/${direction}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
  const result = await response.json();
  if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
  projectRevision = result.revision; setSaveStatus(result.status ?? { state: 'saved' });
  if (!result.saved) { status.textContent = `Settings ${direction} retained; ${result.warning}. Use Save to retry.`; return; }
  status.textContent = `Render settings ${direction} complete.`; await loadFloor(floorManifest.id); await refreshSaveStatus();
}
document.querySelector('#render-settings-undo').addEventListener('click', () => void renderSettingsHistory('undo'));
document.querySelector('#render-settings-redo').addEventListener('click', () => void renderSettingsHistory('redo'));
function renderLayoutConflicts() {
  const svg = document.querySelector('#section-selection'); if (!svg || !floorManifest) return;
  const pixels = floorManifest.renderer?.pixelSize ?? 16, depth = floorManifest.bounds?.depth ?? 1, origin = floorManifest.coordinateOrigin ?? { x: 0, z: 0 };
  svg.setAttribute('viewBox', `0 0 ${image.naturalWidth || image.width} ${image.naturalHeight || image.height}`); svg.replaceChildren();
  for (const cell of layoutConflicts) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String((cell.x - origin.x) * pixels)); rect.setAttribute('y', String((depth - 1 - (cell.z - origin.z)) * pixels));
    rect.setAttribute('width', String(pixels)); rect.setAttribute('height', String(pixels)); rect.setAttribute('class', 'layout-conflict'); svg.append(rect);
  }
}
function scheduleLayoutPreview(sectionId = selectedLayoutSection()?.id, placementX = Number(document.querySelector('#section-x').value), placementZ = Number(document.querySelector('#section-z').value)) {
  if (!editorAuthenticated || !sectionId || !Number.isSafeInteger(placementX) || !Number.isSafeInteger(placementZ)) return;
  clearTimeout(layoutPreviewTimer);
  layoutPreviewTimer = setTimeout(async () => {
    const origin = floorManifest.coordinateOrigin ?? { x: 0, z: 0 };
    const query = new URLSearchParams({ placementX: String(placementX + origin.x), placementZ: String(placementZ + origin.z) });
    const response = await fetch(`/api/project/sections/${encodeURIComponent(sectionId)}/layout-preview?${query}`);
    if (!response.ok) return;
    layoutConflicts = (await response.json()).conflicts; renderLayoutConflicts();
    document.querySelector('#section-layout-status').textContent = layoutConflicts.length ? `${layoutConflicts.length} occupied block conflict${layoutConflicts.length === 1 ? '' : 's'} highlighted. Move the section before saving.` : 'No occupied placement conflicts.';
  }, 90);
}
async function saveSectionLayout(section = selectedLayoutSection(), values = null) {
  if (!section) return;
  const status = document.querySelector('#section-layout-status'); status.textContent = 'Checking section placement and saving floor…';
  const input = values ?? { placementX: Number(document.querySelector('#section-x').value), placementZ: Number(document.querySelector('#section-z').value), labelX: Number(document.querySelector('#section-label-x').value), labelZ: Number(document.querySelector('#section-label-z').value) };
  const origin = floorManifest.coordinateOrigin ?? { x: 0, z: 0 };
  const response = await fetch(`/api/project/sections/${encodeURIComponent(section.id)}/layout`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, ...input, placementX: input.placementX + origin.x, placementZ: input.placementZ + origin.z }) });
  const result = await response.json();
  if (!response.ok && response.status !== 202) { status.textContent = result.error; renderSectionLabels(); return false; }
  projectRevision = result.revision; setSaveStatus(result.status ?? { state: 'saved' });
  if (!result.saved) { status.textContent = `Layout retained; ${result.warning}. Use Save to retry.`; return false; }
  layoutConflicts = []; renderLayoutConflicts();
  status.textContent = 'Section layout saved. The floor bounds and visitor map were regenerated.';
  await loadFloor(floorManifest.id); await refreshSaveStatus(); return true;
}
document.querySelector('#layout-section').addEventListener('change', () => { renderSectionLabels(); populateSectionLayout(); });
document.querySelector('#section-layout-save').addEventListener('click', () => void saveSectionLayout());
async function sectionLayoutHistory(direction) {
  const status = document.querySelector('#section-layout-status');
  const response = await fetch(`/api/project/sections/layout/${direction}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
  const result = await response.json();
  if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
  projectRevision = result.revision; setSaveStatus(result.status ?? { state: 'saved' });
  if (!result.saved) { status.textContent = `Layout ${direction} retained; ${result.warning}. Use Save to retry.`; return; }
  status.textContent = `Section layout ${direction} complete.`; await loadFloor(floorManifest.id); await refreshSaveStatus();
}
document.querySelector('#section-layout-undo').addEventListener('click', () => void sectionLayoutHistory('undo'));
document.querySelector('#section-layout-redo').addEventListener('click', () => void sectionLayoutHistory('redo'));
for (const id of ['section-x', 'section-z']) document.querySelector(`#${id}`).addEventListener('input', () => scheduleLayoutPreview());
function renderSelection() {
  const svg = document.querySelector('#block-selection');
  if (!svg || !floorManifest) return;
  const pixels = floorManifest.renderer?.pixelSize ?? 16, depth = floorManifest.bounds?.depth ?? 1;
  svg.setAttribute('viewBox', `0 0 ${image.naturalWidth || image.width} ${image.naturalHeight || image.height}`);
  svg.replaceChildren();
  const section = inspectedSection;
  if (!section) return;
  for (const [list, className] of [[selectedBlocks, 'block-selection-cell'], [pendingMoveDelta ? selectedBlocks : [], 'block-selection-proposed']]) {
    for (const block of list) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String((block.x + section.placementX) * pixels));
      rect.setAttribute('y', String((depth - 1 - block.z - section.placementZ) * pixels));
      rect.setAttribute('width', String(pixels)); rect.setAttribute('height', String(pixels)); rect.setAttribute('class', className); svg.append(rect);
    }
  }
  const ys = selectedBlocks.map(block => block.y);
  document.querySelector('#block-selection-status').textContent = selectedBlocks.length
    ? `${selectedBlocks.length} selected · local Y ${Math.min(...ys)} to ${Math.max(...ys)}${pendingMoveDelta ? ` · proposed Y ${Math.min(...ys) + pendingMoveDelta} to ${Math.max(...ys) + pendingMoveDelta}` : ''}`
    : 'No group selected.';
  document.querySelector('#block-commit-move').disabled = !selectedBlocks.length || !pendingMoveDelta;
  document.querySelector('#block-cancel-move').hidden = !pendingMoveDelta;
}
function updateSlicePreview() {
  visibleHeight = Number(document.querySelector('#block-slice').value);
  document.querySelector('#block-slice-value').textContent = visibleHeight >= sliceMaximum ? 'All' : `Y ≤ ${visibleHeight}`;
  if (!editorAuthenticated || !floorManifest) return;
  clearTimeout(slicePreviewTimer);
  slicePreviewTimer = setTimeout(() => {
    slicePreviewActive = visibleHeight < sliceMaximum;
    image.src = slicePreviewActive
      ? `/api/project/preview?floor=${encodeURIComponent(floorManifest.id)}&maxY=${visibleHeight}&nonce=${Date.now()}`
      : `/api/map/image?revision=${encodeURIComponent(floorManifest.projectRevision)}&floor=${encodeURIComponent(floorManifest.id)}&v=${encodeURIComponent(floorManifest.imageVersion)}`;
  }, 250);
}
document.querySelector('#floor').addEventListener('change', event => loadFloor(event.target.value).catch(error => { message.textContent = error.message; message.hidden = false; }));
function renderSidebar() {
  sidebar.hidden = !sidebarOpen;
  document.querySelector('#sidebar-reopen').hidden = sidebarOpen;
  legendPanel.hidden = false;
  editorPanel.hidden = !editorOpen;
  document.querySelector('#sidebar-heading-title').textContent = editorOpen ? 'Editing tools' : 'Legend';
  const modeButton = document.querySelector('#edit-mode');
  modeButton.textContent = editorOpen ? 'Done editing' : 'Edit';
  modeButton.setAttribute('aria-pressed', String(editorOpen));
  document.querySelector('#marker-layer').classList.toggle('editing', editorOpen);
  document.querySelector('#block-inspector').hidden = !editorOpen || !inspectedCoords;
}

function collapseEditorSections(container) {
  let current = null;
  for (const child of [...container.children]) {
    if (child.tagName === 'H3') {
      current = document.createElement('details');
      current.className = 'editor-section';
      const summary = document.createElement('summary');
      summary.textContent = child.textContent;
      current.append(summary);
      container.insertBefore(current, child);
      child.remove();
    } else if (current) current.append(child);
  }
}
collapseEditorSections(setupPanel);
collapseEditorSections(editorPanel);
const blockInspector = document.querySelector('#block-inspector');
viewport.append(blockInspector);

function renderBlockPalette() {
  const host = document.querySelector('#block-palette');
  if (!host) return;
  host.replaceChildren();
  const query = document.querySelector('#block-search').value.trim().toLowerCase();
  for (const block of blockCatalog.filter(item => item.id.includes(query)).slice(0, 80)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'block-option'; button.role = 'option'; button.draggable = true; button.textContent = block.id.replace('minecraft:', '').replaceAll('_', ' '); button.title = block.id;
    button.addEventListener('click', () => chooseBlock(block.id));
    button.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-minecraft-block', block.id); event.dataTransfer.effectAllowed = 'copy'; });
    host.append(button);
  }
}
function chooseBlock(id) {
  const definition = blockCatalog.find(item => item.id === id); if (!definition) return;
  const existing = inspectedBlock?.id === id ? inspectedBlock.properties : {};
  paletteChoice = { id, properties: Object.fromEntries(Object.entries(definition.properties).map(([name, values]) => [name, values.includes(existing[name]) ? existing[name] : values[0]])) };
  renderBlockProperties();
  document.querySelector('#block-status').textContent = `Selected ${id}. Edit properties and save, or drag it onto the map.`;
}
function renderBlockProperties() {
  const host = document.querySelector('#block-properties'); host.replaceChildren();
  if (!paletteChoice) return;
  const definition = blockCatalog.find(item => item.id === paletteChoice.id);
  for (const [name, values] of Object.entries(definition?.properties ?? {})) {
    const label = document.createElement('label'); label.textContent = name;
    const select = document.createElement('select'); select.dataset.property = name;
    for (const value of values) select.add(new Option(value, value));
    select.value = paletteChoice.properties[name]; select.addEventListener('change', () => { paletteChoice.properties[name] = select.value; });
    label.append(select); host.append(label);
  }
  document.querySelector('#block-selected-state').textContent = `${paletteChoice.id} ${JSON.stringify(paletteChoice.properties)}`;
}
async function loadBlockPalette() {
  try {
    const response = await fetch('/api/project/block-palette'); const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    blockCatalog = data.blocks; renderBlockPalette();
  } catch (error) { document.querySelector('#block-status').textContent = error.message; }
}
function blockTargetAt(clientX, clientY) {
  const pixels = floorManifest?.renderer?.pixelSize ?? 16, rect = frame.getBoundingClientRect();
  const screenX = Math.floor((clientX - rect.left) / zoom / pixels), screenZ = Math.floor((clientY - rect.top) / zoom / pixels);
  const sections = floorManifest?.sections ?? [];
  const depth = floorManifest.bounds?.depth ?? 1;
  const section = sections.find(item => {
    const bounds = item.localBounds ?? { minX: 0, minZ: 0, maxX: item.bounds.x, maxZ: item.bounds.z };
    return screenX >= item.placementX + bounds.minX && screenX < item.placementX + bounds.maxX && screenZ > depth - 1 - item.placementZ - bounds.maxZ && screenZ <= depth - 1 - item.placementZ - bounds.minZ;
  });
  if (!section) return null;
  return { section, x: screenX - section.placementX, y: 0, z: depth - 1 - screenZ - section.placementZ, screenX, screenZ };
}
async function inspectBlockAt(clientX, clientY, additive = false) {
  const target = blockTargetAt(clientX, clientY); if (!target) return;
  try {
    const response = await fetch(`/api/project/sections/${encodeURIComponent(target.section.id)}/blocks`); const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const top = data.blocks.filter(block => block.y <= visibleHeight && block.x + target.section.placementX === target.screenX && floorManifest.bounds.depth - 1 - block.z - target.section.placementZ === target.screenZ).sort((a, b) => b.y - a.y)[0] ?? null;
    if (!additive || inspectedSection?.id !== target.section.id) { selectedBlocks = []; pendingMoveDelta = 0; }
    inspectedSection = target.section;
    if (top) {
      const key = `${top.x},${top.y},${top.z}`, existing = selectedBlocks.findIndex(block => `${block.x},${block.y},${block.z}` === key);
      if (additive && existing >= 0) selectedBlocks.splice(existing, 1);
      else if (!additive || existing < 0) selectedBlocks.push(top);
    }
    renderSelection();
    const x = top?.x ?? target.x, z = top?.z ?? target.z;
    inspectedSection = target.section; inspectedCoords = { sectionId: target.section.id, x, y: top?.y ?? 0, z };
    inspectedBlock = top; document.querySelector('#block-inspector').hidden = false;
    document.querySelector('#block-coordinate').textContent = `${target.section.name} · local X ${inspectedCoords.x}, Y ${inspectedCoords.y}, Z ${inspectedCoords.z}`;
    document.querySelector('#block-status').textContent = top ? 'Block selected.' : 'Empty cell selected at Y 0.';
    if (top) chooseBlock(top.id); else if (paletteChoice) renderBlockProperties();
    else document.querySelector('#block-selected-state').textContent = 'minecraft:air';
    const popup = document.querySelector('#cell-popup'), frameRect = frame.getBoundingClientRect();
    popup.style.left = `${(clientX - frameRect.left) / zoom + 12}px`;
    popup.style.top = `${(clientY - frameRect.top) / zoom + 12}px`;
    document.querySelector('#cell-coordinate').textContent = `${target.section.name} · ${x}, ${top?.y ?? 0}, ${z}`;
    popup.hidden = false;
  } catch (error) { document.querySelector('#block-status').textContent = error.message; }
}
async function saveSelectedBlock(state = paletteChoice) {
  if (!inspectedCoords) { document.querySelector('#block-status').textContent = 'Select a map cell first.'; return false; }
  const status = document.querySelector('#block-status'); status.textContent = 'Saving block and regenerating floor…';
  try {
    const response = await fetch('/api/project/blocks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, ...inspectedCoords, state }) });
    const result = await response.json(); if (!response.ok && response.status !== 202) throw new Error(result.error);
    projectRevision = result.revision; setSaveStatus(result.status ?? { state: 'saved' });
    if (!result.saved) status.textContent = `Edit retained; ${result.warning}. Use Save to retry.`;
    else { status.textContent = 'Block saved.'; await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus(); }
    return result.saved;
  } catch (error) { status.textContent = error.message; return false; }
}
document.querySelector('#block-search').addEventListener('input', renderBlockPalette);
document.querySelector('#block-save').addEventListener('click', () => void saveSelectedBlock());
document.querySelector('#block-delete').addEventListener('click', () => void saveSelectedBlock(null));
async function blockHistoryCommand(direction) {
  const response = await fetch(`/api/project/blocks/${direction}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
  const result = await response.json(); if (!response.ok) { document.querySelector('#block-status').textContent = result.error; return; }
  projectRevision = result.revision; setSaveStatus(result.status ?? { state: 'saved' });
  document.querySelector('#block-status').textContent = result.saved ? `Block ${direction} complete.` : `${direction} retained; ${result.warning}. Use Save to retry.`;
  if (result.saved) { await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus(); }
}
document.querySelector('#block-undo').addEventListener('click', () => void blockHistoryCommand('undo'));
document.querySelector('#block-redo').addEventListener('click', () => void blockHistoryCommand('redo'));
document.querySelector('#block-slice').addEventListener('input', updateSlicePreview);
document.querySelector('#block-clear-selection').addEventListener('click', () => { selectedBlocks = []; pendingMoveDelta = 0; renderSelection(); });
document.querySelector('#block-cancel-move').addEventListener('click', () => { pendingMoveDelta = 0; renderSelection(); });
document.querySelector('#block-commit-move').addEventListener('click', async () => {
  if (!selectedBlocks.length || !pendingMoveDelta || !inspectedSection) return;
  const status = document.querySelector('#block-selection-status'); status.textContent = 'Moving selected blocks and regenerating the floor…';
  const response = await fetch('/api/project/block-moves', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, sectionId: inspectedSection.id, blocks: selectedBlocks.map(({ x, y, z }) => ({ x, y, z })), dy: pendingMoveDelta }) });
  const result = await response.json();
  if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
  projectRevision = result.revision; setSaveStatus(result.status ?? { state: 'saved' });
  if (!result.saved) { status.textContent = `Move retained; ${result.warning}. Use Save to retry.`; return; }
  const floorId = document.querySelector('#floor').value;
  await loadFloor(floorId);
  selectedBlocks = result.after; inspectedSection = floorManifest.sections.find(item => item.id === result.sectionId) ?? null; pendingMoveDelta = 0;
  if (inspectedSection) { const block = selectedBlocks[0]; inspectedCoords = { sectionId: result.sectionId, x: block.x, y: block.y, z: block.z }; inspectedBlock = block; }
  if (visibleHeight < sliceMaximum) updateSlicePreview(); else renderSelection();
  await refreshSaveStatus();
});
viewport.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/x-minecraft-block')) event.preventDefault(); });
viewport.addEventListener('drop', async event => {
  const id = event.dataTransfer.getData('application/x-minecraft-block'); if (!id || !editorOpen) return;
  event.preventDefault(); const target = blockTargetAt(event.clientX, event.clientY); if (!target) return;
  inspectedSection = target.section; inspectedCoords = { sectionId: target.section.id, x: target.x, y: 0, z: target.z }; inspectedBlock = null;
  chooseBlock(id); document.querySelector('#block-inspector').hidden = false;
  document.querySelector('#block-coordinate').textContent = `${target.section.name} · local X ${target.x}, Y 0, Z ${target.z}`;
  await saveSelectedBlock();
});

function renderConnections() {
  if (!floorManifest) return;
  const svg = document.querySelector('#section-connections');
  const pixels = floorManifest.renderer?.pixelSize ?? 16, depth = floorManifest.bounds?.depth ?? 1;
  svg.setAttribute('viewBox', `0 0 ${image.naturalWidth || image.width} ${image.naturalHeight || image.height}`);
  svg.replaceChildren();
  for (const connection of floorManifest.connections ?? []) {
    const ax = connection.displayA.x * pixels, ay = (depth - 1 - connection.displayA.z) * pixels;
    const bx = connection.displayB.x * pixels, by = (depth - 1 - connection.displayB.z) * pixels;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(ax)); line.setAttribute('y1', String(ay)); line.setAttribute('x2', String(bx)); line.setAttribute('y2', String(by)); line.setAttribute('class', 'section-connection-line');
    line.dataset.connectionId = connection.id; svg.append(line);
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      const endpoint = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      endpoint.setAttribute('cx', String(x)); endpoint.setAttribute('cy', String(y)); endpoint.setAttribute('r', '5'); endpoint.setAttribute('class', 'section-connection-endpoint'); svg.append(endpoint);
    }
    if (connection.label) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String((ax + bx) / 2)); label.setAttribute('y', String((ay + by) / 2 - 8)); label.setAttribute('text-anchor', 'middle'); label.setAttribute('class', 'section-connection-label'); label.textContent = connection.label; svg.append(label);
    }
  }
  const select = document.querySelector('#connection-select'), previousId = select.value;
  select.replaceChildren(new Option('New connection', ''), ...(floorManifest.connections ?? []).map(item => new Option(item.label || `${sectionName(item.sectionAId)} ↔ ${sectionName(item.sectionBId)}`, item.id)));
  if ((floorManifest.connections ?? []).some(item => item.id === previousId)) select.value = previousId;
  const sections = floorManifest.sections ?? [];
  for (const id of ['connection-a', 'connection-b']) {
    const sectionSelect = document.querySelector(`#${id}`), previousSection = sectionSelect.value;
    sectionSelect.replaceChildren(...sections.map(section => new Option(section.name, section.id)));
    if (sections.some(section => section.id === previousSection)) sectionSelect.value = previousSection;
  }
  const selected = (floorManifest.connections ?? []).find(item => item.id === select.value);
  const form = document.querySelector('#connection-form');
  document.querySelector('#connection-delete').hidden = !selected;
  if (selected && document.activeElement !== form.querySelector('input:focus')) {
    document.querySelector('#connection-a').value = selected.sectionAId; document.querySelector('#connection-b').value = selected.sectionBId;
    for (const [id, value] of [['connection-x-a', selected.xA], ['connection-z-a', selected.zA], ['connection-x-b', selected.xB], ['connection-z-b', selected.zB], ['connection-label', selected.label]]) document.querySelector(`#${id}`).value = value;
  }
  if (!selected) {
    if (sections.length > 1 && document.querySelector('#connection-a').value === document.querySelector('#connection-b').value) document.querySelector('#connection-b').selectedIndex = 1;
    for (const id of ['connection-x-a', 'connection-z-a', 'connection-x-b', 'connection-z-b']) if (!document.querySelector(`#${id}`).value) document.querySelector(`#${id}`).value = '0.5';
  }
}
function sectionName(id) { return floorManifest?.sections.find(section => section.id === id)?.name ?? 'Section'; }

function renderMarkers() {
  if (!floorManifest) return;
  const markers = floorManifest.markers ?? [];
  const pixels = floorManifest.renderer?.pixelSize ?? 16;
  const layer = document.querySelector('#marker-layer');
  layer.replaceChildren();
  for (const marker of markers) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'map-marker'; button.dataset.markerId = marker.id;
    button.dataset.type = marker.type;
    button.style.left = `${marker.x * pixels}px`; button.style.top = `${marker.z * pixels}px`;
    button.style.backgroundImage = `url("${markerIcon(marker.type)}")`;
    button.style.setProperty('--marker-color', markerType(marker.type).color);
    button.style.borderColor = markerType(marker.type).color;
    button.setAttribute('aria-label', `${markerTitle(marker.type)}: ${marker.name}`);
    button.hidden = !editorOpen && highlightedMarker !== marker.id && !readMarkerVisibility(floorManifest.id, marker.type);
    button.title = marker.name;
    button.classList.toggle('highlighted', highlightedMarker === marker.id);
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (editorOpen) { populateMarkerForm(marker); return; }
      highlightedMarker = marker.id; renderMarkers();
      if (marker.type === 'stairs') { void followStair(marker); return; }
      centerMarker(marker);
      const popup = document.querySelector('#marker-popup');
      document.querySelector('#popup-name').textContent = marker.name;
      const note = marker.type === 'stairs' && !marker.stairDestinationId ? 'Destination not yet mapped.' : '';
      document.querySelector('#popup-description').textContent = [marker.description, note].filter(Boolean).join('\n');
      popup.style.left = `${marker.x * pixels + 14}px`; popup.style.top = `${marker.z * pixels + 14}px`; popup.hidden = false;
    });
    button.addEventListener('pointerdown', event => {
      if (!editorOpen) return;
      event.stopPropagation(); event.preventDefault(); button.setPointerCapture(event.pointerId);
      markerDrag = { id: marker.id, pointerId: event.pointerId, marker };
      populateMarkerForm(marker);
    });
    button.addEventListener('pointermove', event => {
      if (!markerDrag || markerDrag.pointerId !== event.pointerId || markerDrag.id !== marker.id) return;
      const rect = frame.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / zoom) / pixels;
      const z = ((event.clientY - rect.top) / zoom) / pixels;
      button.style.left = `${x * pixels}px`; button.style.top = `${z * pixels}px`;
      markerDrag.displayX = x; markerDrag.displayZ = z;
    });
    button.addEventListener('pointerup', async event => {
      if (!markerDrag || markerDrag.pointerId !== event.pointerId || markerDrag.id !== marker.id) return;
      const drag = markerDrag; markerDrag = null;
      if (drag.displayX === undefined) return;
      const section = floorManifest.sections.find(item => item.id === marker.sectionId);
      if (!section) return;
      document.querySelector('#marker-section').value = section.id;
      document.querySelector('#marker-x').value = (drag.displayX - section.placementX).toFixed(2);
      document.querySelector('#marker-z').value = (drag.displayZ - section.placementZ).toFixed(2);
      await persistMarker(marker.id);
    });
    layer.append(button);
  }
  const sections = floorManifest.sections ?? [];
  const sectionSelect = document.querySelector('#marker-section');
  const selectedSection = sectionSelect.value;
  sectionSelect.replaceChildren(...sections.map(section => new Option(section.name, section.id)));
  if (sections.some(section => section.id === selectedSection)) sectionSelect.value = selectedSection;
  const typeSelect = document.querySelector('#marker-type'), selectedType = typeSelect.value;
  typeSelect.replaceChildren(...markerTypes().map(type => new Option(type.name, type.id)));
  if (markerTypes().some(type => type.id === selectedType)) typeSelect.value = selectedType;
  renderCustomMarkerTypeEditor();
  const groups = document.querySelector('#legend-groups'); groups.replaceChildren();
  pruneMarkerVisibility(floorManifest.id, markerTypes().map(type => type.id));
  for (const type of markerTypes()) {
    const typed = markers.filter(marker => marker.type === type.id);
    if (!typed.length) continue;
    const details = document.createElement('details'); details.open = true;
    const summary = document.createElement('summary');
    summary.style.color = type.color;
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = readMarkerVisibility(floorManifest.id, type.id); check.setAttribute('aria-label', `Show ${type.name.toLowerCase()}`);
    check.addEventListener('click', event => event.stopPropagation());
    check.addEventListener('change', () => { storeMarkerVisibility(floorManifest.id, type.id, check.checked); layer.querySelectorAll(`[data-type="${type.id}"]`).forEach(item => item.hidden = !check.checked); });
    summary.append(check, ` ${type.name}`); details.append(summary);
    for (const marker of typed) {
      const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'legend-entry';
      const icon = document.createElement('img'); icon.src = markerIcon(type.id); icon.alt = '';
      icon.style.borderColor = type.color;
      icon.style.border = `2px solid ${type.color}`;
      entry.append(icon, document.createTextNode(marker.name));
      entry.addEventListener('click', () => {
        if (editorOpen) { populateMarkerForm(marker); return; }
        highlightedMarker = marker.id; renderMarkers(); centerMarker(marker);
      });
      details.append(entry);
    }
    groups.append(details);
  }
  if (!groups.childElementCount) groups.innerHTML = '<p>No markers on this floor.</p>';
}
function connectionFormValue() {
  return { sectionAId: document.querySelector('#connection-a').value, xA: Number(document.querySelector('#connection-x-a').value), zA: Number(document.querySelector('#connection-z-a').value), sectionBId: document.querySelector('#connection-b').value, xB: Number(document.querySelector('#connection-x-b').value), zB: Number(document.querySelector('#connection-z-b').value), label: document.querySelector('#connection-label').value };
}
document.querySelector('#connection-select').addEventListener('change', renderConnections);
document.querySelector('#connection-new').addEventListener('click', () => { document.querySelector('#connection-select').value = ''; document.querySelector('#connection-delete').hidden = true; document.querySelector('#connection-x-a').value = '0.5'; document.querySelector('#connection-z-a').value = '0.5'; document.querySelector('#connection-x-b').value = '0.5'; document.querySelector('#connection-z-b').value = '0.5'; document.querySelector('#connection-label').value = ''; if (floorManifest?.sections.length > 1) { document.querySelector('#connection-a').selectedIndex = 0; document.querySelector('#connection-b').selectedIndex = 1; } });
document.querySelector('#connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const status = document.querySelector('#connection-status'), id = document.querySelector('#connection-select').value;
  const response = await fetch(id ? `/api/project/connections/${encodeURIComponent(id)}` : '/api/project/connections', { method: id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, connection: connectionFormValue() }) });
  const result = await response.json();
  if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
  projectRevision = result.revision; setSaveStatus(result.status ?? { state: 'saved' });
  status.textContent = result.saved ? 'Connection saved.' : `Connection saved locally; ${result.warning}. Use Save to retry.`;
  if (result.connection) document.querySelector('#connection-select').value = result.connection.id;
  if (result.saved) { await loadFloor(floorManifest.id); await refreshSaveStatus(); }
});
document.querySelector('#connection-delete').addEventListener('click', async () => {
  const id = document.querySelector('#connection-select').value;
  if (!id) return;
  const response = await fetch(`/api/project/connections/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
  const result = await response.json(), status = document.querySelector('#connection-status');
  if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
  projectRevision = result.revision; document.querySelector('#connection-select').value = ''; status.textContent = 'Connection deleted.';
  setSaveStatus(result.status ?? { state: 'saved' }); if (result.saved) { await loadFloor(floorManifest.id); await refreshSaveStatus(); }
});
async function connectionHistoryCommand(direction) {
  const response = await fetch(`/api/project/connections/${direction}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
  const result = await response.json(), status = document.querySelector('#connection-status');
  if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
  projectRevision = result.revision; setSaveStatus(result.status ?? { state: 'saved' }); status.textContent = `Connection ${direction} complete.`;
  if (result.saved) { await loadFloor(floorManifest.id); await refreshSaveStatus(); }
}
document.querySelector('#connection-undo').addEventListener('click', () => void connectionHistoryCommand('undo'));
document.querySelector('#connection-redo').addEventListener('click', () => void connectionHistoryCommand('redo'));

function readMarkerVisibility(floorId, type) {
  try { const value = JSON.parse(localStorage.getItem(`rr-marker-visibility:${floorId}`) ?? '{}'); return value[type] !== false; } catch { return true; }
}
function storeMarkerVisibility(floorId, type, visible) {
  try { const key = `rr-marker-visibility:${floorId}`; const value = JSON.parse(localStorage.getItem(key) ?? '{}'); value[type] = visible; localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be disabled */ }
}
function pruneMarkerVisibility(_floorId, typeIds) {
  try {
    const valid = new Set(typeIds);
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith('rr-marker-visibility:')) continue;
      const value = JSON.parse(localStorage.getItem(key) ?? '{}');
      for (const id of Object.keys(value)) if (!valid.has(id)) delete value[id];
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch { /* storage may be disabled or contain malformed preferences */ }
}
function renderCustomMarkerTypeEditor() {
  const select = document.querySelector('#custom-marker-type-select');
  if (!select) return;
  const previous = select.value, customTypes = markerTypes().filter(type => !type.builtIn);
  select.replaceChildren(new Option('New type', ''), ...customTypes.map(type => new Option(type.name, type.id)));
  if (customTypes.some(type => type.id === previous)) select.value = previous;
  const current = customTypes.find(type => type.id === select.value);
  document.querySelector('#custom-marker-type-name').value = current?.name ?? '';
  document.querySelector('#custom-marker-type-color').value = current?.color ?? '#d89032';
  document.querySelector('#custom-marker-type-icon').value = current?.icon ?? 'other';
  document.querySelector('#custom-marker-type-delete').hidden = !current;
  const replacementLabel = document.querySelector('#custom-marker-type-replacement-label');
  replacementLabel.hidden = !current;
  const replacement = document.querySelector('#custom-marker-type-replacement'), existing = replacement.value;
  replacement.replaceChildren(...markerTypes().filter(type => type.id !== current?.id).map(type => new Option(type.name, type.id)));
  if ([...replacement.options].some(option => option.value === existing)) replacement.value = existing;
  else replacement.value = 'other';
}
document.querySelector('#custom-marker-type-select').addEventListener('change', renderCustomMarkerTypeEditor);
document.querySelector('#custom-marker-type-new').addEventListener('click', () => { document.querySelector('#custom-marker-type-select').value = ''; renderCustomMarkerTypeEditor(); });
document.querySelector('#custom-marker-type-form').addEventListener('submit', async event => {
  event.preventDefault();
  const select = document.querySelector('#custom-marker-type-select'), id = select.value;
  const status = document.querySelector('#custom-marker-type-status');
  const type = { name: document.querySelector('#custom-marker-type-name').value, color: document.querySelector('#custom-marker-type-color').value, icon: document.querySelector('#custom-marker-type-icon').value };
  const response = await fetch(id ? `/api/project/marker-types/${encodeURIComponent(id)}` : '/api/project/marker-types', { method: id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, type }) });
  const result = await response.json();
  if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
  projectRevision = result.revision;
  status.textContent = result.saved ? 'Marker type saved.' : `Type saved locally; ${result.warning}. Use Save to retry.`;
  const selectedId = result.type?.id ?? id;
  if (result.saved) { await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus(); document.querySelector('#custom-marker-type-select').value = selectedId; renderCustomMarkerTypeEditor(); }
});
document.querySelector('#custom-marker-type-delete').addEventListener('click', async () => {
  const id = document.querySelector('#custom-marker-type-select').value;
  const replacementType = document.querySelector('#custom-marker-type-replacement').value;
  if (!id || !replacementType || !window.confirm('Delete this type and move its markers to the selected replacement?')) return;
  const status = document.querySelector('#custom-marker-type-status');
  const response = await fetch(`/api/project/marker-types/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, replacementType }) });
  const result = await response.json();
  if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
  projectRevision = result.revision; status.textContent = result.saved ? 'Marker type deleted.' : `Type deleted locally; ${result.warning}. Use Save to retry.`;
  if (result.saved) { await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus(); document.querySelector('#custom-marker-type-select').value = ''; renderCustomMarkerTypeEditor(); }
});
async function markerTypeHistoryCommand(direction) {
  const status = document.querySelector('#custom-marker-type-status');
  const response = await fetch(`/api/project/marker-types/${direction}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
  const result = await response.json();
  if (!response.ok && response.status !== 202) { status.textContent = result.error; return; }
  projectRevision = result.revision; status.textContent = `Marker type ${direction} complete.`;
  if (result.saved) { await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus(); }
}
document.querySelector('#marker-type-undo').addEventListener('click', () => void markerTypeHistoryCommand('undo'));
document.querySelector('#marker-type-redo').addEventListener('click', () => void markerTypeHistoryCommand('redo'));
function centerMarker(marker) {
  if (!image.naturalWidth) { pendingCenterMarker = marker; return; }
  const pixels = floorManifest.renderer?.pixelSize ?? 16;
  const maxX = Math.max(0, image.naturalWidth * zoom / 2 - 36), maxY = Math.max(0, image.naturalHeight * zoom / 2 - 36);
  offsetX = Math.max(-maxX, Math.min(maxX, -(marker.x * pixels - image.naturalWidth / 2) * zoom));
  offsetY = Math.max(-maxY, Math.min(maxY, -(marker.z * pixels - image.naturalHeight / 2) * zoom));
  drawTransform();
}
async function refreshPublicManifest() {
  const response = await fetch('/api/map/manifest', { cache: 'no-store' });
  if (response.ok) {
    publicMap = await response.json();
    const selector = document.querySelector('#floor'), selected = selector.value;
    selector.replaceChildren(...publicMap.floors.map(floor => new Option(floor.name, floor.id)));
    selector.value = publicMap.floors.some(floor => floor.id === selected) ? selected : (publicMap.floors[0]?.id ?? '');
  }
}
async function followStair(marker) {
  if (!marker.stairDestinationId) { showMarkerPopup(marker, 'Destination not yet mapped.'); return; }
  try {
    await refreshPublicManifest();
    const destinationFloor = publicMap?.floors?.find(floor => floor.markers?.some(item => item.id === marker.stairDestinationId));
    const destination = destinationFloor?.markers?.find(item => item.id === marker.stairDestinationId);
    if (!destination || destination.type !== 'stairs' || destination.stairDestinationId !== marker.id) {
      showMarkerPopup(marker, 'Destination unavailable. Ask the map owner to relink these stairs.'); return;
    }
    highlightedMarker = destination.id;
    if (destinationFloor.id !== floorManifest.id) {
      document.querySelector('#floor').value = destinationFloor.id;
      pendingCenterMarker = destination;
      await loadFloor(destinationFloor.id);
    } else {
      renderMarkers(); centerMarker(destination);
    }
    document.querySelector('#marker-popup').hidden = true;
  } catch (error) { showMarkerPopup(marker, `Destination unavailable. ${error.message}`); }
}
function showMarkerPopup(marker, note = '') {
  const pixels = floorManifest.renderer?.pixelSize ?? 16, popup = document.querySelector('#marker-popup');
  document.querySelector('#popup-name').textContent = marker.name;
  document.querySelector('#popup-description').textContent = [marker.description, note].filter(Boolean).join('\n');
  popup.style.left = `${marker.x * pixels + 14}px`; popup.style.top = `${marker.z * pixels + 14}px`; popup.hidden = false;
}
function populateMarkerForm(marker = null) {
  document.querySelector('#marker-id').value = marker?.id ?? '';
  document.querySelector('#marker-type').value = marker?.type ?? 'chest';
  document.querySelector('#marker-name').value = marker?.name ?? '';
  document.querySelector('#marker-description').value = marker?.description ?? '';
  const section = floorManifest?.sections.find(item => item.id === marker?.sectionId) ?? floorManifest?.sections[0];
  if (section) document.querySelector('#marker-section').value = section.id;
  document.querySelector('#marker-x').value = marker?.localX ?? 0.5;
  document.querySelector('#marker-z').value = marker?.localZ ?? 0.5;
  document.querySelector('#marker-delete').hidden = !marker;
  document.querySelector('#preserve-marker-position').checked = true;
  initialMarkerSection = marker?.sectionId ?? null;
  initialMarkerDisplay = marker ? { x: marker.x, z: marker.z } : null;
  void refreshStairControls(marker);
}
async function refreshStairControls(marker = null) {
  const box = document.querySelector('#stair-link-controls');
  const isSavedStair = marker?.type === 'stairs' && Boolean(marker.id);
  box.hidden = !editorAuthenticated || !isSavedStair;
  if (!isSavedStair) return;
  const response = await fetch('/api/project/stairs', { cache: 'no-store' });
  if (!response.ok) { document.querySelector('#marker-status').textContent = 'Could not load stair destinations.'; return; }
  const { stairs } = await response.json();
  const candidates = stairs.filter(stair => stair.id !== marker.id && stair.floorId !== floorManifest.id);
  const select = document.querySelector('#stair-destination');
  select.replaceChildren(new Option(candidates.length ? 'Choose a destination' : 'No stairs on another floor', ''));
  for (const stair of candidates) select.add(new Option(`${stair.floorName} · ${stair.name}`, stair.id));
  if (marker.stairDestinationId && candidates.some(stair => stair.id === marker.stairDestinationId)) select.value = marker.stairDestinationId;
  document.querySelector('#stair-link').hidden = Boolean(marker.stairDestinationId);
  document.querySelector('#stair-unlink').hidden = !marker.stairDestinationId;
}
document.querySelector('#stair-link').addEventListener('click', async () => {
  const firstId = document.querySelector('#marker-id').value, secondId = document.querySelector('#stair-destination').value;
  if (!firstId || !secondId) { document.querySelector('#marker-status').textContent = 'Choose a stair destination on another floor.'; return; }
  const response = await fetch('/api/project/stairs/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, firstId, secondId }) });
  const result = await response.json();
  if (!response.ok) { document.querySelector('#marker-status').textContent = result.error; return; }
  projectRevision = result.revision;
  if (!result.saved) { document.querySelector('#marker-status').textContent = `Stair link saved locally; ${result.warning}. Use Save to retry.`; return; }
  document.querySelector('#marker-status').textContent = 'Stairs linked in both directions.';
  await refreshPublicManifest(); await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus();
  const current = floorManifest.markers.find(marker => marker.id === firstId); if (current) populateMarkerForm(current);
});
document.querySelector('#stair-unlink').addEventListener('click', async () => {
  const id = document.querySelector('#marker-id').value;
  if (!id || !window.confirm('Unlink both stairs? Their markers will remain.')) return;
  const response = await fetch(`/api/project/stairs/${encodeURIComponent(id)}/link`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
  const result = await response.json();
  if (!response.ok) { document.querySelector('#marker-status').textContent = result.error; return; }
  projectRevision = result.revision;
  if (!result.saved) { document.querySelector('#marker-status').textContent = `Stairs unlinked locally; ${result.warning}. Use Save to retry.`; return; }
  await refreshPublicManifest(); await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus();
  const current = floorManifest.markers.find(marker => marker.id === id); if (current) populateMarkerForm(current);
  document.querySelector('#marker-status').textContent = 'Stairs unlinked.';
});
document.querySelector('#marker-section').addEventListener('change', event => {
  if (!initialMarkerSection || !initialMarkerDisplay || !document.querySelector('#preserve-marker-position').checked) return;
  const oldSection = floorManifest.sections.find(section => section.id === initialMarkerSection);
  const nextSection = floorManifest.sections.find(section => section.id === event.target.value);
  if (!oldSection || !nextSection) return;
  document.querySelector('#marker-x').value = (initialMarkerDisplay.x - nextSection.placementX).toFixed(2);
  document.querySelector('#marker-z').value = (initialMarkerDisplay.z - nextSection.placementZ).toFixed(2);
});
async function persistMarker(id = document.querySelector('#marker-id').value, preserveDisplayedPosition = false) {
  const status = document.querySelector('#marker-status');
  const marker = { type: document.querySelector('#marker-type').value, name: document.querySelector('#marker-name').value, description: document.querySelector('#marker-description').value, sectionId: document.querySelector('#marker-section').value, x: Number(document.querySelector('#marker-x').value), z: Number(document.querySelector('#marker-z').value) };
  status.textContent = 'Saving marker…';
  try {
    const keepDisplayedPosition = Boolean(id && marker.sectionId !== initialMarkerSection && document.querySelector('#preserve-marker-position').checked);
    const previous = id ? floorManifest.markers.find(item => item.id === id) : null;
    const confirmUnlink = Boolean(previous?.stairDestinationId && marker.type !== 'stairs');
    if (confirmUnlink && !window.confirm('Changing this stair type will unlink its partner. Continue?')) return false;
    const response = await fetch(id ? `/api/project/markers/${encodeURIComponent(id)}` : '/api/project/markers', { method: id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, marker, preserveDisplayedPosition: preserveDisplayedPosition || keepDisplayedPosition, confirmUnlink }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Marker save failed.');
    projectRevision = result.marker?.revision ?? result.revision ?? projectRevision;
    if (!result.saved) { status.textContent = `Marker kept as a recoverable edit; ${result.warning}. Use Save to retry.`; setSaveStatus({ state: 'failed', error: result.warning }); return false; }
    status.textContent = 'Marker saved.'; await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus();
    if (!id && result.marker) populateMarkerForm(result.marker);
    return true;
  } catch (error) { status.textContent = error.message; return false; }
}
document.querySelector('#marker-form').addEventListener('submit', event => { event.preventDefault(); void persistMarker(); });
document.querySelector('#marker-new').addEventListener('click', () => populateMarkerForm());
function openEditorSection(title) {
  const details = [...editorPanel.querySelectorAll('details.editor-section')].find(item => item.querySelector('summary')?.textContent.trim() === title);
  if (details) details.open = true;
  sidebarOpen = true;
  renderSidebar();
}
document.querySelector('#cell-add-marker').addEventListener('click', () => {
  if (!inspectedSection || !inspectedCoords) return;
  openEditorSection('Markers');
  populateMarkerForm();
  document.querySelector('#marker-section').value = inspectedSection.id;
  document.querySelector('#marker-x').value = inspectedCoords.x + 0.5;
  document.querySelector('#marker-z').value = inspectedCoords.z + 0.5;
  document.querySelector('#cell-popup').hidden = true;
});
document.querySelector('#cell-add-connection').addEventListener('click', () => {
  if (!inspectedSection || !inspectedCoords) return;
  openEditorSection('Section connections');
  document.querySelector('#connection-new').click();
  document.querySelector('#connection-a').value = inspectedSection.id;
  document.querySelector('#connection-x-a').value = inspectedCoords.x + 0.5;
  document.querySelector('#connection-z-a').value = inspectedCoords.z + 0.5;
  const other = floorManifest.sections.find(section => section.id !== inspectedSection.id);
  if (other) document.querySelector('#connection-b').value = other.id;
  document.querySelector('#cell-popup').hidden = true;
});
document.querySelector('#marker-delete').addEventListener('click', async () => {
  const id = document.querySelector('#marker-id').value;
  const marker = floorManifest.markers.find(item => item.id === id), linked = Boolean(marker?.stairDestinationId);
  if (!id || !window.confirm(linked ? 'Delete this stair and unlink its partner? This cannot be undone.' : 'Delete this marker? This cannot be undone.')) return;
  const response = await fetch(`/api/project/markers/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, confirmUnlink: linked }) });
  const result = await response.json();
  if (!response.ok) { document.querySelector('#marker-status').textContent = result.error; return; }
  projectRevision = result.revision; populateMarkerForm();
  document.querySelector('#marker-status').textContent = result.saved ? 'Marker deleted.' : `Deletion saved locally; ${result.warning}. Use Save to retry.`;
  if (result.saved) { await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus(); }
});
async function markerHistoryCommand(direction) {
  const status = document.querySelector('#marker-status');
  const response = await fetch(`/api/project/markers/${direction}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
  const result = await response.json();
  if (!response.ok) { status.textContent = result.error; return; }
  projectRevision = result.revision;
  if (!result.saved) { status.textContent = `${direction} retained as a recoverable edit; ${result.warning}. Use Save to retry.`; return; }
  status.textContent = `Marker ${direction} complete.`;
  populateMarkerForm(); await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus();
}
document.querySelector('#marker-undo').addEventListener('click', () => void markerHistoryCommand('undo'));
document.querySelector('#marker-redo').addEventListener('click', () => void markerHistoryCommand('redo'));
document.addEventListener('keydown', event => {
  if (!editorOpen || !(event.ctrlKey || event.metaKey) || !['z', 'y'].includes(event.key.toLowerCase())) return;
  if (event.target.matches('input,textarea,select,[contenteditable=true]')) return;
  event.preventDefault(); void markerHistoryCommand(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
});
document.querySelector('#popup-close').addEventListener('click', () => { document.querySelector('#marker-popup').hidden = true; });
async function refreshSession() {
  const response = await fetch('/api/auth/session', { cache: 'no-store' });
  const state = await response.json();
  editorAuthenticated = state.authenticated;
  loginPanel.hidden = state.authenticated;
  setupPanel.hidden = !state.authenticated;
  if (state.authenticated) {
    const project = await fetch('/api/editor/project').then(result => result.json());
    document.querySelector('#setup-status').textContent = project.assetsConfigured
      ? `Minecraft ${project.assets.minecraftVersion} assets are configured.`
      : 'No matching assets are configured yet.';
    const floors = await fetch('/api/project/floors').then(result => result.json());
    projectRevision = floors.revision;
    const lifecycleFloor = document.querySelector('#lifecycle-floor-target');
    lifecycleFloor.replaceChildren(...floors.floors.map(floor => new Option(floor.name, floor.id)));
    await loadBlockPalette();
    const selector = document.querySelector('#import-floor');
    selector.replaceChildren(new Option('Create a new floor', ''));
    for (const floor of floors.floors) selector.add(new Option(floor.name, floor.id));
    document.querySelector('#import-floor-name').disabled = Boolean(selector.value);
    await refreshSaveStatus();
    await refreshRecoverySnapshots();
    if (visibleHeight < 256 && floorManifest) updateSlicePreview();
  } else { slicePreviewActive = false; selectedBlocks = []; pendingMoveDelta = 0; renderSelection(); }
}

async function refreshRecoverySnapshots() {
  const list = document.querySelector('#backup-recovery-list'); if (!list) return;
  const response = await fetch('/api/backups/recovery', { cache: 'no-store' });
  if (!response.ok) { list.textContent = 'Recovery snapshots could not be listed.'; return; }
  const { snapshots } = await response.json(); list.replaceChildren();
  if (!snapshots.length) { list.textContent = 'No recovery snapshots yet.'; return; }
  for (const name of snapshots) { const item = document.createElement('li'), link = document.createElement('a'); link.href = `/api/backups/recovery/${encodeURIComponent(name)}`; link.textContent = name; link.download = name; item.append(link); list.append(item); }
}

async function lifecycleRequest(url, method, payload) {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, expectedRevision: projectRevision }) });
  const result = await response.json();
  const status = document.querySelector('#lifecycle-status'); status.textContent = response.ok ? (result.saved ? 'Saved. Visitors will see this change on refresh.' : `Change saved locally; ${result.warning}. Use Save to retry.`) : result.error;
  if (result.status) setSaveStatus(result.status);
  if (response.ok) { await refreshPublicManifest(); await refreshSession(); await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus(); }
  return { response, result };
}
const lifecycleValue = id => document.querySelector(id).value.trim();
async function lifecycleHistoryCommand(direction) {
  const response = await fetch(`/api/project/lifecycle/${direction}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
  const result = await response.json();
  document.querySelector('#lifecycle-status').textContent = response.ok ? (result.saved ? `${direction === 'undo' ? 'Undo' : 'Redo'} saved.` : `Change applied; ${result.warning}. Use Save to retry.`) : result.error;
  if (result.status) setSaveStatus(result.status);
  if (response.ok) { await refreshPublicManifest(); await refreshSession(); await loadFloor(document.querySelector('#floor').value); await refreshSaveStatus(); }
}
document.querySelector('#lifecycle-undo').addEventListener('click', () => void lifecycleHistoryCommand('undo'));
document.querySelector('#lifecycle-redo').addEventListener('click', () => void lifecycleHistoryCommand('redo'));
document.querySelector('#lifecycle-rename-floor').addEventListener('click', () => void lifecycleRequest(`/api/project/floors/${encodeURIComponent(document.querySelector('#floor').value)}`,'PUT',{name:lifecycleValue('#lifecycle-name')}));
document.querySelector('#lifecycle-rename-section').addEventListener('click', () => void lifecycleRequest(`/api/project/sections/${encodeURIComponent(document.querySelector('#layout-section').value)}/name`,'PUT',{name:lifecycleValue('#lifecycle-name')}));
document.querySelector('#lifecycle-move-section').addEventListener('click', () => void lifecycleRequest(`/api/project/sections/${encodeURIComponent(document.querySelector('#layout-section').value)}/floor`,'PUT',{floorId:document.querySelector('#lifecycle-floor-target').value}));
document.querySelector('#lifecycle-delete-section').addEventListener('click', async () => {
  const sectionId = document.querySelector('#layout-section').value;
  const { response, result } = await lifecycleRequest(`/api/project/sections/${encodeURIComponent(sectionId)}`,'DELETE',{resolution:null});
  if (response.ok) return;
  const dependents = result.dependents;
  if (!dependents || !confirm(`Delete section ${sectionId}? It has ${dependents.markers.length} markers, ${dependents.connections.length} section connections, and ${dependents.stairPartners.length} linked stair partners.`)) return;
  const action = dependents.markers.length ? prompt('Type delete to remove markers, or enter a same-floor section ID to reassign them:', 'delete') : 'delete';
  if (!action) return;
  const resolution = { markers: action === 'delete' ? 'delete' : 'reassign', sectionId: action === 'delete' ? null : action, deleteConnections: dependents.connections.map(item => item.id), stairLinks: 'unlink' };
  if (dependents.connections.length && !confirm(`Remove these section connections: ${resolution.deleteConnections.join(', ')}?`)) return;
  await lifecycleRequest(`/api/project/sections/${encodeURIComponent(sectionId)}`,'DELETE',{resolution});
});
document.querySelector('#lifecycle-delete-floor').addEventListener('click', async () => {
  const floorId = document.querySelector('#floor').value;
  const floors = await fetch('/api/project/floors').then(response => response.json());
  const options = floors.floors.filter(floor => floor.id !== floorId);
  const destination = prompt(`Type another floor ID to move every section to, or leave empty to delete only an empty floor. Available: ${options.map(item => `${item.id} (${item.name})`).join(', ')}`,'');
  if (destination === null || !confirm(`Delete floor ${floorId}? This keeps stable IDs for reassigned sections.`)) return;
  await lifecycleRequest(`/api/project/floors/${encodeURIComponent(floorId)}`,'DELETE',{resolution: destination ? { destinationFloorId: destination } : null});
});
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
document.querySelector('#upload-resource-pack').addEventListener('click', async () => {
  const file = document.querySelector('#resource-pack-zip').files[0], status = document.querySelector('#setup-status');
  if (!file) { status.textContent = 'Choose a resource pack ZIP first.'; return; }
  status.textContent = 'Uploading and validating resource pack…';
  const response = await fetch('/api/assets/resource-pack', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const result = await response.json();
  status.textContent = response.ok ? `Resource pack ${result.resourcePack.description || '(unnamed)'} (format ${result.resourcePack.packFormat}) saved (${result.resourcePack.sha256.slice(0, 12)}…). ${result.saved ? 'Map regenerated.' : result.warning}` : result.error;
  if (result.status) setSaveStatus(result.status);
  if (response.ok && result.saved) { await loadFloor(floorManifest.id); await refreshSaveStatus(); }
});
document.querySelector('#backup-download').addEventListener('click', async () => {
  const status = document.querySelector('#backup-status'); status.textContent = 'Preparing consistent SQLite and asset snapshot…';
  try {
    const response = await fetch('/api/backups/export', { cache: 'no-store' });
    if (!response.ok) { status.textContent = (await response.json()).error; return; }
    status.textContent = 'Packaging project files…';
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = 'rr-map-project.zip'; link.click(); URL.revokeObjectURL(url); status.textContent = 'Project backup downloaded.';
  } catch (error) { status.textContent = `Backup failed: ${error.message}`; }
});
document.querySelector('#backup-refresh').addEventListener('click', () => { document.querySelector('#backup-status').textContent = 'Recovery snapshots refreshed.'; void refreshRecoverySnapshots(); });
document.querySelector('#backup-restore').addEventListener('click', async () => {
  const file = document.querySelector('#backup-zip').files[0], status = document.querySelector('#backup-status');
  if (!file) { status.textContent = 'Choose a project backup ZIP first.'; return; }
  const confirmation = window.prompt('This replaces the complete current project. Type RESTORE PROJECT to continue:');
  if (confirmation !== 'RESTORE PROJECT') { status.textContent = 'Restore cancelled; current project is unchanged.'; return; }
  status.textContent = 'Uploading and validating archive paths, checksums, SQLite schema and references…';
  const button = document.querySelector('#backup-restore'); button.disabled = true;
  try {
    const response = await fetch('/api/backups/restore', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-confirm-restore': confirmation }, body: file });
    const result = await response.json();
    status.textContent = response.ok ? result.message : `Restore failed: ${result.error}`;
    if (response.ok) { await refreshPublicManifest(); await refreshSession(); await loadFloor(document.querySelector('#floor').value); await refreshRecoverySnapshots(); }
  } catch (error) { status.textContent = `Restore failed: ${error.message}. The server preserves the previous project on validation or restore errors.`; }
  finally { button.disabled = false; }
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
new ResizeObserver(() => fitFloor()).observe(viewport);

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
