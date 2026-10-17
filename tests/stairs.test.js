import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { linkStairs, openProject, projectRevision, readMarker, restoreMarker, saveMarker, setSectionLayout, snapshotProject } from '../src/project-store.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

function addSyntheticFloors(db) {
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('synthetic-lower', 'Synthetic Lower Test Floor', 0);
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('synthetic-upper', 'Synthetic Upper Test Floor', 1);
  for (const [id, floorId, x] of [['section-lower', 'synthetic-lower', 0], ['section-upper', 'synthetic-upper', 0], ['section-upper-east', 'synthetic-upper', 20]]) {
    db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run(id, floorId, id, JSON.stringify({ x: 8, y: 4, z: 8 }), x, 0, '{}');
  }
}

test('stair pairing is reciprocal, cross-floor, unique, follows section transforms and cleans up atomically', () => {
  const db = openProject(':memory:');
  try {
    addSyntheticFloors(db);
    const lower = saveMarker(db, { sectionId: 'section-lower', type: 'stairs', name: 'Lower stair', x: 2.5, z: 3.5 }, 0);
    const upper = saveMarker(db, { sectionId: 'section-upper', type: 'stairs', name: 'Upper stair', x: 4.5, z: 5.5 }, 1);
    const other = saveMarker(db, { sectionId: 'section-upper-east', type: 'stairs', name: 'Other upper stair', x: 1.5, z: 1.5 }, 2);
    assert.throws(() => linkStairs(db, upper.id, other.id, 3), /different floors/i);
    assert.deepEqual(linkStairs(db, lower.id, upper.id, 3), { firstId: lower.id, secondId: upper.id, revision: 4 });
    assert.throws(() => linkStairs(db, lower.id, other.id, 4), /only one connection/i);
    assert.throws(() => saveMarker(db, { sectionId: 'section-lower', type: 'other', name: 'Lower stair', x: 2.5, z: 3.5 }, 4, lower.id), /confirm removing/i);
    assert.throws(() => saveMarker(db, { sectionId: 'section-upper', type: 'stairs', name: 'Lower stair', x: 2.5, z: 3.5 }, 4, lower.id), /cannot change floors/i);

    const beforeMove = snapshotProject(db).floors.find(floor => floor.id === 'synthetic-upper').markers.find(item => item.id === upper.id);
    assert.equal(beforeMove.stairDestinationId, lower.id);
    assert.equal(beforeMove.x, 4.5);
    // A section layout edit is independent of the stable stair ID. The next saved snapshot resolves it at its new position.
    setSectionLayout(db, { sectionId: 'section-upper', placementX: 12, placementZ: 0 }, 4);
    const afterMove = snapshotProject(db).floors.find(floor => floor.id === 'synthetic-upper').markers.find(item => item.id === upper.id);
    assert.equal(afterMove.stairDestinationId, lower.id);
    assert.equal(afterMove.x, beforeMove.x + 12);

    // The blocked type change does not change the revision or either endpoint.
    assert.equal(projectRevision(db), 5);
    const beforeTypeChange = readMarker(db, lower.id);
    const typed = saveMarker(db, { sectionId: 'section-lower', type: 'other', name: 'Lower stair', x: 2.5, z: 3.5 }, 5, lower.id, { confirmUnlink: true });
    assert.equal(typed.revision, 6);
    assert.equal(snapshotProject(db).floors.flatMap(floor => floor.markers).find(item => item.id === upper.id).stairDestinationId, null);
    restoreMarker(db, lower.id, beforeTypeChange, 6);
    assert.equal(readMarker(db, upper.id).stairDestinationId, lower.id, 'undo restores the reciprocal partner link');
  } finally { db.close(); }
});

test('authenticated stair linking is published to both synthetic floors and survives service restart; delete unlinks partner', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-stairs-'));
  const db = openProject(path.join(dataDir, 'project.sqlite'));
  addSyntheticFloors(db);
  const lower = saveMarker(db, { sectionId: 'section-lower', type: 'stairs', name: 'Synthetic Lower Landing', x: 2.5, z: 3.5 }, 0);
  const upper = saveMarker(db, { sectionId: 'section-upper', type: 'stairs', name: 'Synthetic Upper Landing', x: 4.5, z: 5.5 }, 1);
  db.close();
  const renderer = { async render({ output }) { await writeFile(output, png); return { width: 8, height: 8, bounds: { width: 8, depth: 8 }, renderer: { pixelSize: 1 } }; } };
  let server = createServer(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const denied = await fetch(`${origin}/api/project/stairs/link`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ expectedRevision: 2, firstId: lower.id, secondId: upper.id }) });
  assert.equal(denied.status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  const baseline = await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(baseline.status, 200, (await baseline.clone().json()).error);
  const linked = await fetch(`${origin}/api/project/stairs/link`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2, firstId: lower.id, secondId: upper.id }) });
  assert.equal(linked.status, 200, (await linked.clone().json()).error);
  const linkedResult = await linked.json();
  assert.equal(linkedResult.revision, 3);
  assert.equal(linkedResult.saved.revision, 3);
  let publicManifest = await fetch(`${origin}/api/map/manifest`).then(response => response.json());
  for (const expected of [[lower.id, upper.id, 'synthetic-lower'], [upper.id, lower.id, 'synthetic-upper']]) {
    const item = publicManifest.floors.find(floor => floor.id === expected[2]).markers.find(marker => marker.id === expected[0]);
    assert.equal(item.stairDestinationId, expected[1]);
  }
  await new Promise(resolve => server.close(resolve));
  server = createServer(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  publicManifest = await fetch(`${origin}/api/map/manifest`).then(response => response.json());
  assert.equal(publicManifest.projectRevision, 3);
  assert.equal(publicManifest.floors.find(floor => floor.id === 'synthetic-upper').markers.find(marker => marker.id === upper.id).stairDestinationId, lower.id);
  const newLogin = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const newHeaders = { cookie: newLogin.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  const deleted = await fetch(`${origin}/api/project/markers/${encodeURIComponent(lower.id)}`, { method: 'DELETE', headers: newHeaders, body: JSON.stringify({ expectedRevision: 3 }) });
  assert.equal(deleted.status, 409, 'a linked stair cannot be deleted without explicit unlink confirmation');
  const deletedConfirmed = await fetch(`${origin}/api/project/markers/${encodeURIComponent(lower.id)}`, { method: 'DELETE', headers: newHeaders, body: JSON.stringify({ expectedRevision: 3, confirmUnlink: true }) });
  assert.equal(deletedConfirmed.status, 200, (await deletedConfirmed.clone().json()).error);
  assert.equal((await fetch(`${origin}/api/map/manifest`).then(response => response.json())).floors.find(floor => floor.id === 'synthetic-upper').markers.find(marker => marker.id === upper.id).stairDestinationId, null);
});
