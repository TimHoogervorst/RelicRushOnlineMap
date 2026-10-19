import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { openProject, encodeSectionChunks, snapshotProject, projectRevision, transformSection, restoreSectionTransform, captureProjectLifecycleState, restoreProjectLifecycleState } from '../src/project-store.js';
import { saveCalibration, locatePlayers, trackingSections } from '../src/player-tracking.js';
import { editTrackerPoints, activeTrackerPoints, trackerOverlaps } from '../src/tracker-points.js';
import { createApp } from '../src/server.js';
import { createProjectBackup, restoreProjectBackup } from '../src/backup-service.js';

const player = { uuid: 'a'.repeat(32), name: 'Explorer', world: 'world', x: 100.25, y: 65.25, z: 200.75 };
function seed(db) {
  db.prepare('INSERT INTO floors VALUES(?,?,?)').run('f', 'Floor', 0);
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,provenance_json) VALUES(?,?,?,?,?)').run('s', 'f', 'Section', '{"x":8,"y":4,"z":12}', '{}');
  for (const c of encodeSectionChunks([{ x: 1, y: 0, z: 2, id: 'minecraft:stone' }])) db.prepare('INSERT INTO section_chunks VALUES(?,?,?,?,1,?)').run('s', c.cx, c.cy, c.cz, c.compressed);
  saveCalibration(db, 's', { world: 'world', local: { x: 1, y: 0, z: 2 }, actual: { x: 100, y: 64, z: 200 }, region: { min: { x: 90, y: 60, z: 190 }, max: { x: 91, y: 61, z: 191 } } }, 0);
}
function sections(db) { return trackingSections(snapshotProject(db)); }
test('tracker override respects cylindrical reach, worlds, nearest distance and ties before floor selection', () => {
  const db = openProject(':memory:');
  try {
    seed(db); editTrackerPoints(db, { sectionId: 's', position: player }, 1);
    const lower = sections(db)[0];
    const upper = { ...lower, id: 'upper', floorId: 'upper', trackerPoints: [], calibration: { ...lower.calibration, region: { min: { x: 0, y: 64, z: 0 }, max: { x: 300, y: 100, z: 300 } } } };
    const locate = (p, list = [lower, upper], previous) => locatePlayers([p], list, previous).located[0];
    assert.equal(locate(player).sectionId, 's');
    assert.equal(locate({ ...player, y: player.y + 1 }).sectionId, 's');
    assert.equal(locate({ ...player, y: player.y + 1.01 }).sectionId, 'upper');
    assert.equal(locate({ ...player, x: player.x + 3 }).sectionId, 's');
    assert.equal(locate({ ...player, x: player.x + 3, z: player.z + 0.1 }).sectionId, 'upper');
    assert.equal(locate({ ...player, world: 'other' }).status, 'outside');
    const competing = { ...upper, trackerPoints: lower.trackerPoints.map(p => ({ ...p, local: { ...p.local, x: p.local.x + 2 } })) };
    assert.equal(locate({ ...player, x: player.x + 1.5 }, [lower, competing]).sectionId, 'upper');
    const tie = { ...player, x: player.x + 1 };
    assert.equal(locate(tie, [lower, competing]).status, 'ambiguous');
    assert.equal(locate(tie, [lower, competing], new Map([[player.uuid, 's']])).sectionId, 's');
    assert.equal(trackerOverlaps([lower, competing]).length, 1);
    assert.equal(locate(player, [{ ...lower, calibration: null }]).status, 'outside');
    assert.equal(locate(player).display.x, lower.placementX + lower.trackerPoints[0].local.x);
    assert.notEqual(locate({ ...player, x: player.x + 0.5 }).display.x, locate(player).display.x, 'position is not snapped');
  } finally { db.close(); }
});

