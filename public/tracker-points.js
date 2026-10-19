export function trackerSectionOptions(sections, world, sectionId = null) {
  return sections.filter(s => !sectionId || s.id === sectionId).map(s => {
    const reason = !s.calibration ? 'Needs waypoint' : s.calibration.invalidReason
      ? `Needs valid waypoint: ${s.calibration.invalidReason}` : s.calibration.world !== world
        ? `Different world: ${s.calibration.world}` : '';
    return { id: s.id, label: `${s.floorName} · ${s.name}${reason ? ` — ${reason}` : ''}`, reason };
  });
}

// Editor-only controls. Player positioning remains on the server for all visitors.
export function mountTrackerPoints(hooks, editor, panel, refresh) {
  const controls = document.createElement('section'); controls.className = 'tracker-controls';
  controls.innerHTML = `<h4>Tracker points</h4><p>Correct section membership near saved player locations. Reach applies to all points and players.</p>
    <label>Horizontal reach (X/Z) <output id="tracker-horizontal-value">3 blocks</output><input id="tracker-horizontal" type="range" min="0.25" max="64" step="0.25" value="3"></label>
    <label>Vertical reach (Y) <output id="tracker-vertical-value">1 block</output><input id="tracker-vertical" type="range" min="0.25" max="64" step="0.25" value="1"></label>
    <div class="tracker-actions"><button type="button" data-history="undo">Undo tracker edit</button><button type="button" data-history="redo">Redo</button></div>
    <p class="tracker-status" role="status"></p><p class="tracker-overlaps"></p><div class="tracker-list"></div>
    <form class="tracker-capture" hidden><h4>Save captured position</h4><p></p><label>Correct section<select required></select></label><label>Name (optional)<input maxlength="120"></label><button type="submit">Save tracker</button><button type="button" class="tracker-cancel">Cancel</button></form>`;
  editor.append(controls);
  const online = document.createElement('div'); online.className = 'tracker-online'; online.hidden = true; panel.querySelector('details').append(online);
  const layer = document.createElement('div'); layer.id = 'tracker-layer'; layer.hidden = true; document.querySelector('#map-frame').append(layer);
  const $ = selector => controls.querySelector(selector);
  let data = null, captured = null, selected = null, busy = false, layerKey = '', listKey = '', onlineKey = '', reach = { horizontal: 3, vertical: 1 };
  const button = (label, action) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); return b; };
  async function save(input, revision = data?.revision) {
    if (busy) return;
    busy = true; $('.tracker-status').textContent = 'Saving…';
    try {
      const response = await fetch('/api/project/tracker-points', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, expectedRevision: revision }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      hooks.revision(result.revision);
      if (captured) { captured = null; $('.tracker-capture').hidden = true; }
      await refresh();
      if (result.saved) await hooks.refreshMap();
      $('.tracker-status').textContent = result.saved ? 'Tracker changes saved.' : `Saved locally. ${result.warning} Use Project save to publish.`;
    } catch (error) { $('.tracker-status').textContent = error.message; }
    finally { busy = false; }
  }
  for (const axis of ['horizontal', 'vertical']) {
    $(`#tracker-${axis}`).addEventListener('input', event => { $(`#tracker-${axis}-value`).textContent = `${event.target.value} blocks`; });
    $(`#tracker-${axis}`).addEventListener('change', () => { void save({ settings: { horizontal: Number($('#tracker-horizontal').value), vertical: Number($('#tracker-vertical').value) } }); });
  }
  for (const b of controls.querySelectorAll('[data-history]')) b.addEventListener('click', () => { void save({ direction: b.dataset.history }); });
  function capture(player, replacement = null) {
    if (!data || data.stale || Date.now() - data.receivedAt > 6000) { $('.tracker-status').textContent = 'Wait for fresh player positions before capturing.'; return; }
    const options = trackerSectionOptions(data.sections, player.world, replacement?.sectionId);
    const eligible = options.filter(s => !s.reason);
    captured = { position: { world: player.world, x: player.x, y: player.y, z: player.z }, revision: data.revision, id: replacement?.id };
    const form = $('.tracker-capture'); form.hidden = false;
    form.querySelector('p').textContent = `${player.name} · ${player.world} · X ${player.x}, Y ${player.y}, Z ${player.z} (captured now)`;
    form.querySelector('select').replaceChildren(...options.map(s => {
      const option = new Option(s.label, s.id); option.disabled = Boolean(s.reason); return option;
    }));
    form.querySelector('select').value = eligible[0]?.id ?? '';
    form.querySelector('[type="submit"]').disabled = !eligible.length;
    $('.tracker-status').textContent = options.some(s => s.reason)
      ? 'Unavailable sections are listed with a reason. For “Needs waypoint”, select a known block in that section on the map, choose + Waypoint, and save its Minecraft coordinates. Then capture the tracker again.' : '';
    if (eligible.some(s => s.id === player.sectionId)) form.querySelector('select').value = player.sectionId;
    form.querySelector('input').value = replacement?.name ?? '';
    hooks.openEditor(); editor.open = true; form.scrollIntoView({ block: 'nearest' }); form.querySelector('select').focus();
  }
  $('.tracker-cancel').addEventListener('click', () => { captured = null; $('.tracker-capture').hidden = true; });
  $('.tracker-capture').addEventListener('submit', event => {
    event.preventDefault(); if (!captured) return;
    void save({ sectionId: $('.tracker-capture select').value, id: captured.id, position: captured.position, name: $('.tracker-capture input').value }, captured.revision);
  });
  function renderList() {
    const sectionId = document.querySelector('#tracking-section').value;
    const section = data?.sections.find(s => s.id === sectionId);
    const key = JSON.stringify([section, selected, data?.diagnostics.map(p => [p.uuid, p.name])]); if (key === listKey) return; listKey = key;
    const list = $('.tracker-list'); list.replaceChildren();
    if (!section?.trackerPoints?.length) { list.textContent = 'No tracker points in this section. Use Add tracker beside an online player.'; return; }
    for (const point of section.trackerPoints) {
      const row = document.createElement('div'); row.className = 'tracker-item';
      const choose = button(point.name, () => { selected = point.id; layerKey = ''; listKey = ''; renderList(); }); choose.setAttribute('aria-pressed', String(selected === point.id)); row.append(choose);
      const status = document.createElement('small'); status.textContent = `${section.calibration && !section.calibration.invalidReason ? 'Local' : 'Inactive · needs waypoint'}: ${['x', 'y', 'z'].map(a => `${a.toUpperCase()} ${point.local[a].toFixed(2)}`).join(', ')}`; row.append(status);
      const actions = document.createElement('div'); actions.className = 'tracker-actions';
      actions.append(button('Rename', () => { const name = window.prompt('Tracker point name', point.name); if (name?.trim()) void save({ sectionId, id: point.id, name }); }));
      const playerSelect = document.createElement('select'); playerSelect.setAttribute('aria-label', `Player position to replace ${point.name}`); playerSelect.append(...(data.diagnostics ?? []).map(p => new Option(p.name, p.uuid)));
      actions.append(playerSelect, button('Replace position', () => { const p = data.diagnostics.find(p => p.uuid === playerSelect.value); if (p) capture(p, { ...point, sectionId }); }));
      actions.append(button('Delete', () => { if (window.confirm(`Delete ${point.name}?`)) void save({ sectionId, id: point.id, delete: true }); })); row.append(actions); list.append(row);
    }
  }
  function update(next) {
    if (!hooks.state().editing) return;
    data = { ...next, receivedAt: Date.now() }; reach = next.trackingSettings;
    for (const axis of ['horizontal', 'vertical']) if (document.activeElement !== $(`#tracker-${axis}`)) {
      $(`#tracker-${axis}`).value = reach[axis]; $(`#tracker-${axis}-value`).textContent = `${reach[axis]} blocks`;
    }
    $('.tracker-overlaps').textContent = (next.trackerOverlaps ?? []).map(label => `Overlapping trackers: ${label}`).join('\n');
    const key = JSON.stringify(next.diagnostics.map(p => [p.uuid, p.name, p.status, p.sectionId, next.stale]));
    if (key !== onlineKey) {
      onlineKey = key; online.replaceChildren();
      for (const player of next.diagnostics) {
        const row = document.createElement('div'); row.className = 'tracker-online-row';
        const label = document.createElement('strong'); label.textContent = player.name;
        const place = document.createElement('small'); place.textContent = player.status === 'mapped' ? `${player.floorName} · ${player.sectionName}` : player.status;
        const follow = button('Follow', () => { const p = data.diagnostics.find(p => p.uuid === player.uuid); if (p?.status === 'mapped') hooks.follow(p); }); follow.disabled = player.status !== 'mapped';
        const add = button('Add tracker', () => { const p = data.diagnostics.find(p => p.uuid === player.uuid); if (p) capture(p); }); add.disabled = next.stale;
        row.append(label, place, follow, add); online.append(row);
      }
      if (!next.diagnostics.length) online.textContent = 'No current online player positions.';
    }
    renderList(); layerKey = '';
  }
  function draw() {
    const { editing, floor, zoom } = hooks.state(); online.hidden = !editing; layer.hidden = !editing;
    document.querySelector('#player-list').hidden = editing;
    if (!editing) { if (data) { data = null; onlineKey = ''; layerKey = ''; captured = null; $('.tracker-capture').hidden = true; } return; }
    if (!data || !floor) return;
    document.querySelector('#player-count').textContent = String(data.diagnostics.length);
    const key = `${floor.id}:${floor.projectRevision}:${data.revision}:${selected}`;
    if (key !== layerKey) {
      layerKey = key; layer.replaceChildren();
      for (const section of data.sections.filter(s => s.floorId === floor.id)) for (const point of section.trackerPoints ?? []) {
        const pixels = floor.renderer?.pixelSize ?? 16, x = (section.placementX + point.local.x) * pixels, y = (floor.bounds.depth - section.placementZ - point.local.z) * pixels;
        if (point.id === selected) {
          const ring = document.createElement('div'); ring.className = 'tracker-reach'; ring.style.left = `${x}px`; ring.style.top = `${y}px`; ring.style.width = ring.style.height = `${reach.horizontal * 2 * pixels}px`; layer.append(ring);
        }
        const b = button('◆', () => { selected = point.id; document.querySelector('#tracking-section').value = section.id; document.querySelector('#tracking-section').dispatchEvent(new Event('change')); editor.open = true; hooks.openEditor(); listKey = ''; renderList(); controls.scrollIntoView({ block: 'nearest' }); });
        b.className = 'tracker-point'; b.title = `${point.name} · ${section.name} · Y ±${reach.vertical}${section.calibration ? '' : ' · inactive'}`; b.setAttribute('aria-label', b.title);
        b.style.left = `${x}px`; b.style.top = `${y}px`; b.addEventListener('pointerdown', event => event.stopPropagation()); b.addEventListener('click', event => event.stopPropagation()); layer.append(b);
      }
    }
    for (const b of layer.querySelectorAll('button')) b.style.transform = `translate(-50%, -50%) scale(${1 / zoom})`;
  }
  document.querySelector('#tracking-section').addEventListener('change', renderList);
  function unavailable() {
    if (data) data.stale = true;
    for (const b of online.querySelectorAll('button')) if (b.textContent === 'Add tracker') b.disabled = true;
    onlineKey = '';
  }
  return { update, draw, unavailable };
}
