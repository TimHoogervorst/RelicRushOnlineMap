import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/server.js';
import { openProject, seedInitialProject, readSectionBlocks } from '../src/project-store.js';
import { validateProjectBackup } from '../src/backup-service.js';

async function listen(app) {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('first-release owner journey imports, edits, publishes, and restores a private project', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'rr-release-journey-'));
  const dataDir = path.join(parent, 'empty-volume');
  const restoreDir = path.join(parent, 'restored-volume');
  const fixture = new URL('../schematics/Start 0F.litematic', import.meta.url);
  const fixtureBytes = await readFile(fixture);
  const rendered = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#485461' } }).png().toBuffer();
  const renderer = { async render({ output }) { await writeFile(output, rendered); return { width: 8, height: 8, bounds: { width: 1, depth: 1 }, renderer: { pixelSize: 8 } }; } };
  t.after(() => rm(parent, { recursive: true, force: true }));

  // This is the same idempotent seed operation the startup worker runs for a new DATA_DIR.
  await mkdir(dataDir, { recursive: true });
  let db = openProject(path.join(dataDir, 'project.sqlite'));
  const fixturePath = fileURLToPath(fixture);
  const seeded = seedInitialProject(db, fixturePath);
  assert.equal(seeded.seeded, true);
  assert.equal(seedInitialProject(db, fixturePath).seeded, false, 'rebuilds must leave existing work alone');
  db.close();
  // Small local asset metadata and blockstate fixture lets the normal block edit route validate a placement.
  const assets = path.join(dataDir, 'assets', 'minecraft');
  await mkdir(path.join(assets, 'blockstates'), { recursive: true });
  await writeFile(path.join(assets, 'asset-source.json'), JSON.stringify({ version: '26.3', worldVersion: 5023 }));
  await writeFile(path.join(assets, 'blockstates', 'stone.json'), JSON.stringify({ variants: { '': { model: 'minecraft:block/cube_all' } } }));

  const app = await listen(createApp({ dataDir, password: 'private-release-password', initializeWorker: false, renderer }));
  t.after(() => new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); }));
  assert.equal((await fetch(`${app.origin}/api/project/floors`)).status, 401);
  const login = await fetch(`${app.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify({ password: 'private-release-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin: app.origin, 'content-type': 'application/json' };
  const post = async (url, body, extra = {}) => fetch(`${app.origin}${url}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const current = async () => {
    const result = await fetch(`${app.origin}/api/project/floors`, { headers });
    assert.equal(result.status, 200);
    return result.json();
  };
  const addSchematic = async (revision, floorName, sectionName, floorId = '') => {
    const result = await fetch(`${app.origin}/api/project/import`, { method: 'POST', headers: { cookie, origin: app.origin, 'content-type': 'application/octet-stream', 'x-project-revision': String(revision), 'x-floor-id': floorId, 'x-floor-name': floorName, 'x-section-name': sectionName, 'x-source-name': 'private-source-name.litematic' }, body: fixtureBytes });
    assert.equal(result.status, 201, await result.clone().text());
    return result.json();
  };
  const baseline = await post('/api/generation/save', { expectedRevision: 1 });
  assert.equal(baseline.status, 200);
  const anonymous = await fetch(`${app.origin}/api/map/manifest`);
  assert.equal(anonymous.status, 200);
  assert.equal((await anonymous.json()).floors[0].name, 'Floor 0');
  const publicBaseline = await fetch(`${app.origin}/api/map/manifest`, { cache: 'no-store' }).then(result => result.json());
  assert.equal(publicBaseline.floors[0].sections[0].id, 'section-start-0f');
  assert.doesNotMatch(JSON.stringify(publicBaseline), /private-release-password|private-source-name|asset-source|.litematic|provenance|session/i);

  const adjacent = await addSchematic(1, 'Floor 0', 'East Wing', 'floor-0');
  const upper = await addSchematic(2, 'Upper Floor', 'Upper Hall');
  const [project] = [await current()];
  const east = adjacent.sectionId, upstairs = upper.sectionId;
  assert.ok(project.sections.some(section => section.id === east));
  assert.ok(project.floors.some(floor => floor.name === 'Upper Floor'));
  // Imported source is not retained as an upload; persisted chunks are enough to reopen it.
  assert.equal((await readdir(dataDir)).some(name => name.startsWith('schematic-upload-')), false);
  db = openProject(path.join(dataDir, 'project.sqlite'));
  assert.equal(readSectionBlocks(db, east).length, 3484);
  db.close();

  let rev = 3;
  const typeResponse = await post('/api/project/marker-types', { expectedRevision: rev++, type: { name: 'Relic Cache', color: '#aabbcc', icon: 'relic' } });
  assert.equal(typeResponse.status, 201, await typeResponse.clone().text());
  const customType = (await typeResponse.json()).type;
  const marker = async (sectionId, type, name, x, z) => {
    const response = await post('/api/project/markers', { expectedRevision: rev++, marker: { sectionId, type, name, x, z } });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).marker;
  };
  const stairsA = await marker(east, 'stairs', 'East stair', 10.5, 10.5);
  const stairsB = await marker(upstairs, 'stairs', 'Upper stair', 10.5, 10.5);
  await marker(east, customType.id, 'Hidden cache', 20.5, 20.5);
  const linked = await post('/api/project/stairs/link', { expectedRevision: rev++, firstId: stairsA.id, secondId: stairsB.id });
  assert.equal(linked.status, 200, await linked.clone().text());
  const connection = await post('/api/project/connections', { expectedRevision: rev++, connection: { sectionAId: 'section-start-0f', xA: 4, zA: 4, sectionBId: east, xB: 4, zB: 4, label: 'East passage' } });
  assert.equal(connection.status, 201, await connection.clone().text());
  const moved = await fetch(`${app.origin}/api/project/sections/${east}/layout`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: rev++, placementX: 100, placementZ: 0, labelX: 2.5, labelZ: 3.5 }) });
  assert.equal(moved.status, 200, await moved.clone().text());
  const block = await post('/api/project/blocks', { expectedRevision: rev++, sectionId: 'section-start-0f', x: 0, y: 0, z: 0, state: { id: 'minecraft:stone', properties: {} } });
  assert.equal(block.status, 201, await block.clone().text());
  const heightMove = await post('/api/project/block-moves', { expectedRevision: rev++, sectionId: 'section-start-0f', blocks: [{ x: 0, y: 0, z: 0 }], dy: 1 });
  assert.equal(heightMove.status, 200, await heightMove.clone().text());
  const heightRange = await fetch(`${app.origin}/api/project/height-range?floor=floor-0`, { headers }).then(result => result.json());
  assert.ok(heightRange.maxY >= 1, 'height-slice metadata includes moved selection blocks');
  const manifestAfterEdits = await fetch(`${app.origin}/api/map/manifest?floor=floor-0`, { cache: 'no-store' }).then(result => result.json());
  assert.equal(manifestAfterEdits.sections.find(section => section.id === east).labelX, 2.5);
  assert.equal(manifestAfterEdits.connections[0].label, 'East passage');
  assert.equal(manifestAfterEdits.markerTypes.some(item => item.id === customType.id), true);
  assert.equal(manifestAfterEdits.markers.find(item => item.id === stairsA.id).stairDestinationId, stairsB.id);
  const saveState = await fetch(`${app.origin}/api/generation/status`, { headers }).then(result => result.json());
  assert.equal(saveState.state, 'saved');
  const mapImage = await fetch(`${app.origin}/api/map/image?floor=floor-0&revision=${manifestAfterEdits.projectRevision}`);
  assert.equal(mapImage.status, 200);
  assert.deepEqual([...new Uint8Array(await mapImage.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const privateProject = await fetch(`${app.origin}/api/editor/project`, { headers }).then(result => result.text());
  assert.doesNotMatch(privateProject, /private-release-password|private-source-name|session|cookie/i);
  const archiveResponse = await fetch(`${app.origin}/api/backups/export`, { headers });
  assert.equal(archiveResponse.status, 200, await archiveResponse.clone().text());
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  assert.ok(archive.length > 0);
  const archiveFiles = validateProjectBackup(archive).files;
  assert.equal([...archiveFiles.keys()].some(name => name.endsWith('.litematic')), false);
  assert.equal([...archiveFiles.values()].some(bytes => bytes.includes(Buffer.from('private-release-password')) || bytes.includes(Buffer.from('private-source-name'))), false);
  await mkdir(restoreDir, { recursive: true });
  const restored = await listen(createApp({ dataDir: restoreDir, password: 'restore-password', initializeWorker: false, renderer }));
  t.after(() => new Promise(resolve => { restored.server.closeAllConnections(); restored.server.close(resolve); }));
  const restoreLogin = await fetch(`${restored.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: restored.origin }, body: JSON.stringify({ password: 'restore-password' }) });
  const restoreCookie = restoreLogin.headers.get('set-cookie').split(';')[0];
  const restoredResponse = await fetch(`${restored.origin}/api/backups/restore`, { method: 'POST', headers: { cookie: restoreCookie, origin: restored.origin, 'content-type': 'application/zip', 'x-confirm-restore': 'RESTORE PROJECT' }, body: archive });
  assert.equal(restoredResponse.status, 200, await restoredResponse.clone().text());
  const restoredManifest = await fetch(`${restored.origin}/api/map/manifest?floor=floor-0`, { cache: 'no-store' }).then(result => result.json());
  assert.equal(restoredManifest.projectRevision, manifestAfterEdits.projectRevision);
  assert.deepEqual(restoredManifest.connections, manifestAfterEdits.connections);
  assert.deepEqual(restoredManifest.markers.map(item => item.name).sort(), manifestAfterEdits.markers.map(item => item.name).sort());
  assert.equal((await fetch(`${restored.origin}/api/project/floors`)).status, 401);
  const publicText = JSON.stringify(restoredManifest);
  assert.doesNotMatch(publicText, /private-release-password|private-source-name|provenance|.litematic|asset-source|session/i);
});
