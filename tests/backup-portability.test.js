import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { openProject, encodeSectionChunks, snapshotProject, transformSection } from '../src/project-store.js';
import { createGenerationService } from '../src/generation.js';
import { recordObservation, saveEndpoint, runDetail } from '../src/dungeon-runs.js';
import { validateProjectBackup } from '../src/backup-service.js';
import { createApp } from '../src/server.js';

async function serve(t, dataDir, renderer) {
  const app = createApp({ dataDir, initializeWorker: false, renderer });
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'relic-local' }) });
  const headers = { origin, cookie: response.headers.get('set-cookie').split(';')[0] };
  return { origin, headers, request: (route, options = {}) => fetch(origin + route, { ...options, headers: { ...headers, ...options.headers } }) };
}
function databaseContents(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

test('HTTP export restores all project tables, rotated terrain and replay data, then permits saves after replacing a newer project', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rr-portability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'fresh');
  await mkdir(source); await mkdir(target);
  const db = openProject(path.join(source, 'project.sqlite'));
  db.exec(`INSERT OR REPLACE INTO project_meta(key,value) VALUES('revision','1');
    INSERT INTO floors VALUES('f','Dungeon',0);
    INSERT INTO sections(id,floor_id,name,bounds_json,provenance_json) VALUES('s','f','Entrance','{"x":3,"y":2,"z":2}','{}');
    INSERT INTO custom_marker_types VALUES('treasure','Treasure','#ffaa00','minecraft:diamond');
    INSERT INTO markers(id,section_id,type,name,x,z) VALUES('m','s','treasure','First chest',0.5,0.5);
    INSERT INTO section_render_settings VALUES('s','{"pixelSize":16}');
    INSERT INTO project_meta(key,value) VALUES('tracking_settings','{"horizontal":5,"vertical":2}');`);
  const calibration = { coordinateVersion: 2, region: { min: { x: 90, y: 50, z: 190 }, max: { x: 110, y: 70, z: 210 } }, world: 'world', local: { x: 0, y: 0, z: 0 }, actual: { x: 100, y: 60, z: 200 }, yMin: 0, yMax: 2 };
  db.prepare('UPDATE sections SET calibration_json=?,tracker_points_json=? WHERE id=?').run(JSON.stringify(calibration), JSON.stringify([{ id: 'tracker', name: 'Entrance hint', local: { x: 1, y: 1, z: 1 } }]), 's');
  for (const c of encodeSectionChunks([{ x: 0, y: 0, z: 0, id: 'minecraft:stone', properties: {} }, { x: 2, y: 1, z: 1, id: 'minecraft:oak_stairs', properties: { facing: 'east' } }])) db.prepare('INSERT INTO section_chunks VALUES(?,?,?,?,1,?)').run('s', c.cx, c.cy, c.cz, c.compressed);
  transformSection(db, { sectionId: 's', rotation: 90, flipHorizontal: true }, 1);
  const assetsDir = path.join(source, 'assets', 'minecraft'); await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, 'asset-source.json'), JSON.stringify({ minecraftVersion: '26.3', itemTextures: 1, itemDefinitions: 1 }));
  const png = await sharp({ create: { width: 32, height: 48, channels: 4, background: '#445566' } }).png().toBuffer();
  const renderer = { async render({ output }) { await writeFile(output, png); return { width: 32, height: 48, bounds: { width: 2, depth: 3 }, renderer: { pixelSize: 16 } }; } };
  const generation = createGenerationService({ dataDir: source, assetsDir, renderer }); await generation.save(snapshotProject(db));
  const manifest = await generation.currentManifest();
  saveEndpoint(db, { sectionId: 's', local: { x: 0.5, y: 1, z: 0.5 }, diameter: 8 }, manifest);
  const player = { uuid: 'a'.repeat(32), name: 'Explorer', status: 'mapped', world: 'world', sectionId: 's', floorId: 'f', x: 100, y: 61, z: 200, local: { x: 0.5, y: 1, z: 0.5 } };
  const observe = (time, observations) => recordObservation(db, { updatedAt: time, stale: false, observations }, manifest, time);
  const run = observe(1000, [player]); observe(3000, [{ ...player, x: 101 }]); observe(5000, []); observe(21000, []);
  const expectedRun = runDetail(db, run.id), expectedTables = databaseContents(db); db.close();
  assert.ok(expectedRun.samples.length >= 2);
  await mkdir(path.join(source, 'releases', 'revision-1'));
  await writeFile(path.join(source, 'releases', 'revision-1', 'old-map.png'), Buffer.alloc(4096, 7));
  const from = await serve(t, source, renderer), into = await serve(t, target, renderer);
  const exported = await from.request('/api/backups/export'); assert.equal(exported.status, 200, await exported.clone().text());
  const archive = Buffer.from(await exported.arrayBuffer());
  const checked = validateProjectBackup(archive);
  assert.equal([...checked.files.keys()].some(name => name.startsWith('releases/revision-1/')), false);
  const sizes = await (await from.request('/api/backups/size')).json();
  assert.equal(sizes.excludedReleaseBytes, 4096);
  assert.equal(sizes.totalBytes, [...checked.files].filter(([name]) => name !== 'manifest.json').reduce((sum, [, bytes]) => sum + bytes.length, 0));
  assert.equal((await readFile(path.join(source, 'releases', 'revision-1', 'old-map.png'))).length, 4096, 'Old renders remain on the source');
  const restore = () => into.request('/api/backups/restore', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-confirm-restore': 'RESTORE PROJECT' }, body: archive });
  let response = await restore(); assert.equal(response.status, 200, await response.text());
  const restored = openProject(path.join(target, 'project.sqlite')); assert.deepEqual(databaseContents(restored), expectedTables); restored.close();
  assert.deepEqual(await (await into.request(`/api/runs/${run.id}`)).json(), await (await from.request(`/api/runs/${run.id}`)).json());
  assert.deepEqual(await (await into.request('/api/map/manifest')).json(), await (await from.request('/api/map/manifest')).json());
  for (const file of ['manifest.json', 'project.json', 'f.png', 'f-height-grid.json']) assert.deepEqual(await readFile(path.join(target, 'releases', 'revision-2', file)), await readFile(path.join(source, 'releases', 'revision-2', file)));
  // Exercise the same startup worker as a fresh container, with no source JAR or schematic.
  const startup = new Worker(new URL('../src/seed-worker.js', import.meta.url), { execArgv: ['--experimental-strip-types'], workerData: { dataDir: target, assetsDir: path.join(target, 'assets', 'minecraft'), fixturePath: path.join(root, 'missing.litematic'), clientJar: null } });
  let state;
  await new Promise((resolve, reject) => {
    startup.on('message', value => { state = value; }); startup.on('error', reject);
    startup.on('exit', code => code ? reject(new Error(`Startup exited ${code}`)) : resolve());
  });
  assert.equal(state.ready, true, JSON.stringify(state)); assert.equal(state.rendered, true);
  for (const file of ['manifest.json', 'f.png', 'f-height-grid.json']) assert.deepEqual(await readFile(path.join(target, 'releases', 'revision-2', file)), await readFile(path.join(source, 'releases', 'revision-2', file)));
  const changed = openProject(path.join(target, 'project.sqlite')); changed.prepare("UPDATE project_meta SET value='10' WHERE key='revision'").run(); changed.close();
  const save = revision => into.request('/api/generation/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision }) });
  response = await save(10); assert.equal(response.status, 200, await response.text());
  response = await restore(); assert.equal(response.status, 200, await response.text());
  response = await save(2); assert.equal(response.status, 200, 'Restored project must be editable: ' + await response.text());
});
