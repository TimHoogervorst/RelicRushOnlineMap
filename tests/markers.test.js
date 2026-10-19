import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { importSchematicSection, openProject, saveMarker, snapshotProject } from '../src/project-store.js';
import { decodeLitematic } from '../src/litematic.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

test('starting fixture chest markers use block-center section-local coordinates', async () => {
  const bytes = await readFile(new URL('../schematics/Start 0F.litematic', import.meta.url));
  const schematic = decodeLitematic(bytes);
  const region = schematic.regions[0];
  const chests = region.blocks.filter(block => block.id === 'minecraft:chest').map(block => [block.x + 0.5, block.z + 0.5]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(chests, [[27.5, 8.5], [61.5, 34.5]]);
  const db = openProject(':memory:');
  try {
    const imported = importSchematicSection(db, schematic, { floorName: 'Floor 0', sectionName: region.name });
    let revision = 1;
    for (const [index, [x, z]] of chests.entries()) saveMarker(db, { sectionId: imported.sectionId, type: 'chest', name: `Chest ${index + 1}`, x, z }, revision++);
    const markers = snapshotProject(db).floors[0].markers.map(marker => [marker.localX, marker.localZ]).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(markers, chests);
  } finally { db.close(); }
});

async function listen(app) {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('marker CRUD is authorized, revisioned, section-local, published without rendering, and durable', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-markers-'));
  const db = openProject(path.join(dataDir, 'project.sqlite'));
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('f1', 'Floor 1', 0);
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('s1', 'f1', 'Start', JSON.stringify({ x: 80, y: 12, z: 50 }), 0, 0, '{}');
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('s2', 'f1', 'East Wing', JSON.stringify({ x: 80, y: 12, z: 50 }), 50, 0, '{}');
  db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run();
  db.close();
  let renders = 0;
  const renderer = { async render({ output }) { renders++; await writeFile(output, png); return { width: 1280, height: 800, bounds: { width: 80, depth: 50 }, renderer: { pixelSize: 16 } }; } };
  const { server, origin } = await listen(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });

  assert.equal((await fetch(`${origin}/api/project/markers`, { method: 'POST', body: '{}' })).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin, 'content-type': 'application/json' };
  const baseline = await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(baseline.status, 200);
  assert.equal(renders, 2);
  const add = async (name, x, z) => fetch(`${origin}/api/project/markers`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1, marker: { sectionId: 's1', type: 'chest', name, description: '', x, z } }) });
  const first = await add('Chest One', 61.5, 34.5);
  assert.equal(first.status, 201, (await first.clone().json()).error);
  const firstResult = await first.json();
  assert.equal(firstResult.marker.revision, 2);
  const second = await fetch(`${origin}/api/project/markers`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2, marker: { sectionId: 's1', type: 'chest', name: 'Chest Two', description: 'Second cache', x: 27.5, z: 8.5 } }) });
  assert.equal(second.status, 201, (await second.clone().json()).error);
  const secondResult = await second.json();
  assert.equal(renders, 2, 'marker-only saves must reuse rendered terrain');
  assert.equal((await fetch(`${origin}/api/project/markers`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1, marker: { sectionId: 's1', type: 'chest', name: 'Stale', x: 0.5, z: 0.5 } }) })).status, 409);
  const invalid = await fetch(`${origin}/api/project/markers`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 3, marker: { sectionId: 's1', type: 'untrusted', name: 'Bad', x: 1, z: 1 } }) });
  assert.equal(invalid.status, 400);
  const nonFinite = await fetch(`${origin}/api/project/markers`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 3, marker: { sectionId: 's1', type: 'other', name: 'Bad position', x: 'Infinity', z: 1 } }) });
  assert.equal(nonFinite.status, 400);

  const moved = await fetch(`${origin}/api/project/markers/${firstResult.marker.id}`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 3, preserveDisplayedPosition: true, marker: { sectionId: 's2', type: 'chest', name: 'Chest One', description: '', x: 61.5, z: 34.5 } }) });
  assert.equal(moved.status, 200, (await moved.clone().json()).error);
  const movedResult = await moved.json();
  assert.equal(movedResult.marker.x, 11.5);
  assert.equal(movedResult.marker.z, 34.5);
  assert.equal(renders, 2);

  const manifest = await fetch(`${origin}/api/map/manifest?floor=f1`, { cache: 'no-store' }).then(response => response.json());
  assert.equal(manifest.projectRevision, 4);
  assert.deepEqual(manifest.markers.map(marker => [marker.name, marker.x, marker.z]).sort((a, b) => a[0].localeCompare(b[0])), [['Chest One', 61.5, 34.5], ['Chest Two', 27.5, 8.5]]);
  assert.equal((await fetch(`${origin}/api/project/markers/undo`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 4 }) })).status, 401);
  const otherLogin = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const otherHeaders = { cookie: otherLogin.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/project/markers/undo`, { method: 'POST', headers: otherHeaders, body: JSON.stringify({ expectedRevision: 4 }) })).status, 409, 'a separate login session has no undo history');
  assert.equal((await fetch(`${origin}/api/project/markers/${secondResult.marker.id}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: 4 }) })).status, 200);
  assert.equal(renders, 2);
  const undo = await fetch(`${origin}/api/project/markers/undo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 5 }) });
  assert.equal(undo.status, 200, (await undo.clone().json()).error);
  assert.equal((await fetch(`${origin}/api/map/manifest?floor=f1`).then(response => response.json())).markers.length, 2);
  const redo = await fetch(`${origin}/api/project/markers/redo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 6 }) });
  assert.equal(redo.status, 200, (await redo.clone().json()).error);
  assert.equal(renders, 2);
  await new Promise(resolve => server.close(resolve));
  const restarted = await listen(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  t.after(async () => new Promise(resolve => restarted.server.close(resolve)));
  const afterRestart = await fetch(`${restarted.origin}/api/map/manifest?floor=f1`, { cache: 'no-store' }).then(response => response.json());
  assert.equal(afterRestart.projectRevision, 7);
  assert.deepEqual(afterRestart.markers.map(marker => marker.name), ['Chest One']);
});
