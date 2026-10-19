import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { openProject, saveSectionConnection, deleteSectionConnection, readSectionConnection, snapshotProject, setSectionLayout } from '../src/project-store.js';

function project() {
  const db = openProject(':memory:');
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('f1', 'Floor 1', 0);
  db.prepare('INSERT INTO floors VALUES(?,?,?)').run('f2', 'Floor 2', 1);
  for (const [id, floor, x] of [['s1', 'f1', 0], ['s2', 'f1', 40], ['s3', 'f1', 80], ['other-floor', 'f2', 0]]) {
    db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run(id, floor, id, JSON.stringify({ x: 40, y: 10, z: 30 }), x, 0, '{}');
  }
  return db;
}

test('section connections require distinct sections across floors and valid local anchors', () => {
  const db = project();
  try {
    const input = { sectionAId: 's1', xA: 2.5, zA: 3.5, sectionBId: 's2', xB: 4, zB: 5, label: 'Secret passage' };
    const first = saveSectionConnection(db, input, 0);
    const second = saveSectionConnection(db, { ...input, label: 'Alternate route' }, 1);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(snapshotProject(db).floors[0].connections.length, 2);
    assert.throws(() => db.prepare("DELETE FROM sections WHERE id='s1'").run(), /FOREIGN KEY constraint failed/i);
    assert.throws(() => saveSectionConnection(db, { ...input, sectionBId: 's1' }, 2), /different sections/i);
    assert.throws(() => saveSectionConnection(db, { ...input, xA: 41 }, 2), /anchor/i);
    assert.throws(() => saveSectionConnection(db, { ...input, label: 'x'.repeat(121) }, 2), /label/i);
    saveSectionConnection(db, { ...input, sectionBId: 'other-floor' }, 2);
    const snapshot = snapshotProject(db);
    assert.deepEqual(snapshot.unresolvedRecords.connections, []);
    const firstFloor = snapshot.floors[0].connections.find(link => link.sectionBId === 'other-floor');
    const otherFloor = snapshot.floors[1].connections[0];
    assert.equal(firstFloor.floorBId, 'f2');
    assert.deepEqual(firstFloor.displayA, { x: 2.5, z: 3.5 });
    assert.equal(firstFloor.displayB, null);
    assert.equal(otherFloor.displayA, null);
    assert.deepEqual(otherFloor.displayB, { x: 4, z: 5 });
  } finally { db.close(); }
});

test('connection edits and delete are revisioned, readable, and preserve local anchors across section moves', () => {
  const db = project();
  try {
    const created = saveSectionConnection(db, { sectionAId: 's1', xA: 2.5, zA: 3.5, sectionBId: 's2', xB: 4, zB: 5, label: '' }, 0);
    saveSectionConnection(db, { sectionAId: 's1', xA: 6.5, zA: 7.5, sectionBId: 's2', xB: 4, zB: 5, label: 'Updated' }, 1, created.id);
    assert.equal(readSectionConnection(db, created.id).xA, 6.5);
    setSectionLayout(db, { sectionId: 's1', placementX: 12, placementZ: -3, labelX: 0, labelZ: 0 }, 2);
    const view = snapshotProject(db).floors[0].connections[0];
    assert.equal(view.xA, 6.5);
    assert.equal(view.displayA.x, 18.5);
    assert.equal(view.displayA.z, 7.5);
    assert.equal(deleteSectionConnection(db, created.id, 3).revision, 4);
    assert.equal(readSectionConnection(db, created.id), null);
    assert.throws(() => saveSectionConnection(db, { sectionAId: 's1', xA: 2, zA: 2, sectionBId: 's2', xB: 3, zB: 3 }, 1), /another editor tab/i);
  } finally { db.close(); }
});

