import { durationLabel, indexRecording, replayPosition, routeSegments, routeAnnotations } from './run-playback.js';

const svgNS = 'http://www.w3.org/2000/svg';
async function request(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Recording request failed.');
  return data;
}
const button = (label, action) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); return b; };
const playerHead = participant => {
  const img = document.createElement('img'); img.alt = ''; img.src = `/api/players/${participant.uuid}/head`;
  img.addEventListener('error', () => { if (!img.src.endsWith('/icons/player.svg')) img.src = '/icons/player.svg'; });
  return img;
};

export function mountDungeonRuns(hooks, panel) {
  const area = document.createElement('section'); area.className = 'run-panel';
  area.innerHTML = `<details open><summary>Previous runs</summary><p class="run-live" role="status"></p>
    <form class="run-search"><div class="run-search-bar"><input name="name" type="search" maxlength="64" aria-label="Search runs by player name" placeholder="Search player names">
    <button type="button" class="run-date-toggle" popovertarget="run-date-filters" aria-label="Filter runs by date and time" title="Filter by date and time"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-14 4h3m4 0h3m-10 3h3"/></svg></button></div>
    <div id="run-date-filters" class="run-date-popover" popover><div class="run-date-heading"><strong>Date &amp; time</strong><button type="button" popovertarget="run-date-filters" popovertargetaction="hide" class="minecraft-close" aria-label="Close date filters">&times;</button></div><label>On date<input name="day" type="date"></label><label>From<input name="from" type="datetime-local"></label><label>Until (exclusive)<input name="to" type="datetime-local"></label><small class="run-timezone"></small><button type="button" class="run-date-clear">Clear dates</button></div></form>
    <p class="run-status" role="status"></p><div class="run-results"></div><button type="button" class="run-more" hidden>Show 10 more</button></details>
    <section class="run-replay" hidden aria-label="Run replay"><h3>Replay</h3><p class="run-title"></p><p class="run-gap" role="status"></p><div class="run-actions"><button type="button" class="run-play">Play</button><button type="button" class="run-restart">Restart</button></div><label>Timeline<input class="run-timeline" type="range" min="0" value="0" step="100" aria-label="Replay position"></label><output class="run-clock"></output><div class="run-actions"><label>Speed<select class="run-speed">${[0.5, 1, 2, 4, 8].map(v => `<option${v === 1 ? ' selected' : ''}>${v}</option>`).join('')}</select></label><label>Follow<select class="run-follow"><option value="">Free camera</option></select></label></div><button type="button" class="run-exit">Back to live</button></section>`;
  panel.append(area);
  const $ = selector => area.querySelector(selector);
  $('.run-timezone').textContent = `Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  const overlay = document.createElementNS(svgNS, 'svg'); overlay.id = 'run-routes'; overlay.setAttribute('aria-hidden', 'true');
  const heads = document.createElement('div'); heads.id = 'run-heads';
  const annotations = document.createElement('div'); annotations.id = 'run-annotations';
  const endpointNode = document.createElement('div'); endpointNode.className = 'run-endpoint'; endpointNode.textContent = '⚑'; endpointNode.title = 'Run endpoint'; endpointNode.hidden = true;
  document.querySelector('#map-frame').append(overlay, heads, annotations, endpointNode);
  const editor = document.createElement('details'); editor.className = 'editor-section'; editor.hidden = true;
  editor.innerHTML = `<summary>Run endpoint</summary><p>Click a terrain block and choose Set endpoint. One endpoint applies to new runs.</p><form><p class="endpoint-place">No endpoint set.</p><label>Local height<input type="number" name="height" step="0.25" required></label><label>Sphere diameter (blocks)<input type="number" name="diameter" min="0.5" max="256" step="0.25" value="10" required></label><small>Diameter is the full width in every direction. 10 blocks means a 5-block radius, including vertically.</small><button type="submit">Save endpoint</button><button type="button" class="endpoint-clear">Remove endpoint</button></form><p class="endpoint-status" role="status"></p>`;
  document.querySelector('#setup-panel').append(editor);
  const place = button('⚑ Set endpoint', () => {
    const block = hooks.selectedBlock(); if (!block) return;
    draft = { sectionId: block.sectionId, local: { x: block.x + 0.5, y: block.y + 1, z: block.z + 0.5 }, diameter: Number(editor.querySelector('[name=diameter]').value) || 10 };
    editor.open = true; hooks.openEditor(); renderEndpointForm(draft); document.querySelector('#cell-popup').hidden = true; editor.scrollIntoView({ block: 'nearest' });
  });
  document.querySelector('#cell-popup').append(place);
  let endpoint = null, draft = null, recording = null, tracks = new Map(), map = null, elapsed = 0, playing = false, lastFrame = null, drawingKey = '', navigating = false, missingSections = false;
  let queryVersion = 0, cursor = null, results = [], filters = {}, wasEditing = false, historyKey, opening = 0, refreshingMap = false;
  let searchTimer;
  let timer, disposed = false, endpointDirty = false; const played = new Set(), seenLive = new Set();
  const report = error => { $('.run-status').textContent = error.message; };
  function renderEndpointForm(value) {
    editor.querySelector('.endpoint-place').textContent = value ? `Section ${value.sectionId} · X ${value.local.x}, Z ${value.local.z}` : 'No endpoint set.';
    editor.querySelector('[name=height]').value = value?.local.y ?? '';
    editor.querySelector('[name=diameter]').value = value?.diameter ?? 10;
  }
  async function changeEndpoint(value) {
    try {
      const data = await request('/api/project/run-endpoint', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: value }) });
      endpoint = data.endpoint; draft = null; endpointDirty = false; renderEndpointForm(endpoint); editor.querySelector('.endpoint-status').textContent = 'Saved. Applies to the next run.';
    } catch (error) { editor.querySelector('.endpoint-status').textContent = error.message; }
  }
  editor.querySelector('form').addEventListener('input', () => { endpointDirty = true; });
  editor.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const value = draft ?? endpoint; if (value) void changeEndpoint({ ...value, diameter: Number(editor.querySelector('[name=diameter]').value), local: { ...value.local, y: Number(editor.querySelector('[name=height]').value) } }); });
  editor.querySelector('.endpoint-clear').addEventListener('click', () => { if (confirm('Remove the endpoint for future runs?')) void changeEndpoint(null); });
  function readFilters() {
    const data = new FormData($('.run-search')), value = { name: String(data.get('name')).trim() };
    const day = String(data.get('day'));
    if (day) { const start = new Date(`${day}T00:00`), end = new Date(start); end.setDate(end.getDate() + 1); value.from = start.getTime(); value.to = end.getTime(); }
    for (const key of ['from', 'to']) if (data.get(key)) value[key] = new Date(String(data.get(key))).getTime();
    if (value.from !== undefined && value.to !== undefined && value.from >= value.to) throw new Error('Until must be after From.');
    return value;
  }
  function renderResults() {
    const list = $('.run-results'); list.replaceChildren();
    for (const run of results) {
      const row = document.createElement('article'); row.className = `run-card ${run.status}`;
      const title = button('', () => void open(run.id)); title.className = 'run-participants';
      run.participants.forEach((participant, index) => {
        if (index) { const separator = document.createElement('span'); separator.className = 'run-ampersand'; separator.textContent = '&'; title.append(separator); }
        const person = document.createElement('span'); person.className = 'run-person';
        const name = document.createElement('span'); name.textContent = participant.name;
        person.append(playerHead(participant), name); title.append(person);
      });
      title.setAttribute('aria-label', `Replay ${run.status}: ${run.participants.map(p => p.name).join(' and ')}`);
      const meta = document.createElement('small'); meta.textContent = `${new Date(run.startedAt).toLocaleString()} · ${run.status} · ${durationLabel(run.durationMs)}`;
      const stats = document.createElement('small'); stats.textContent = run.participants.map(p => `${p.name} ${durationLabel(p.durationMs)}`).join(' / ');
      row.append(title, meta, stats);
      if (hooks.state().editing) row.append(button('Delete recording', async () => {
        if (!confirm('Delete this recording and its routes? Existing backups retain their copies.')) return;
        try { await request(`/api/project/runs/${encodeURIComponent(run.id)}`, { method: 'DELETE' }); if (recording?.id === run.id) close(); await search(); }
        catch (error) { report(error); }
      }));
      list.append(row);
    }
    $('.run-more').hidden = !cursor;
  }
  async function search(more = false) {
    const version = ++queryVersion;
    try {
      clearTimeout(searchTimer);
      if (!more) {
        cursor = null; $('.run-more').hidden = true;
        filters = readFilters();
        if (filters.name.length > 0 && filters.name.length < 3) {
          results = []; renderResults();
          $('.run-status').textContent = 'Enter at least 3 characters to search player names.';
          return;
        }
      }
      $('.run-status').textContent = 'Loading recordings…';
      const params = new URLSearchParams({ ...filters, limit: more ? 10 : 5, ...(more && cursor ? cursor : {}) });
      const data = await request(`/api/runs?${params}`);
      if (version !== queryVersion) return;
      results = more ? [...results, ...data.runs] : data.runs; cursor = data.next; renderResults();
      $('.run-status').textContent = results.length ? `${results.length} recordings` : 'No recordings match these filters.';
    } catch (error) { if (version === queryVersion) report(error); }
  }
  const datePopover = $('.run-date-popover'), dateToggle = $('.run-date-toggle');
  function positionDatePopover() {
    const rect = dateToggle.getBoundingClientRect();
    datePopover.style.left = `${Math.max(10, Math.min(rect.right - datePopover.offsetWidth, window.innerWidth - datePopover.offsetWidth - 10))}px`;
    datePopover.style.top = `${Math.max(10, Math.min(rect.bottom + 8, window.innerHeight - datePopover.offsetHeight - 10))}px`;
  }
  datePopover.addEventListener('toggle', event => { if (event.newState === 'open') positionDatePopover(); });
  window.addEventListener('resize', () => { if (datePopover.matches(':popover-open')) positionDatePopover(); });
  function scheduleSearch(delay = 0) {
    clearTimeout(searchTimer);
    queryVersion++; cursor = null; $('.run-more').hidden = true;
    results = []; renderResults();
    const name = $('.run-search [name=name]').value.trim();
    $('.run-status').textContent = name.length > 0 && name.length < 3 ? 'Enter at least 3 characters to search player names.' : 'Searching...';
    dateToggle.dataset.active = String(['day', 'from', 'to'].some(key => $(`[name=${key}]`).value));
    searchTimer = setTimeout(() => void search(), delay);
  }
  $('.run-search').addEventListener('submit', e => { e.preventDefault(); scheduleSearch(); });
  $('.run-search [name=name]').addEventListener('input', () => scheduleSearch(300));
  datePopover.addEventListener('change', () => scheduleSearch());
  $('.run-date-clear').addEventListener('click', () => {
    for (const key of ['day', 'from', 'to']) $(`[name=${key}]`).value = '';
    scheduleSearch();
  });
  $('.run-more').addEventListener('click', () => void search(true));
  async function open(id) {
    const token = ++opening;
    try {
      const [data, manifest] = await Promise.all([request(`/api/runs/${encodeURIComponent(id)}`), request('/api/map/manifest')]);
      if (token !== opening) return;
      recording = data; map = manifest; tracks = indexRecording(data, map); elapsed = 0; playing = false; played.clear(); drawingKey = ''; hooks.stopLive();
      const sectionIds = new Set(map.floors.flatMap(f => f.sections.map(s => s.id)));
      missingSections = data.samples.some(s => !sectionIds.has(s.sectionId));
      $('.run-replay').hidden = false; document.querySelector('#map-frame').classList.add('replaying');
      area.firstElementChild.open = false;
      $('.run-title').textContent = `${data.participants.map(p => p.name).join(' & ')} · ${data.status}`;
      $('.run-timeline').max = String(Math.max(1, data.durationMs)); $('.run-timeline').value = '0'; $('.run-play').textContent = 'Play';
      $('.run-follow').replaceChildren(new Option('Free camera', ''), ...data.participants.map(p => new Option(p.name, p.uuid)));
      $('.run-follow').value = data.participants[0]?.uuid ?? '';
      heads.replaceChildren(...data.participants.map(p => { const img = document.createElement('img'); img.className = 'run-head'; img.dataset.uuid = p.uuid; img.alt = p.name; img.title = p.name; img.src = `/api/players/${p.uuid}/head`; img.addEventListener('error', () => { if (!img.src.endsWith('/icons/player.svg')) img.src = '/icons/player.svg'; }); return img; }));
      $('.run-replay').scrollIntoView({ block: 'nearest' });
    } catch (error) { report(error); }
  }
  function close() { opening++; recording = null; playing = false; overlay.replaceChildren(); heads.replaceChildren(); annotations.replaceChildren(); $('.run-replay').hidden = true; area.firstElementChild.open = true; document.querySelector('#map-frame').classList.remove('replaying'); }
  $('.run-exit').addEventListener('click', close);
  $('.run-play').addEventListener('click', () => { if (!recording) return; if (elapsed >= recording.durationMs) { elapsed = 0; played.clear(); } playing = !playing; $('.run-play').textContent = playing ? 'Pause' : 'Play'; });
  $('.run-restart').addEventListener('click', () => { elapsed = 0; played.clear(); playing = true; $('.run-play').textContent = 'Pause'; });
  $('.run-timeline').addEventListener('input', e => { elapsed = Number(e.target.value); for (const event of recording?.encounters ?? []) if (event.time <= recording.startedAt + elapsed) played.add(event.markerId); });
  function pulse(event) {
    const node = [...document.querySelectorAll('[data-marker-id]')].find(n => n.dataset.markerId === event.markerId);
    if (node && !node.hidden) node.animate([{ scale: '1' }, { scale: '1.5', filter: 'brightness(1.6)' }, { scale: '1' }], { duration: 650 });
  }
  function draw(time) {
    const state = hooks.state(), floor = state.floor, dt = lastFrame === null ? 0 : Math.min(1000, time - lastFrame); lastFrame = time;
    editor.hidden = !state.editing; place.hidden = !state.editing;
    if (state.editing !== wasEditing) { wasEditing = state.editing; renderResults(); }
    if (!floor) return;
    const pixels = floor.renderer?.pixelSize ?? 16, sections = new Map((floor.sections ?? []).map(s => [s.id, s]));
    const display = sample => { if (sample.display) return sample.floorId === floor.id ? sample.display : null; const section = sections.get(sample.sectionId); return section ? { x: section.placementX + sample.local.x, z: section.placementZ + sample.local.z } : null; };
    const visibleEndpoint = recording ? recording.endpoint : endpoint, ep = visibleEndpoint && display(visibleEndpoint);
    endpointNode.hidden = !ep || (!state.editing && !recording);
    if (ep) { endpointNode.style.left = `${ep.x * pixels}px`; endpointNode.style.top = `${(floor.bounds.depth - ep.z) * pixels}px`; endpointNode.style.transform = `translate(-50%,-50%) scale(${1 / state.zoom})`; }
    if (!recording) return;
    if (map?.projectRevision !== floor.projectRevision && !refreshingMap) {
      refreshingMap = true;
      const token = opening;
      void request('/api/map/manifest').then(manifest => {
        if (token !== opening || !recording) return;
        map = manifest; tracks = indexRecording(recording, map); drawingKey = '';
        const ids = new Set(map.floors.flatMap(f => f.sections.map(s => s.id)));
        missingSections = recording.samples.some(s => !ids.has(s.sectionId));
      }).catch(report).finally(() => { refreshingMap = false; });
    }
    const previous = elapsed;
    if (playing) elapsed = Math.min(recording.durationMs, elapsed + dt * Number($('.run-speed').value));
    const absolute = recording.startedAt + elapsed;
    if (playing) for (const event of recording.encounters) if (!played.has(event.markerId) && event.time >= recording.startedAt + previous && event.time <= absolute) { played.add(event.markerId); pulse(event); }
    if (elapsed >= recording.durationMs) { playing = false; $('.run-play').textContent = 'Play'; }
    $('.run-timeline').value = String(elapsed); $('.run-clock').textContent = `${durationLabel(elapsed)} / ${durationLabel(recording.durationMs)}`;
    const key = `${recording.id}:${floor.id}:${floor.projectRevision}`;
    if (key !== drawingKey) {
      drawingKey = key; overlay.replaceChildren(); annotations.replaceChildren(); overlay.setAttribute('viewBox', `0 0 ${floor.bounds.width * pixels} ${floor.bounds.depth * pixels}`);
      let index = 0;
      for (const [uuid, samples] of tracks) {
        for (const segment of routeSegments(samples, new Set(sections.keys()))) {
          const line = document.createElementNS(svgNS, 'polyline'); line.setAttribute('points', segment.map(s => { const p = display(s); return `${p.x * pixels},${(floor.bounds.depth - p.z) * pixels}`; }).join(' '));
          line.setAttribute('vector-effect', 'non-scaling-stroke'); if (index) line.setAttribute('stroke-dasharray', '7 5');
          const glow = line.cloneNode(); glow.classList.add('run-route-glow');
          const outline = line.cloneNode(); outline.classList.add('run-route-outline');
          line.classList.add('run-route-line'); overlay.append(glow, outline, line);
        }
        const participant = recording.participants.find(p => p.uuid === uuid);
        for (const annotation of routeAnnotations(samples, recording.status)) {
          const point = display(annotation.sample); if (!point) continue;
          const isExit = annotation.kind === 'exit';
          const label = isExit ? `${participant.name} → ${annotation.destination.floorName ?? annotation.destination.floorId} · ${annotation.destination.sectionName ?? annotation.destination.sectionId}` : `${participant.name} · Last known position`;
          const node = document.createElement('div'); node.className = `run-annotation run-${annotation.kind}-marker`; node.title = label; node.setAttribute('aria-label', label);
          const icon = document.createElement('span'); icon.className = 'run-annotation-icon'; icon.textContent = isExit ? '↗' : '×';
          const text = document.createElement('span'); text.textContent = label; node.append(icon, text);
          node.style.left = `${point.x * pixels}px`; node.style.top = `${(floor.bounds.depth - point.z) * pixels}px`;
          annotations.append(node);
        }
        index++;
      }
    }
    for (const annotation of annotations.children) annotation.style.transform = `scale(${1 / state.zoom}) translate(-14px,-14px)`;
    const transitions = [];
    for (const img of heads.children) {
      const sample = replayPosition(tracks.get(img.dataset.uuid), absolute), point = sample && display(sample);
      img.hidden = !point;
      if (sample?.transition) {
        const name = recording.participants.find(p => p.uuid === img.dataset.uuid)?.name;
        transitions.push(`${name} → ${sample.transition.floorName ?? sample.transition.floorId} · ${sample.transition.sectionName ?? ''}`);
      }
      if (point) { img.style.left = `${point.x * pixels}px`; img.style.top = `${(floor.bounds.depth - point.z) * pixels}px`; img.style.transform = `translate(-50%,-50%) scale(${1 / state.zoom})`; }
      if (sample && img.dataset.uuid === $('.run-follow').value) {
        const target = map?.floors.find(f => f.sections.some(s => s.id === sample.sectionId));
        if (target && target.id !== floor.id && !navigating) { navigating = true; void hooks.navigate(target.id).catch(report).finally(() => { navigating = false; }); }
        else if (point && !navigating) hooks.center(point);
      }
    }
    $('.run-gap').textContent = missingSections ? 'Map section unavailable for part of this recording.' : transitions.join(' / ');
  }
  async function poll() {
    try {
      const data = await request('/api/runs/live'); endpoint = data.endpoint;
      if (!draft && !endpointDirty && !editor.querySelector('form').contains(document.activeElement)) renderEndpointForm(endpoint);
      $('.run-live').textContent = data.active ? `Recording · ${data.active.participants.map(p => p.name).join(' + ')} · ${durationLabel(data.active.durationMs)}` : 'Ready for the next run';
      const recentKeys = new Set(data.encounters.map(e => `${e.runId}:${e.markerId}`));
      for (const key of seenLive) if (!recentKeys.has(key)) seenLive.delete(key);
      for (const event of data.encounters) { const key = `${event.runId}:${event.markerId}`; if (!seenLive.has(key)) { seenLive.add(key); if (!recording) pulse(event); } }
      const nextKey = data.active?.id ?? 'idle'; if (historyKey !== nextKey) { historyKey = nextKey; await search(); }
    } catch (error) { $('.run-live').textContent = `Recording status unavailable: ${error.message}`; }
    if (!disposed) timer = setTimeout(poll, 2000);
  }
  window.addEventListener('pagehide', () => { disposed = true; clearTimeout(timer); clearTimeout(searchTimer); queryVersion++; });
  window.addEventListener('pageshow', event => { if (event.persisted) { disposed = false; void poll(); } });
  void poll();
  return { draw, get replaying() { return Boolean(recording); }, stopFollow() { $('.run-follow').value = ''; }, get following() { return recording && $('.run-follow').value; } };
}
