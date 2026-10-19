// Start-point configuration mirrors the endpoint editor and uses the same local coordinates.
export function mountRunStartpoint(hooks) {
  let value = null, draft = null, dirty = false;
  const panel = document.createElement('details'); panel.className = 'editor-section'; panel.hidden = true;
  panel.innerHTML = `<summary>Run start point</summary><p>Click a terrain block and choose Set start point. Returning here after disappearing starts a new run. Applies to new runs.</p><form><p class="start-place">No start point set.</p><label>Local height<input name="height" type="number" step="0.25" required></label><label>Sphere diameter (blocks)<input name="diameter" type="number" min="0.5" max="256" step="0.25" value="10" required></label><button type="submit">Save start point</button><button type="button" class="start-clear">Remove start point</button></form><p class="start-status" role="status"></p>`;
  document.querySelector('#setup-panel').append(panel);
  const $ = selector => panel.querySelector(selector);
  const place = document.createElement('button'); place.type = 'button'; place.textContent = 'Set start point'; place.hidden = true;
  document.querySelector('#cell-popup').append(place);
  const marker = document.createElement('div'); marker.className = 'run-endpoint run-startpoint'; marker.textContent = 'S'; marker.title = 'Run start point'; marker.hidden = true;
  document.querySelector('#map-frame').append(marker);
  function render(point) {
    $('.start-place').textContent = point ? `Section ${point.sectionId} / X ${point.local.x}, Z ${point.local.z}` : 'No start point set.';
    $('[name=height]').value = point?.local.y ?? '';
    $('[name=diameter]').value = point?.diameter ?? 10;
  }
  place.addEventListener('click', () => {
    const block = hooks.selectedBlock(); if (!block) return;
    draft = { sectionId: block.sectionId, local: { x: block.x + 0.5, y: block.y + 1, z: block.z + 0.5 }, diameter: Number($('[name=diameter]').value) || 10 };
    panel.open = true; hooks.openEditor(); render(draft); document.querySelector('#cell-popup').hidden = true; panel.scrollIntoView({ block: 'nearest' });
  });
  async function save(point) {
    try {
      const response = await fetch('/api/project/run-startpoint', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startpoint: point }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Could not save start point.');
      value = data.startpoint; draft = null; dirty = false; render(value); $('.start-status').textContent = 'Saved. Applies to the next run.';
    } catch (error) { $('.start-status').textContent = error.message; }
  }
  $('form').addEventListener('input', () => { dirty = true; });
  $('form').addEventListener('submit', event => {
    event.preventDefault(); const point = draft ?? value;
    if (point) void save({ ...point, diameter: Number($('[name=diameter]').value), local: { ...point.local, y: Number($('[name=height]').value) } });
  });
  $('.start-clear').addEventListener('click', () => { if (confirm('Remove the start point for future runs?')) void save(null); });
  return {
    update(point) { value = point; if (!draft && !dirty && !$('form').contains(document.activeElement)) render(value); },
    draw(state, display) {
      panel.hidden = place.hidden = !state.editing;
      const point = value && state.floor && display(value); marker.hidden = !state.editing || !point;
      if (point) { const pixels = state.floor.renderer?.pixelSize ?? 16; marker.style.left = `${point.x * pixels}px`; marker.style.top = `${(state.floor.bounds.depth - point.z) * pixels}px`; marker.style.transform = `translate(-50%,-50%) scale(${1 / state.zoom})`; }
    }
  };
}
