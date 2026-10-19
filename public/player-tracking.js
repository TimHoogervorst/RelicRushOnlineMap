import { mountTrackerPoints } from './tracker-points.js';
import { mountDungeonRuns } from './dungeon-runs.js';
const $ = selector => document.querySelector(selector);
const axes = ['x', 'y', 'z'];
const fallback = '/icons/player.svg';
const head = uuid => { const img = document.createElement('img'); img.alt = ''; img.dataset.version = String(Math.floor(Date.now() / 60000)); img.src = `/api/players/${uuid}/head?v=${img.dataset.version}`; img.addEventListener('error', () => { if (new URL(img.src).pathname !== fallback) img.src = fallback; }); return img; };

export function mountPlayerTracking(hooks) {
  const panel = document.createElement('aside'); panel.className = 'players-panel'; panel.setAttribute('aria-label', 'Live Minecraft players');
  panel.innerHTML = `<details open><summary>Players <span id="player-count">0</span></summary><p id="players-status" role="status">Connecting…</p><div id="player-follow" hidden><span></span><button type="button">Stop</button></div><div id="player-list"></div></details>`;
  document.body.append(panel);
  const layer = document.createElement('div'); layer.id = 'player-layer'; $('#map-frame').append(layer);
  const waypoints = document.createElement('div'); waypoints.id = 'waypoint-layer'; $('#map-frame').append(waypoints);
  let waypointRevision = null, waypointFloor = null;
  const editor = document.createElement('details'); editor.className = 'editor-section';
  editor.innerHTML = `<summary>Player tracking</summary><p>One waypoint per section. Existing sections use your vertical flip (top / bottom). New imports start unflipped; applying rotations or flips keeps calibration aligned automatically.</p>
    <label for="tracking-section">Section</label><select id="tracking-section"></select><p id="tracking-calibration-state"></p>
    <form id="waypoint-form"><p id="waypoint-local">Select a block and choose + Waypoint.</p><label for="waypoint-world">Minecraft world</label><input id="waypoint-world" list="tracking-worlds" maxlength="120" required><datalist id="tracking-worlds"></datalist>
    <fieldset><legend>Actual selected block coordinates</legend><div id="waypoint-actual" class="tracking-coordinates"></div></fieldset>
    <fieldset><legend>World tracking limits</legend><p>Minimum inclusive; maximum exclusive. Min Y / Max Y control floor tracking. Where floors overlap, entering the higher floor's Min Y switches tracking to that floor. Leave all limits blank to initialize from geometry.</p><div id="waypoint-region"></div></fieldset>
    <button type="submit">Save waypoint</button><button type="button" id="waypoint-delete">Delete waypoint</button></form>
    <p id="waypoint-status" role="status"></p><p id="tracking-overlaps"></p><h4>Live diagnostics</h4><p>Compare the waypoint and two distant known blocks, then cross a section and a floor boundary.</p><pre id="tracking-diagnostics"></pre>`;
  $('#setup-panel').append(editor);
  for (const axis of axes) {
    $('#waypoint-actual').insertAdjacentHTML('beforeend', `<label>${axis.toUpperCase()}<input id="waypoint-${axis}" type="number" step="1" min="-30000000" max="30000000" required></label>`);
    $('#waypoint-region').insertAdjacentHTML('beforeend', `<div class="tracking-coordinates"><label>Min ${axis.toUpperCase()}<input id="waypoint-min-${axis}" type="number" step="1" min="-30000000" max="30000000"></label><label>Max ${axis.toUpperCase()}<input id="waypoint-max-${axis}" type="number" step="1" min="-30000000" max="30000000"></label></div>`);
  }
  const add = document.createElement('button'); add.type = 'button'; add.id = 'cell-add-waypoint'; add.textContent = '+ Waypoint'; $('#cell-popup').append(add);
  let players = [], sections = [], local = null, editingRevision = null, lastSuccess = 0, received = 0, following = null, navigation = 0, switching = false, stale = false, notice = '', disposed = false, wasEditing = false;
  const trackers = mountTrackerPoints({ ...hooks, follow: player => void follow(player, true) }, editor, panel, refreshEditor);
  const runs = mountDungeonRuns({ ...hooks, stopLive: () => stop() }, panel);
  const icons = new Map(), rows = new Map(), movement = new Map();
  function stop(reason = '') { following = null; navigation++; switching = false; notice = reason; updateFollow(); }
  function updateFollow() {
    const player = players.find(p => p.uuid === following);
    $('#player-follow').hidden = !player;
    $('#player-follow span').textContent = player ? `Following ${player.name}` : '';
    for (const [uuid, row] of rows) row.setAttribute('aria-pressed', String(uuid === following));
    if (notice) $('#players-status').textContent = notice;
  }
  $('#player-follow button').addEventListener('click', () => stop('Following stopped.'));
  async function follow(player, initial = false) {
    if (runs.replaying) return;
    const token = ++navigation; following = player.uuid; notice = ''; updateFollow();
    try {
      if (hooks.state().floor?.id !== player.floorId) {
        switching = true;
        await hooks.navigate(player.floorId);
        if (token !== navigation) return;
      }
      switching = false;
      if (initial) hooks.initialZoom();
      draw(performance.now());
    } catch (error) { if (token === navigation) stop(`Cannot follow: ${error.message}`); }
  }
  function position(player, time) {
    const move = movement.get(player.uuid);
    if (!move) return player.display;
    const t = Math.min(1, Math.max(0, (time - move.start) / 1600));
    return { x: move.from.x + (player.display.x - move.from.x) * t, z: move.from.z + (player.display.z - move.from.z) * t };
  }
  function renderList() {
    const active = new Set(players.map(p => p.uuid));
    for (const [uuid, node] of rows) if (!active.has(uuid)) { node.remove(); rows.delete(uuid); icons.get(uuid)?.remove(); icons.delete(uuid); movement.delete(uuid); }
    for (const player of players) {
      let row = rows.get(player.uuid);
      if (!row) {
        row = document.createElement('button'); row.type = 'button'; row.className = 'player-row';
        row.append(head(player.uuid), document.createElement('span'));
        row.addEventListener('click', () => { const current = players.find(p => p.uuid === player.uuid); if (current) void follow(current, true); });
        rows.set(player.uuid, row); $('#player-list').append(row);
        const icon = document.createElement('button'); icon.type = 'button'; icon.className = 'player-head'; icon.append(head(player.uuid));
        icon.addEventListener('pointerdown', event => event.stopPropagation());
        icon.addEventListener('click', event => { event.stopPropagation(); row.click(); });
        layer.append(icon); icons.set(player.uuid, icon);
      }
      const label = row.lastChild;
      label.replaceChildren(); const name = document.createElement('strong'), place = document.createElement('small');
      name.textContent = player.name; place.textContent = `${player.floorName} · ${player.sectionName}`; label.append(name, place);
      icons.get(player.uuid).title = player.name; icons.get(player.uuid).setAttribute('aria-label', `Follow ${player.name}`);
      const headVersion = String(Math.floor(Date.now() / 60000));
      for (const img of [row.querySelector('img'), icons.get(player.uuid).querySelector('img')]) {
        if (img.dataset.version !== headVersion) { img.dataset.version = headVersion; img.src = `/api/players/${player.uuid}/head?v=${headVersion}`; }
      }
    }
    $('#player-count').textContent = String(players.length);
    layer.classList.toggle('stale', stale);
    $('#players-status').textContent = notice || (stale ? 'Positions stale · reconnecting…' : players.length ? 'Live · updates every 2 seconds' : 'No players in calibrated sections.');
    updateFollow();
  }
  function draw(time) {
    runs.draw(time);
    const { floor, zoom, editing } = hooks.state();
    trackers.draw();
    editor.hidden = !editing;
    waypoints.hidden = !editing;
    if (floor && (waypointRevision !== floor.projectRevision || waypointFloor !== floor.id)) {
      waypointRevision = floor.projectRevision; waypointFloor = floor.id; waypoints.replaceChildren();
      for (const section of floor.sections ?? []) {
        const c = section.calibration; if (!c) continue;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'calibration-waypoint'; button.textContent = '⌖';
        button.title = `${section.name} · ${c.invalidReason ?? 'Calibration waypoint'}`;
        button.setAttribute('aria-label', button.title); button.classList.toggle('invalid', Boolean(c.invalidReason));
        const pixels = floor.renderer?.pixelSize ?? 16;
        button.style.left = `${(section.placementX + c.local.x + 0.5) * pixels}px`;
        button.style.top = `${(floor.bounds.depth - section.placementZ - c.local.z - 0.5) * pixels}px`;
        button.addEventListener('pointerdown', event => event.stopPropagation());
        button.addEventListener('click', event => { event.stopPropagation(); editor.open = true; hooks.openEditor(); void refreshEditor().then(() => { $('#tracking-section').value = section.id; populate(sections.find(s => s.id === section.id)); editor.scrollIntoView({ block: 'nearest' }); }).catch(error => { $('#waypoint-status').textContent = error.message; }); });
        waypoints.append(button);
      }
    }
    for (const waypoint of waypoints.children) waypoint.style.transform = `translate(-50%, -50%) scale(${1 / zoom})`;
    if (editing && !wasEditing && window.matchMedia('(max-width: 600px)').matches) panel.querySelector('details').open = false;
    wasEditing = editing;
    const expired = !lastSuccess || Date.now() - lastSuccess >= 15000;
    if (expired && players.length) { players = []; stop('Tracking unavailable · positions expired.'); renderList(); }
    for (const player of players) {
      const icon = icons.get(player.uuid); if (!icon) continue;
      icon.hidden = floor?.id !== player.floorId || switching;
      if (icon.hidden) continue;
      const point = position(player, time), pixels = floor.renderer?.pixelSize ?? 16;
      icon.style.left = `${point.x * pixels}px`; icon.style.top = `${(floor.bounds.depth - point.z) * pixels}px`;
      icon.style.transform = `translate(-50%, -50%) scale(${1 / zoom})`;
      icon.classList.toggle('following', player.uuid === following);
      if (following === player.uuid && !runs.replaying) hooks.center(point);
    }
  }
  function animate(time) { if (disposed) return; draw(time); requestAnimationFrame(animate); }
  requestAnimationFrame(animate);

  async function poll() {
    try {
      const response = await fetch('/api/players', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error('Tracking unavailable');
      const data = await response.json();
      // Positions belong to a particular published layout; refresh before drawing a newer layout.
      if (hooks.state().floor && data.projectRevision !== hooks.state().floor.projectRevision) { movement.clear(); await hooks.refreshMap(); }
      lastSuccess = data.ageMs === null ? 0 : Date.now() - data.ageMs; stale = data.stale;
      if (notice === 'Tracking unavailable · reconnecting…' || notice === 'Tracking unavailable · positions expired.') notice = '';
      const time = performance.now();
      if (data.updatedAt !== received) {
        for (const player of data.players) {
          const old = players.find(p => p.uuid === player.uuid);
          movement.set(player.uuid, { start: time, from: old?.sectionId === player.sectionId && old?.floorId === player.floorId ? position(old, time) : player.display });
        }
        received = data.updatedAt;
      }
      players = data.players;
      if (following && !runs.replaying) {
        const target = players.find(p => p.uuid === following);
        if (!target) stop(data.expired ? 'Positions expired · following stopped.' : 'Player left the mapped area or is no longer locatable.');
        else if (!switching && target.floorId !== hooks.state().floor?.id) void follow(target);
      }
      renderList();
    } catch { stale = true; notice = 'Tracking unavailable · reconnecting…'; renderList(); }
    if (hooks.state().editing) await refreshEditor().catch(error => { trackers.unavailable(); $('#tracking-diagnostics').textContent = error.message; });
    if (!disposed) setTimeout(poll, 2000);
  }

  function populate(section) {
    const c = section?.calibration; local = c?.local ?? null; editingRevision = editor.dataset.revision ? Number(editor.dataset.revision) : null;
    $('#waypoint-local').textContent = local ? `Local block: ${local.x}, ${local.y}, ${local.z}` : 'Select a block and choose + Waypoint.';
    $('#waypoint-world').value = c?.world ?? $('#tracking-worlds option')?.value ?? '';
    for (const axis of axes) {
      $(`#waypoint-${axis}`).value = c?.actual[axis] ?? '';
      for (const side of ['min', 'max']) $(`#waypoint-${side}-${axis}`).value = c?.region[side][axis] ?? '';
    }
    $('#waypoint-delete').disabled = !c;
    $('#tracking-calibration-state').textContent = c?.invalidReason ?? (c ? 'Calibrated' : 'Needs waypoint');
  }
  async function refreshEditor() {
    const response = await fetch('/api/project/tracking', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('Tracking diagnostics unavailable.');
    const data = await response.json(); sections = data.sections; editor.dataset.revision = String(data.revision);
    const select = $('#tracking-section'), selected = select.value;
    const options = sections.map(s => ({ id: s.id, label: `${s.floorName} · ${s.name}${s.calibration && !s.calibration.invalidReason ? '' : ' — Needs waypoint'}` }));
    if (JSON.stringify(options) !== select.dataset.options) {
      select.dataset.options = JSON.stringify(options); select.replaceChildren(...options.map(s => new Option(s.label, s.id)));
      if (sections.some(s => s.id === selected)) select.value = selected;
      else populate(sections.find(s => s.id === select.value));
    }
    $('#tracking-worlds').replaceChildren(...data.worlds.map(world => new Option(world, world)));
    if (!$('#waypoint-world').value && data.worlds.length) $('#waypoint-world').value = data.worlds[0];
    const current = sections.find(s => s.id === select.value);
    $('#tracking-calibration-state').textContent = current?.calibration?.invalidReason ?? (current?.calibration ? 'Calibrated' : 'Needs waypoint');
    $('#tracking-overlaps').textContent = data.overlaps.map(pair => `Overlap: ${pair.map(id => sections.find(s => s.id === id)?.name).join(' / ')}`).join('\n');
    trackers.update(data);
    const format = p => axes.map(axis => `${axis.toUpperCase()} ${Number(p[axis]).toFixed(2)}`).join(', ');
    $('#tracking-diagnostics').textContent = (data.stale ? 'STALE FEED\n' : '') + (data.diagnostics.map(p => `${p.name} · ${p.world}\nWorld: ${format(p)}\n${p.local ? `Local: ${format(p.local)}\n${p.floorName} / ${p.sectionName}${p.trackingY ? `\nTracking Y: ${p.trackingY.min} ≤ Y < ${p.trackingY.max}` : ''}` : `${p.status}${p.candidates?.length ? ': ' + p.candidates.join(', ') : ''}`}`).join('\n\n') || 'No current player positions.');
  }
  $('#tracking-section').addEventListener('change', () => populate(sections.find(s => s.id === $('#tracking-section').value)));
  editor.addEventListener('toggle', () => { if (editor.open) void refreshEditor().catch(error => { $('#waypoint-status').textContent = error.message; }); });
  add.addEventListener('click', async () => {
    const block = hooks.selectedBlock();
    if (!block) { hooks.blockError('Select an existing block for the waypoint.'); return; }
    editor.open = true; hooks.openEditor(); $('#cell-popup').hidden = true; $('#block-inspector').hidden = true;
    try {
      await refreshEditor(); $('#tracking-section').value = block.sectionId;
      populate(sections.find(s => s.id === block.sectionId)); local = { x: block.x, y: block.y, z: block.z };
      $('#waypoint-local').textContent = `Local block: ${local.x}, ${local.y}, ${local.z}`;
      $('#waypoint-status').textContent = 'Enter this block’s actual Minecraft coordinates. Existing limits stay fixed unless edited.';
      $('#waypoint-x').focus(); editor.scrollIntoView({ block: 'nearest' });
    } catch (error) { $('#waypoint-status').textContent = error.message; }
  });
  async function save(deleting = false) {
    if (!deleting && !local) { $('#waypoint-status').textContent = 'Select a block and choose + Waypoint first.'; return; }
    const values = axes.flatMap(axis => ['min', 'max'].map(side => $(`#waypoint-${side}-${axis}`).value));
    if (!deleting && values.some(Boolean) && !values.every(Boolean)) { $('#waypoint-status').textContent = 'Fill all six tracking limits, or leave all blank.'; return; }
    const calibration = { world: $('#waypoint-world').value.trim(), local, actual: Object.fromEntries(axes.map(axis => [axis, Number($(`#waypoint-${axis}`).value)])) };
    if (values.every(Boolean)) calibration.region = Object.fromEntries(['min', 'max'].map(side => [side, Object.fromEntries(axes.map(axis => [axis, Number($(`#waypoint-${side}-${axis}`).value)]))]));
    const buttons = editor.querySelectorAll('button'); buttons.forEach(b => { b.disabled = true; });
    try {
      const response = await fetch(`/api/project/sections/${encodeURIComponent($('#tracking-section').value)}/waypoint`, { method: deleting ? 'DELETE' : 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ calibration, expectedRevision: editingRevision }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      hooks.revision(result.revision);
      await refreshEditor(); populate(sections.find(s => s.id === $('#tracking-section').value));
      $('#waypoint-status').textContent = result.saved ? (deleting ? 'Waypoint deleted. Tracking disabled for this section.' : 'Waypoint saved.') : `Saved locally; ${result.warning}. Use Project save to retry.`;
      if (result.saved) await hooks.refreshMap();
    } catch (error) { $('#waypoint-status').textContent = error.message; }
    finally { buttons.forEach(b => { b.disabled = false; }); }
  }
  $('#waypoint-form').addEventListener('submit', event => { event.preventDefault(); void save(); });
  $('#waypoint-delete').addEventListener('click', () => { if (window.confirm('Delete this waypoint and disable tracking for its section?')) void save(true); });
  void poll();
  window.addEventListener('pagehide', () => { disposed = true; });
  window.addEventListener('pageshow', event => { if (event.persisted && disposed) { disposed = false; requestAnimationFrame(animate); void poll(); } });
  return { stop: reason => { stop(reason); runs.stopFollow(); }, get following() { return runs.following || following; } };
}
