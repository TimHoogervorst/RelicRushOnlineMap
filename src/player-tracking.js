import { activeTrackerPoints, trackerCandidates, trackerOverlaps, DEFAULT_REACH } from './tracker-points.js';
import { readSectionBlocks, advanceProjectRevision, projectRevision } from './project-store.js';
import { DEFAULT_TRACKING_ORIENTATION, defaultTrackingRegion, worldToLocal } from './tracking-coordinates.js';

export const PLAYER_FEED = 'https://kaart.wereldbouw.net/tiles/players.json';
export const STALE_MS = 15000;
const axes = ['x', 'y', 'z'];
const validPoint = p => p && axes.every(axis => Number.isSafeInteger(p[axis]) && Math.abs(p[axis]) <= 30000000);

export function saveCalibration(db, sectionId, input, revision) {
  if (!Number.isSafeInteger(revision) || revision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const section = db.prepare('SELECT * FROM sections WHERE id=?').get(sectionId);
  if (!section) throw new Error('Section does not exist.');
  let calibration = null;
  if (input !== null) {
    if (!validPoint(input?.local) || !validPoint(input?.actual)) throw new Error('Waypoint coordinates must be whole block coordinates.');
    if (typeof input.world !== 'string' || !/^[a-zA-Z0-9_:./-]{1,120}$/.test(input.world)) throw new Error('Choose a valid Minecraft world.');
    const previous = section.calibration_json && JSON.parse(section.calibration_json);
    const blocks = readSectionBlocks(db, sectionId);
    const sameAnchor = previous && axes.every(axis => previous.local[axis] === input.local[axis]);
    if (!sameAnchor && !blocks.some(block => axes.every(axis => block[axis] === input.local[axis]))) throw new Error('Select an existing block for the waypoint.');
    const orientation = section.tracking_orientation_json ? JSON.parse(section.tracking_orientation_json) : DEFAULT_TRACKING_ORIENTATION;
    let region = input.region;
    if (!region && previous && !previous.invalidReason) region = previous.region;
    if (!region) {
      region = defaultTrackingRegion(blocks, input, orientation);
    }
    if (!validPoint(region.min) || !validPoint(region.max) || axes.some(axis => region.min[axis] >= region.max[axis])) throw new Error('Tracking limits need whole coordinates with minimum below maximum on each axis.');
    calibration = { world: input.world, local: input.local, actual: input.actual, region, invalidReason: null, coordinateVersion: 2 };
  }
  return db.transaction(() => {
    db.prepare('UPDATE sections SET calibration_json=? WHERE id=?').run(calibration ? JSON.stringify(calibration) : null, sectionId);
    advanceProjectRevision(db, revision);
    return { revision: revision + 1, calibration };
  })();
}

export function trackingSections(manifest) {
  return (manifest.floors ?? []).flatMap(floor => (floor.sections ?? []).map(section => ({ ...section, floorId: floor.id, floorName: floor.name })));
}

export function overlappingRegions(sections) {
  const valid = sections.filter(s => s.calibration && !s.calibration.invalidReason), overlaps = [];
  for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
    const a = valid[i], b = valid[j], ca = a.calibration, cb = b.calibration;
    if (ca.world === cb.world && axes.every(axis => ca.region.min[axis] < cb.region.max[axis] && cb.region.min[axis] < ca.region.max[axis])) overlaps.push([a.id, b.id]);
  }
  return overlaps;
}

