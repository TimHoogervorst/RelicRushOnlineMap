import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { openProject, saveMarker, snapshotProject } from '../src/project-store.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
async function listen(app) {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('custom marker types validate bundled fields, reassign atomically, undo/redo and persist to public snapshots', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-marker-types-'));
  let db = openProject(path.join(dataDir, 'project.sqlite'));
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('f1', 'Floor 1', 0);
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,provenance_json) VALUES(?,?,?,?,?)').run('s1', 'f1', 'Start', JSON.stringify({ x: 20, y: 10, z: 20 }), '{}');
  db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run();
  db.close();
  let renders = 0;
  const renderer = { async render({ output }) { renders++; await writeFile(output, png); return { width: 20, height: 20, bounds: { width: 20, depth: 20 }, renderer: { pixelSize: 1 } }; } };
  const { server, origin } = await listen(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await fetch(`${origin}/api/project/marker-types`, { cache: 'no-store' })).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/project/marker-types`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ expectedRevision: 1, type: { name: 'Unauthenticated', color: '#000000', icon: 'other' } }) })).status, 401);
  const baseline = await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(baseline.status, 200, await baseline.clone().text());
  assert.equal(renders, 2);

  const invalid = await fetch(`${origin}/api/project/marker-types`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1, type: { name: 'Ruins', color: 'red', icon: '../secret.svg' } }) });
  assert.equal(invalid.status, 400);
  const created = await fetch(`${origin}/api/project/marker-types`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1, type: { name: 'Secret doors', color: '#abcdef', icon: 'relic' } }) });
  assert.equal(created.status, 201, (await created.clone().json()).error);
  const { type } = await created.json();
  assert.match(type.id, /^custom_[0-9a-f-]{36}$/);
  assert.equal(renders, 2, 'metadata-only type save must not rerender terrain');

  const markerResponse = await fetch(`${origin}/api/project/markers`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2, marker: { sectionId: 's1', type: type.id, name: 'Hidden door', x: 4.5, z: 7.5 } }) });
  assert.equal(markerResponse.status, 201, (await markerResponse.clone().json()).error);
  const marker = (await markerResponse.json()).marker;
  const restyled = await fetch(`${origin}/api/project/marker-types/${type.id}`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 3, type: { name: 'Secret passages', color: '#123456', icon: 'chest' } }) });
  assert.equal(restyled.status, 200, (await restyled.clone().json()).error);
  const restyledManifest = await fetch(`${origin}/api/map/manifest?floor=f1`, { cache: 'no-store' }).then(response => response.json());
  assert.equal(restyledManifest.markers[0].type, type.id, 'restyling does not change marker membership');
  assert.equal(restyledManifest.markerTypes.find(item => item.id === type.id).color, '#123456');
  const noReplacement = await fetch(`${origin}/api/project/marker-types/${type.id}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: 4 }) });
  assert.equal(noReplacement.status, 400);
  const badReplacement = await fetch(`${origin}/api/project/marker-types/${type.id}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: 4, replacementType: 'custom_missing' }) });
  assert.equal(badReplacement.status, 400);
  const builtInChange = await fetch(`${origin}/api/project/marker-types/chest`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 4, type: { name: 'Nope', color: '#ffffff', icon: 'other' } }) });
  assert.equal(builtInChange.status, 409);

  const deleted = await fetch(`${origin}/api/project/marker-types/${type.id}`, { method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: 4, replacementType: 'stairs' }) });
  assert.equal(deleted.status, 200, (await deleted.clone().json()).error);
  db = openProject(path.join(dataDir, 'project.sqlite'));
  let savedMarker = db.prepare('SELECT type,stair_destination_id FROM markers WHERE id=?').get(marker.id);
  assert.deepEqual(savedMarker, { type: 'stairs', stair_destination_id: null });
  db.close();
  const undo = await fetch(`${origin}/api/project/marker-types/undo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 5 }) });
  assert.equal(undo.status, 200, (await undo.clone().json()).error);
  db = openProject(path.join(dataDir, 'project.sqlite'));
  savedMarker = db.prepare('SELECT type,stair_destination_id FROM markers WHERE id=?').get(marker.id);
  assert.deepEqual(savedMarker, { type: type.id, stair_destination_id: null });
  db.close();
  const redo = await fetch(`${origin}/api/project/marker-types/redo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 6 }) });
  assert.equal(redo.status, 200, (await redo.clone().json()).error);
  const publicManifest = await fetch(`${origin}/api/map/manifest?floor=f1`, { cache: 'no-store' }).then(response => response.json());
  assert.equal(publicManifest.markers[0].type, 'stairs');
  assert.equal(publicManifest.markerTypes.some(item => item.id === type.id), false);
  assert.equal(renders, 2);

  // Custom type definitions are part of the durable project snapshot and public release.
  const renamed = await fetch(`${origin}/api/project/marker-types`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 7, type: { name: 'Relics II', color: '#aabbcc', icon: 'other' } }) });
  assert.equal(renamed.status, 201, (await renamed.clone().json()).error);
  const secondType = (await renamed.json()).type;
  await new Promise(resolve => server.close(resolve));
  const restarted = await listen(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  t.after(async () => new Promise(resolve => restarted.server.close(resolve)));
  const visitorData = await fetch(`${restarted.origin}/api/map/manifest?floor=f1`, { cache: 'no-store' }).then(response => response.json());
  assert.equal(visitorData.markerTypes.find(item => item.id === secondType.id).color, '#aabbcc');
  assert.equal(visitorData.projectRevision, 8);
  db = openProject(path.join(dataDir, 'project.sqlite'));
  assert.deepEqual(snapshotProject(db).floors[0].markers.map(item => item.type), ['stairs']);
  db.close();
});

test('metadata save failure preserves the type for a full save retry', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-marker-type-retry-'));
  const db = openProject(path.join(dataDir, 'project.sqlite'));
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('f1', 'Floor 1', 0);
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,provenance_json) VALUES(?,?,?,?,?)').run('s1', 'f1', 'Start', JSON.stringify({ x: 1, y: 1, z: 1 }), '{}');
  db.close();
  let renders = 0;
  const renderer = { async render({ output }) { renders++; await writeFile(output, png); return { width: 1, height: 1, bounds: { width: 1, depth: 1 } }; } };
  const { server, origin } = await listen(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  const result = await fetch(`${origin}/api/project/marker-types`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, type: { name: 'Artifacts', color: '#987654', icon: 'relic' } }) });
  assert.equal(result.status, 202);
  assert.equal((await result.json()).saved, false);
  assert.equal(renders, 0, 'the failed metadata-only attempt still avoids terrain rendering');
  const save = await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(save.status, 200, await save.clone().text());
  assert.equal(renders, 2);
  const manifest = await fetch(`${origin}/api/map/manifest?floor=f1`, { cache: 'no-store' }).then(response => response.json());
  assert.equal(manifest.markerTypes.find(type => type.name === 'Artifacts').icon, 'relic');
});
