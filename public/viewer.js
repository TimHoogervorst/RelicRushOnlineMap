const viewport = document.querySelector('#viewport');
const frame = document.querySelector('#map-frame');
const image = document.querySelector('#map');
const message = document.querySelector('#message');
const sidebar = document.querySelector('#sidebar');
const legendPanel = document.querySelector('#legend-panel');
const editorPanel = document.querySelector('#editor-panel');
const loginPanel = document.querySelector('#login-panel');
const setupPanel = document.querySelector('#setup-panel');
let zoom = 1, offsetX = 0, offsetY = 0, pointer = null, slicePreviewActive = false;

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
viewport.addEventListener('wheel', event => {
  event.preventDefault();
  if (event.altKey && editorOpen && editorAuthenticated && selectedBlocks.length) {
    pendingMoveDelta += event.deltaY > 0 ? 1 : -1; renderSelection();
    document.querySelector('#block-selection-status').textContent = `Preview: move ${selectedBlocks.length} blocks ${pendingMoveDelta > 0 ? 'up' : 'down'} ${Math.abs(pendingMoveDelta)} block${Math.abs(pendingMoveDelta) === 1 ? '' : 's'}. Click Move selection to commit.`;
    return;
  }
  setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY);
}, { passive: false });
viewport.addEventListener('pointerdown', event => { if (event.target.closest('.map-marker, #marker-popup')) return; pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, target: event.target, moved: false, shiftKey: event.shiftKey }; viewport.setPointerCapture(event.pointerId); frame.classList.add('dragging'); });
viewport.addEventListener('pointermove', event => { if (!pointer || pointer.id !== event.pointerId) return; if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 4) pointer.moved = true; offsetX += event.clientX - pointer.x; offsetY += event.clientY - pointer.y; pointer.x = event.clientX; pointer.y = event.clientY; drawTransform(); });
function endPointer(event) { if (pointer?.id === event.pointerId) { const click = !pointer.moved, target = pointer.target, shiftKey = pointer.shiftKey; pointer = null; frame.classList.remove('dragging'); if (click && editorOpen && floorManifest && target === image) void inspectBlockAt(event.clientX, event.clientY, shiftKey); } }
viewport.addEventListener('pointerup', endPointer); viewport.addEventListener('pointercancel', endPointer);
image.addEventListener('load', () => { if (!slicePreviewActive) fitFloor(); renderSelection(); });

let editorOpen = false, editorAuthenticated = false, sidebarOpen = true, projectRevision = 0, publicMap = null, floorManifest = null, markerDrag = null, highlightedMarker = null;
let initialMarkerSection = null, initialMarkerDisplay = null;
let blockCatalog = [], paletteChoice = null, inspectedBlock = null, inspectedSection = null, inspectedCoords = null;
let selectedBlocks = [], pendingMoveDelta = 0, visibleHeight = 256, sliceMaximum = 256, slicePreviewTimer = null;
const markerTypes = ['chest', 'relic', 'shop', 'stairs', 'other'];
const markerTitles = { chest: 'Chests', relic: 'Relics', shop: 'Shops', stairs: 'Stairs', other: 'Other' };
const markerIcon = type => `/icons/${markerTypes.includes(type) ? type : 'other'}.svg`;
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
  image.src = `/api/map/image?revision=${encodeURIComponent(floorManifest.projectRevision)}&floor=${encodeURIComponent(floorId)}`;
  image.hidden = false; message.hidden = true;
  const sections = (floorManifest.sections ?? []).map(section => section.name).join(' · ');
  document.querySelector('#caption').textContent = `${sections || floorManifest.name} · ${floorManifest.name} · ${floorManifest.bounds.width} × ${floorManifest.bounds.depth}`;
  renderMarkers();
}
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
      : `/api/map/image?revision=${encodeURIComponent(floorManifest.projectRevision)}&floor=${encodeURIComponent(floorManifest.id)}`;
  }, 250);
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
  document.querySelector('#marker-layer').classList.toggle('editing', editorOpen);
}

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
    button.setAttribute('aria-label', `${markerTitles[marker.type] ?? marker.type}: ${marker.name}`);
    button.hidden = !editorOpen && !readMarkerVisibility(floorManifest.id, marker.type);
    button.title = marker.name;
    button.classList.toggle('highlighted', highlightedMarker === marker.id);
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (editorOpen) { populateMarkerForm(marker); return; }
      highlightedMarker = marker.id; renderMarkers(); centerMarker(marker);
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
  const groups = document.querySelector('#legend-groups'); groups.replaceChildren();
  for (const type of markerTypes) {
    const typed = markers.filter(marker => marker.type === type);
    if (!typed.length) continue;
    const details = document.createElement('details'); details.open = true;
    const summary = document.createElement('summary');
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = readMarkerVisibility(floorManifest.id, type); check.setAttribute('aria-label', `Show ${markerTitles[type].toLowerCase()}`);
    check.addEventListener('click', event => event.stopPropagation());
    check.addEventListener('change', () => { storeMarkerVisibility(floorManifest.id, type, check.checked); layer.querySelectorAll(`[data-type="${type}"]`).forEach(item => item.hidden = !check.checked); });
    summary.append(check, ` ${markerTitles[type]}`); details.append(summary);
    for (const marker of typed) {
      const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'legend-entry';
      const icon = document.createElement('img'); icon.src = markerIcon(type); icon.alt = '';
      entry.append(icon, document.createTextNode(marker.name));
      entry.addEventListener('click', () => { highlightedMarker = marker.id; renderMarkers(); centerMarker(marker); });
      details.append(entry);
    }
    groups.append(details);
  }
  if (!groups.childElementCount) groups.innerHTML = '<p>No markers on this floor.</p>';
}
function readMarkerVisibility(floorId, type) {
  try { const value = JSON.parse(localStorage.getItem(`rr-marker-visibility:${floorId}`) ?? '{}'); return value[type] !== false; } catch { return true; }
}
function storeMarkerVisibility(floorId, type, visible) {
  try { const key = `rr-marker-visibility:${floorId}`; const value = JSON.parse(localStorage.getItem(key) ?? '{}'); value[type] = visible; localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be disabled */ }
}
function centerMarker(marker) {
  const pixels = floorManifest.renderer?.pixelSize ?? 16;
  offsetX = -(marker.x * pixels - image.naturalWidth / 2) * zoom;
  offsetY = -(marker.z * pixels - image.naturalHeight / 2) * zoom;
  drawTransform();
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
}
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
    const response = await fetch(id ? `/api/project/markers/${encodeURIComponent(id)}` : '/api/project/markers', { method: id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision, marker, preserveDisplayedPosition: preserveDisplayedPosition || keepDisplayedPosition }) });
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
document.querySelector('#marker-delete').addEventListener('click', async () => {
  const id = document.querySelector('#marker-id').value;
  if (!id || !window.confirm('Delete this marker? This cannot be undone.')) return;
  const response = await fetch(`/api/project/markers/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: projectRevision }) });
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
    await loadBlockPalette();
    const selector = document.querySelector('#import-floor');
    selector.replaceChildren(new Option('Create a new floor', ''));
    for (const floor of floors.floors) selector.add(new Option(floor.name, floor.id));
    document.querySelector('#import-floor-name').disabled = Boolean(selector.value);
    await refreshSaveStatus();
    if (visibleHeight < 256 && floorManifest) updateSlicePreview();
  } else { slicePreviewActive = false; selectedBlocks = []; pendingMoveDelta = 0; renderSelection(); }
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
