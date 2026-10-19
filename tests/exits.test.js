import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { openProject, saveExit, linkExits, removeExit, snapshotProject, transformSection, captureProjectLifecycleState, restoreProjectLifecycleState } from '../src/project-store.js';

function seed(db) {
  for (const [id, order] of [['f1', 0], ['f2', 1]]) db.prepare('INSERT INTO floors VALUES(?,?,?)').run(id, id, order);
  for (const [id, floor, x] of [['a', 'f1', -20], ['b', 'f1', 40], ['c', 'f2', -100]]) {
    db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,0,?)').run(id, floor, id, JSON.stringify({ x: 10, y: 1, z: 20 }), x, '{}');
  }
}

test('exits retain local coordinates and names through linking, rotation, unlink and lifecycle restoration', () => {
  const db = openProject(':memory:'); seed(db);
  try {
    const a = saveExit(db, { sectionId: 'a', x: 1.5, z: 2.5, name: 'Cave mouth' }, 0);
    const b = saveExit(db, { sectionId: 'b', x: 3.5, z: 4.5, name: 'Passage' }, 1);
    const c = saveExit(db, { sectionId: 'c', x: 5.5, z: 6.5, name: 'Upper stairs' }, 2);
    assert.equal(snapshotProject(db).floors[0].exits.length, 2);
    assert.throws(() => linkExits(db, a.id, a.id, 3), /different exits/);
    linkExits(db, a.id, b.id, 3);
    assert.throws(() => linkExits(db, a.id, c.id, 4), /Unlink/);
    assert.equal(snapshotProject(db).floors[0].connections.length, 1);
    removeExit(db, a.id, 4, true);
    linkExits(db, a.id, c.id, 5);
    saveExit(db, { name: 'Upper entrance' }, 6, c.id);
    let snapshot = snapshotProject(db);
    assert.equal(snapshot.floors[0].exits.find(e => e.id === a.id).destinationName, 'Upper entrance');
    assert.equal(snapshot.floors[1].exits[0].destinationFloorId, 'f1');
    assert.equal(snapshot.floors[1].connections[0].displayA, null);
    transformSection(db, { sectionId: 'a', rotation: 90 }, 7);
    snapshot = snapshotProject(db);
    const exit = snapshot.floors[0].exits.find(e => e.id === a.id);
    const connection = snapshot.floors[0].connections[0];
    assert.equal(exit.localX, connection.xA);
    assert.equal(exit.localZ, connection.zA);
    assert.notEqual(exit.localX, 1.5);
    const state = captureProjectLifecycleState(db);
    removeExit(db, a.id, 8);
    assert.equal(snapshotProject(db).floors[1].exits[0].destinationId, null);
    restoreProjectLifecycleState(db, state, 9);
    assert.equal(snapshotProject(db).floors[1].exits[0].destinationId, a.id);
  } finally { db.close(); }
});

test('existing connections migrate to named exits once and survive reopening', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-exit-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'project.sqlite');
  let db = openProject(file); seed(db);
  db.prepare("INSERT INTO section_connections(id,section_a_id,x_a,z_a,section_b_id,x_b,z_b,label) VALUES('old','a',1.5,2.5,'c',3.5,4.5,'Stairs')").run();
  db.close(); db = openProject(file);
  const initial = snapshotProject(db).floors.flatMap(f => f.exits);
  assert.equal(initial.length, 2);
  assert.equal(initial[0].name, 'Stairs A');
  assert.equal(initial[1].destinationId, initial[0].id);
  db.close(); db = openProject(file);
  assert.deepEqual(snapshotProject(db).floors.flatMap(f => f.exits), initial);
  db.close();
});

test('exit API requires auth and publishes standalone exits and reciprocal destinations without rerendering', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-exit-api-'));
  const db = openProject(path.join(dataDir, 'project.sqlite')); seed(db); db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run(); db.close();
  let renders = 0;
  const renderer = { async render({ output }) { renders++; await writeFile(output, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1])); return { width: 1, height: 1 }; } };
  const server = createServer(createApp({ dataDir, password: 'fixture', initializeWorker: false, renderer }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/api/project/exits`, { method: 'POST', body: '{}' })).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixture' }) });
  const headers = { origin, 'content-type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0] };
  const mutate = async (url, body, method = 'POST') => {
    const response = await fetch(origin + url, { method, headers, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  await mutate('/api/generation/save', { expectedRevision: 1 });
  const a = await mutate('/api/project/exits', { expectedRevision: 1, exit: { sectionId: 'a', x: 1.5, z: 2.5, name: 'Lower' } });
  const b = await mutate('/api/project/exits', { expectedRevision: 2, exit: { sectionId: 'c', x: 3.5, z: 4.5, name: 'Upper' } });
  await mutate(`/api/project/exits/${a.id}/link`, { expectedRevision: 3, destinationId: b.id });
  let map = await fetch(`${origin}/api/map/manifest`).then(r => r.json());
  assert.equal(map.floors[0].exits[0].destinationId, b.id);
  assert.equal(map.floors[1].exits[0].destinationId, a.id);
  await mutate(`/api/project/exits/${a.id}/unlink`, { expectedRevision: 4 });
  map = await fetch(`${origin}/api/map/manifest`).then(r => r.json());
  assert.equal(map.floors[0].exits[0].destinationId, null);
  assert.equal(map.floors[1].exits.length, 1);
  assert.equal(renders, 2);
});