export function locatePlayers(players, sections, previous = new Map(), reach = DEFAULT_REACH) {
  const assignments = new Map(), points = activeTrackerPoints(sections);
  const located = players.map(player => {
    const candidates = sections.filter(section => {
      const c = section.calibration;
      return c && !c.invalidReason && c.world === player.world && axes.every(axis => player[axis] >= c.region.min[axis] && player[axis] < c.region.max[axis]);
    });
    // Choose elevation before applying section history. Headroom or tall geometry
    // can overlap the next floor, but must not pin a climbing player downstairs.
    const floors = new Map();
    for (const candidate of candidates) {
      floors.set(candidate.floorId, Math.max(floors.get(candidate.floorId) ?? -Infinity, candidate.calibration.region.min.y));
    }
    const highestBase = Math.max(-Infinity, ...floors.values());
    const floorCandidates = candidates.filter(candidate => floors.get(candidate.floorId) === highestBase);
    const corrections = trackerCandidates(player, points, reach);
    const choices = corrections.length ? corrections : floorCandidates;
    const section = choices.length === 1 ? choices[0] : choices.find(s => s.id === previous.get(player.uuid));
    if (!section) return { ...player, status: choices.length ? 'ambiguous' : 'outside', candidates: choices.map(s => s.name) };
    assignments.set(player.uuid, section.id);
    const c = section.calibration;
    const local = worldToLocal(player, c, section.trackingOrientation);
    return { ...player, status: 'mapped', assignmentSource: corrections.length ? 'tracker' : 'region', sectionId: section.id, sectionName: section.name, floorId: section.floorId, floorName: section.floorName, trackingY: { min: c.region.min.y, max: c.region.max.y }, local, display: { x: local.x + section.placementX, z: local.z + section.placementZ } };
  });
  return { located, assignments };
}

export async function limitedResponse(response, maximum) {
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('Upstream response is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createPlayerTracker({ fetcher = fetch, now = Date.now } = {}) {
  let players = [], updatedAt = null, attemptedAt = -Infinity, pending, failed = false, assignments = new Map(), diagnosticAssignments = new Map();
  async function refresh() {
    if (pending) return pending;
    if (now() - attemptedAt < 2000) return;
    attemptedAt = now();
    pending = (async () => {
      try {
        const bytes = await limitedResponse(await fetcher(PLAYER_FEED, { signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store' }), 1024 * 1024);
        const data = JSON.parse(bytes);
        if (!Array.isArray(data.players) || data.players.length > 1000) throw new Error('Invalid player feed.');
        const seen = new Set();
        const next = data.players.map(p => {
          const uuid = typeof p.uuid === 'string' ? p.uuid.replaceAll('-', '').toLowerCase() : '';
          if (!/^[a-f0-9]{32}$/.test(uuid) || seen.has(uuid) || typeof p.name !== 'string' || p.name.length > 64 || typeof p.world !== 'string' || p.world.length > 120 || !axes.every(axis => Number.isFinite(p[axis]) && Math.abs(p[axis]) <= 30000000)) throw new Error('Invalid player record.');
          seen.add(uuid); return { uuid, name: p.name, world: p.world, x: p.x, y: p.y, z: p.z };
        });
        players = next; updatedAt = now(); failed = false;
      } catch { failed = true; }
      finally { pending = null; }
    })();
    return pending;
  }
  return {
    async snapshot(manifest, diagnostics = false) {
      await refresh();
      const expired = updatedAt === null || now() - updatedAt >= STALE_MS;
      const sections = trackingSections(manifest);
      const result = locatePlayers(expired ? [] : players, sections, diagnostics ? diagnosticAssignments : assignments, manifest.trackingSettings);
      if (diagnostics) diagnosticAssignments = result.assignments;
      else assignments = result.assignments;
      return { updatedAt, ageMs: updatedAt === null ? null : Math.max(0, now() - updatedAt), stale: failed || expired, expired, players: result.located.filter(p => p.status === 'mapped'), ...(diagnostics ? { diagnostics: result.located, worlds: [...new Set(players.map(p => p.world))], trackingSettings: manifest.trackingSettings ?? DEFAULT_REACH, trackerOverlaps: trackerOverlaps(sections, manifest.trackingSettings), overlaps: overlappingRegions(sections) } : {}) };
    },
    knows(uuid) { return players.some(p => p.uuid === uuid); }
  };
}
