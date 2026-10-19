import { randomUUID } from 'node:crypto';
import { projectRevision, advanceProjectRevision } from './project-store.js';
import { worldToLocal, localToWorld, DEFAULT_TRACKING_ORIENTATION } from './tracking-coordinates.js';

export const DEFAULT_REACH = { horizontal: 3, vertical: 1 };
export function activeTrackerPoints(sections) {
  return sections.flatMap(section => section.calibration && !section.calibration.invalidReason
    ? (section.trackerPoints ?? []).map(point => ({ ...point, section, world: section.calibration.world, position: localToWorld(point.local, section.calibration, section.trackingOrientation) })) : []);
}
export function trackerCandidates(player, points, reach = DEFAULT_REACH) {
  const nearby = points.filter(p => p.world === player.world && Math.hypot(p.position.x - player.x, p.position.z - player.z) <= reach.horizontal && Math.abs(p.position.y - player.y) <= reach.vertical)
    .map(p => ({ ...p, distance: Math.hypot(p.position.x - player.x, p.position.y - player.y, p.position.z - player.z) }));
  const nearest = Math.min(Infinity, ...nearby.map(p => p.distance));
  return [...new Map(nearby.filter(p => Math.abs(p.distance - nearest) < 1e-9).map(p => [p.section.id, p.section])).values()];
}
export function trackerOverlaps(sections, reach = DEFAULT_REACH) {
  const points = activeTrackerPoints(sections), overlaps = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const a = points[i], b = points[j];
    if (a.section.id !== b.section.id && a.world === b.world && Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) <= 2 * reach.horizontal && Math.abs(a.position.y - b.position.y) <= 2 * reach.vertical) overlaps.push(`${a.section.name}: ${a.name} / ${b.section.name}: ${b.name}`);
  }
  return overlaps;
}
export function trackerState(db, sectionId = null) {
  if (!sectionId) return JSON.parse(db.prepare("SELECT value FROM project_meta WHERE key='tracking_settings'").get()?.value ?? JSON.stringify(DEFAULT_REACH));
  const section = db.prepare('SELECT tracker_points_json FROM sections WHERE id=?').get(sectionId);
  if (!section) throw new Error('Section does not exist.');
  return JSON.parse(section.tracker_points_json);
}
export function writeTrackerState(db, sectionId, state, revision) {
  return db.transaction(() => {
    if (!Number.isSafeInteger(revision) || revision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
    if (sectionId) {
      if (!db.prepare('UPDATE sections SET tracker_points_json=? WHERE id=?').run(JSON.stringify(state), sectionId).changes) throw new Error('Section does not exist.');
    } else db.prepare("INSERT INTO project_meta(key,value) VALUES('tracking_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(state));
    advanceProjectRevision(db, revision);
    return { revision: revision + 1 };
  })();
}
export function editTrackerPoints(db, input, revision) {
  const sectionId = input?.sectionId ?? null, before = trackerState(db, sectionId);
  let after;
  if (!sectionId) {
    const { horizontal, vertical } = input?.settings ?? {};
    if (![horizontal, vertical].every(v => Number.isFinite(v) && v >= 0.25 && v <= 64)) throw new Error('Reach must be between 0.25 and 64 blocks.');
    after = { horizontal, vertical };
  } else {
    after = structuredClone(before);
    const index = after.findIndex(p => p.id === input.id);
    if (input.id && index < 0) throw new Error('Tracker point does not exist.');
    if (input.delete) {
      if (index < 0) throw new Error('Select a tracker point.');
      after.splice(index, 1);
    } else {
      const name = input.name?.trim() || (index >= 0 ? after[index].name : `Tracker ${after.length + 1}`);
      if (name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Use a plain-text name up to 120 characters.');
      let local = index >= 0 ? after[index].local : null;
      if (input.position) {
        const row = db.prepare('SELECT calibration_json,tracking_orientation_json FROM sections WHERE id=?').get(sectionId);
        const calibration = JSON.parse(row.calibration_json ?? 'null');
        if (!calibration || calibration.invalidReason || calibration.world !== input.position.world) throw new Error('Choose a calibrated section in the player’s Minecraft world.');
        if (!['x', 'y', 'z'].every(axis => Number.isFinite(input.position[axis]) && Math.abs(input.position[axis]) <= 30000000)) throw new Error('Invalid player coordinates.');
        local = worldToLocal(input.position, calibration, JSON.parse(row.tracking_orientation_json ?? JSON.stringify(DEFAULT_TRACKING_ORIENTATION)));
      }
      if (!local) throw new Error('Capture a player position first.');
      const point = { id: input.id ?? randomUUID(), name, local };
      if (index >= 0) after[index] = point;
      else { if (after.length >= 1000) throw new Error('This section already has 1000 tracker points.'); after.push(point); }
    }
  }
  return { ...writeTrackerState(db, sectionId, after, revision), sectionId, before, after };
}