test('fractional captures follow recalibration and survive every rotation/flip, transform undo and lifecycle restore', () => {
  for (const rotation of [0, 90, 180, 270]) for (const flipHorizontal of [false, true]) for (const flipVertical of [false, true]) {
    if (!rotation && !flipHorizontal && !flipVertical) continue;
    const db = openProject(':memory:');
    try {
      seed(db); editTrackerPoints(db, { sectionId: 's', position: player }, 1);
      const before = sections(db)[0].trackerPoints;
      const operation = { sectionId: 's', rotation, flipHorizontal, flipVertical };
      transformSection(db, operation, 2);
      assert.deepEqual(activeTrackerPoints(sections(db))[0].position, { x: player.x, y: player.y, z: player.z });
      restoreSectionTransform(db, operation, 'undo', 3);
      assert.deepEqual(sections(db)[0].trackerPoints, before);
      const c = sections(db)[0].calibration;
      saveCalibration(db, 's', { ...c, actual: { ...c.actual, y: c.actual.y + 5 } }, 4);
      assert.equal(activeTrackerPoints(sections(db))[0].position.y, player.y + 5);
      saveCalibration(db, 's', null, 5); assert.equal(activeTrackerPoints(sections(db)).length, 0);
      saveCalibration(db, 's', c, 6); assert.equal(activeTrackerPoints(sections(db))[0].position.y, player.y);
      const lifecycle = captureProjectLifecycleState(db);
      db.prepare('DELETE FROM sections WHERE id=?').run('s');
      restoreProjectLifecycleState(db, lifecycle, 7);
      assert.deepEqual(sections(db)[0].trackerPoints, before);
    } finally { db.close(); }
  }
});

test('tracker input validation keeps project state unchanged on invalid coordinates, world, reach and revision', () => {
  const db = openProject(':memory:');
  try {
    seed(db);
    for (const input of [{ sectionId: 's', position: { ...player, x: Infinity } }, { sectionId: 's', position: { ...player, world: 'other' } }, { settings: { horizontal: 0, vertical: 1 } }]) assert.throws(() => editTrackerPoints(db, input, 1));
    assert.throws(() => editTrackerPoints(db, { sectionId: 's', position: player }, 0), /another editor/);
    assert.equal(projectRevision(db), 1); assert.deepEqual(sections(db)[0].trackerPoints, []);
  } finally { db.close(); }
});

test('tracker API publishes without rendering, protects writes, supports history, and includes points/settings in backups', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-trackers-'));
  const db = openProject(path.join(dataDir, 'project.sqlite')); seed(db); db.close();
  let renders = 0;
  const renderer = { async render({ output }) { renders++; await writeFile(output, await sharp({ create: { width: 128, height: 192, channels: 4, background: '#123456' } }).png().toBuffer()); return { width: 128, height: 192, bounds: { width: 8, depth: 12 }, renderer: { pixelSize: 16 } }; } };
  const app = createApp({ dataDir, initializeWorker: false, password: 'secret', renderer, playerFetcher: async () => Response.json({ players: [player] }) });
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, endpoint = `${origin}/api/project/tracker-points`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { origin, 'content-type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal((await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) })).status, 200);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, origin: 'https://other.example' }, body: '{}' })).status, 403);
  const edit = async input => { const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) }); const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body)); return body; };
  await edit({ sectionId: 's', position: player, expectedRevision: 1 });
  assert.equal((await fetch(`${origin}/api/players`).then(r => r.json())).players[0].assignmentSource, 'tracker');
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ sectionId: 's', position: player, expectedRevision: 1 }) })).status, 409);
  await edit({ direction: 'undo', expectedRevision: 2 });
  assert.equal((await fetch(`${origin}/api/players`).then(r => r.json())).players.length, 0);
  await edit({ direction: 'redo', expectedRevision: 3 });
  await edit({ settings: { horizontal: 4, vertical: 0.5 }, expectedRevision: 4 });
  assert.equal(renders, 1);
  const diagnostics = await fetch(`${origin}/api/project/tracking`, { headers }).then(r => r.json());
  assert.deepEqual(diagnostics.trackingSettings, { horizontal: 4, vertical: 0.5 });
  const backup = await createProjectBackup({ dataDir });
  await edit({ sectionId: 's', id: diagnostics.sections[0].trackerPoints[0].id, delete: true, expectedRevision: 5 });
  await restoreProjectBackup({ dataDir, bytes: backup, confirm: 'RESTORE PROJECT' });
  const restored = openProject(path.join(dataDir, 'project.sqlite'));
  try { assert.deepEqual(snapshotProject(restored).trackingSettings, { horizontal: 4, vertical: 0.5 }); assert.deepEqual(sections(restored)[0].trackerPoints, diagnostics.sections[0].trackerPoints); } finally { restored.close(); }
});