test('connection API is authenticated, metadata-only, undoable, and durable in visitor manifests', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-connections-'));
  const db = openProject(path.join(dataDir, 'project.sqlite'));
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('f1', 'Floor 1', 0);
  for (const [id, x] of [['s1', 0], ['s2', 40]]) db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run(id, 'f1', id, JSON.stringify({ x: 40, y: 10, z: 30 }), x, 0, '{}');
  db.prepare('INSERT INTO floors VALUES(?,?,?)').run('f2', 'Floor 2', 1);
  db.prepare("INSERT INTO sections(id,floor_id,name,bounds_json,provenance_json) VALUES('s3','f2','Upper room',?, '{}')").run(JSON.stringify({ x: 40, y: 10, z: 30 }));
  db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run(); db.close();
  let renders = 0;
  const renderer = { async render({ output }) { renders++; await writeFile(output, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1])); return { width: 640, height: 480, bounds: { width: 80, depth: 30 }, renderer: { pixelSize: 16 } }; } };
  async function listen() { const server = createServer(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer })); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return { server, origin: `http://127.0.0.1:${server.address().port}` }; }
  let app = await listen();
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await fetch(`${app.origin}/api/project/connections`, { method: 'POST', body: '{}' })).status, 401);
  const login = await fetch(`${app.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin: app.origin, 'content-type': 'application/json' };
  assert.equal((await fetch(`${app.origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) })).status, 200);
  const body = (expectedRevision, connection) => JSON.stringify({ expectedRevision, connection });
  const first = await fetch(`${app.origin}/api/project/connections`, { method: 'POST', headers, body: body(1, { sectionAId: 's1', xA: 2.5, zA: 3.5, sectionBId: 's2', xB: 4.5, zB: 5.5, label: 'Passage' }) });
  assert.equal(first.status, 201, (await first.clone().json()).error);
  const firstData = await first.json();
  assert.equal(firstData.saved, true);
  const second = await fetch(`${app.origin}/api/project/connections`, { method: 'POST', headers, body: body(2, { sectionAId: 's1', xA: 6, zA: 7, sectionBId: 's3', xB: 8, zB: 9, label: 'Alternate' }) });
  assert.equal(second.status, 201);
  assert.equal((await fetch(`${app.origin}/api/project/connections`, { method: 'POST', headers, body: body(3, { sectionAId: 's1', xA: 1, zA: 1, sectionBId: 's1', xB: 2, zB: 2 }) })).status, 409);
  const edit = await fetch(`${app.origin}/api/project/connections/${firstData.id}`, { method: 'PUT', headers, body: body(3, { sectionAId: 's1', xA: 3, zA: 4, sectionBId: 's2', xB: 5, zB: 6, label: 'Edited' }) });
  assert.equal(edit.status, 200, (await edit.clone().json()).error);
  assert.equal(renders, 2, 'connection metadata edits must not render terrain');
  let manifest = await fetch(`${app.origin}/api/map/manifest?floor=f1`).then(response => response.json());
  assert.equal(manifest.connections.length, 2);
  assert.equal(manifest.connections.find(item => item.label === 'Edited').displayB.x, 45);
  assert.equal((await fetch(`${app.origin}/api/project/connections/undo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 4 }) })).status, 200);
  assert.equal((await fetch(`${app.origin}/api/project/connections/redo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 5 }) })).status, 200);
  assert.equal((await fetch(`${app.origin}/api/project/connections/${firstData.id}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: 6 }) })).status, 200);
  assert.equal((await fetch(`${app.origin}/api/project/connections/undo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 7 }) })).status, 200);
  manifest = await fetch(`${app.origin}/api/map/manifest?floor=f1`).then(response => response.json());
  assert.equal(manifest.connections.length, 2);
  assert.equal(renders, 2);
  await new Promise(resolve => app.server.close(resolve)); app = await listen();
  manifest = await fetch(`${app.origin}/api/map/manifest?floor=f1`).then(response => response.json());
  assert.equal(manifest.connections.length, 2);
  assert.equal(manifest.projectRevision, 8);
  const upper = await fetch(`${app.origin}/api/map/manifest?floor=f2`).then(response => response.json());
  assert.equal(upper.connections.length, 1);
  assert.equal(upper.connections[0].floorAId, 'f1');
  assert.deepEqual(upper.connections[0].displayB, { x: 8, z: 9 });
});
