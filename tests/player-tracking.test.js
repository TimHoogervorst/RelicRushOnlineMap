import { createRunRecorder } from '../src/run-recorder.js';
import { activeRun } from '../src/dungeon-runs.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { openProject, encodeSectionChunks, snapshotProject, setSectionLayout, transformSection, restoreSectionTransform, captureProjectLifecycleState, restoreProjectLifecycleState, saveBlock, readSectionBlocks, projectRevision, importSchematicSection } from '../src/project-store.js';
import { createGenerationService } from '../src/generation.js';
import { saveCalibration, locatePlayers, trackingSections, overlappingRegions, createPlayerTracker } from '../src/player-tracking.js';
import { createHeadCache } from '../src/player-heads.js';
import { createApp } from '../src/server.js';
import { createProjectBackup, restoreProjectBackup } from '../src/backup-service.js';

const uuid = '8157eedab43a44c7a277c5152c9739c1';
const player = { uuid, name: 'Explorer', world: 'minecraft_overworld', x: 100.5, y: 65, z: -19.5 };
const calibration = () => ({ world: player.world, local: { x: 1, y: 0, z: 2 }, actual: { x: 100, y: 64, z: -20 } });
function seed(db) {
  db.prepare('INSERT INTO floors VALUES(?,?,?)').run('f', 'Floor 0', 0);
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('s', 'f', 'Cave', JSON.stringify({ x: 8, y: 4, z: 8 }), 0, 0, '{}');
  for (const chunk of encodeSectionChunks([{ x: 1, y: 0, z: 2, id: 'minecraft:stone' }, { x: 6, y: 2, z: 6, id: 'minecraft:stone' }])) db.prepare('INSERT INTO section_chunks VALUES(?,?,?,?,1,?)').run('s', chunk.cx, chunk.cy, chunk.cz, chunk.compressed);
}

test('vertical calibration survives layout, lifecycle and geometry edits, and rotates with its section', () => {
  const db = openProject(':memory:');
  try {
    seed(db);
    assert.throws(() => saveCalibration(db, 's', { ...calibration(), local: { x: 0, y: 0, z: 0 } }, 0), /existing block/);
    assert.throws(() => saveCalibration(db, 's', { ...calibration(), actual: { x: 1.5, y: 0, z: 0 } }, 0), /whole/);
    const saved = saveCalibration(db, 's', calibration(), 0);
    assert.deepEqual(saved.calibration.region, { min: { x: 100, y: 64, z: -24 }, max: { x: 106, y: 70, z: -19 } });
    assert.throws(() => saveCalibration(db, 's', null, 0), /another editor/);
    let located = locatePlayers([player], trackingSections(snapshotProject(db))).located[0];
    assert.deepEqual(located.local, { x: 1.5, y: 1, z: 2.5 });
    assert.deepEqual(located.display, { x: 1.5, z: 2.5 });
    setSectionLayout(db, { sectionId: 's', placementX: 40, placementZ: 20 }, 1);
    located = locatePlayers([player], trackingSections(snapshotProject(db))).located[0];
    assert.deepEqual(located.display, { x: 41.5, z: 22.5 });
    const before = captureProjectLifecycleState(db);
    saveCalibration(db, 's', null, 2);
    assert.equal(locatePlayers([player], trackingSections(snapshotProject(db))).located[0].status, 'outside');
    restoreProjectLifecycleState(db, before, 3);
    assert.deepEqual(snapshotProject(db).floors[0].sections[0].calibration, saved.calibration);
    saveBlock(db, { sectionId: 's', x: 7, y: 8, z: 7, state: { id: 'minecraft:stone', properties: {} } }, 4);
    assert.deepEqual(snapshotProject(db).floors[0].sections[0].calibration.region, saved.calibration.region);
    transformSection(db, { sectionId: 's', rotation: 90 }, 5);
    assert.equal(snapshotProject(db).floors[0].sections[0].calibration.invalidReason, null);
    assert.deepEqual(locatePlayers([player], trackingSections(snapshotProject(db))).located[0].local, { x: 5.5, y: 1, z: 1.5 });
  } finally { db.close(); }
});

test('one waypoint follows the vertical flip at sub-block precision and keeps distant blocks inside tracking bounds', () => {
  const db = openProject(':memory:');
  try {
    seed(db); saveCalibration(db, 's', calibration(), 0);
    const points = [
      { ...player, x: 100.25, z: -19.75 },
      { ...player, x: 105.5, y: 67, z: -23.5 },
      { ...player, x: 100.5, z: -19 }
    ];
    const result = locatePlayers(points, trackingSections(snapshotProject(db))).located;
    assert.deepEqual(result[0].local, { x: 1.25, y: 1, z: 2.75 });
    assert.deepEqual(result[1].local, { x: 6.5, y: 3, z: 6.5 });
    assert.equal(result[2].status, 'outside');
  } finally { db.close(); }
});

test('all quarter-turn/flip combinations preserve the waypoint and world limits through undo and redo', () => {
  for (const rotation of [0, 90, 180, 270]) for (const flipHorizontal of [false, true]) for (const flipVertical of [false, true]) {
    if (!rotation && !flipHorizontal && !flipVertical) continue;
    const db = openProject(':memory:');
    try {
      seed(db); db.prepare('UPDATE sections SET bounds_json=? WHERE id=?').run(JSON.stringify({ x: 8, y: 4, z: 12 }), 's');
      saveCalibration(db, 's', calibration(), 0);
      const before = trackingSections(snapshotProject(db))[0];
      const operation = { sectionId: 's', rotation, flipHorizontal, flipVertical };
      transformSection(db, operation, 1);
      const after = trackingSections(snapshotProject(db))[0];
      const transformedBlock = readSectionBlocks(db, 's').find(block => block.y === 0);
      const position = locatePlayers([player], [after]).located[0];
      assert.deepEqual(position.local, { x: transformedBlock.x + 0.5, y: 1, z: transformedBlock.z + 0.5 });
      assert.deepEqual(after.calibration.region, before.calibration.region);
      assert.deepEqual(after.calibration.actual, before.calibration.actual);
      restoreSectionTransform(db, operation, 'undo', 2);
      assert.deepEqual(trackingSections(snapshotProject(db))[0], before);
      restoreSectionTransform(db, operation, 'redo', 3);
      assert.deepEqual(trackingSections(snapshotProject(db))[0], after);
      saveCalibration(db, 's', null, 4);
      saveCalibration(db, 's', { ...calibration(), local: after.calibration.local }, 5);
      assert.deepEqual(locatePlayers([player], trackingSections(snapshotProject(db))).located[0].local, position.local, 'orientation persists even if the waypoint is recreated');
    } finally { db.close(); }
  }
});

test('legacy waypoints migrate once, correcting generated bounds and preserving custom world limits across reopen', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rr-tracking-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const custom of [false, true]) {
    const file = path.join(directory, `${custom}.sqlite`);
    let db = openProject(file); seed(db);
    const region = custom ? { min: { x: 90, y: 60, z: -30 }, max: { x: 110, y: 80, z: -10 } } : { min: { x: 100, y: 64, z: -20 }, max: { x: 106, y: 70, z: -15 } };
    db.prepare('UPDATE sections SET calibration_json=?').run(JSON.stringify({ ...calibration(), region, invalidReason: null }));
    db.prepare("DELETE FROM project_meta WHERE key='tracking_coordinates_v2'").run();
    db.close(); db = openProject(file);
    const migrated = trackingSections(snapshotProject(db))[0];
    assert.equal(projectRevision(db), 1);
    assert.equal(migrated.calibration.coordinateVersion, 2);
    assert.deepEqual(migrated.calibration.region, custom ? region : { min: { x: 100, y: 64, z: -24 }, max: { x: 106, y: 70, z: -19 } });
    db.close(); db = openProject(file);
    assert.equal(projectRevision(db), 1);
    assert.deepEqual(trackingSections(snapshotProject(db))[0], migrated);
    db.close();
  }
});

test('world/Y boundaries and overlap history assign a player to at most one section', () => {
  const c = { ...calibration(), region: { min: { x: 90, y: 64, z: -30 }, max: { x: 110, y: 70, z: -10 } } };
  const first = { id: 'a', name: 'A', floorId: 'f', floorName: 'F', placementX: 0, placementZ: 0, calibration: c };
  const second = { ...first, id: 'b', name: 'B', floorId: 'up', calibration: { ...c, region: { ...c.region, min: { ...c.region.min, y: 70 }, max: { ...c.region.max, y: 80 } } } };
  assert.equal(locatePlayers([{ ...player, y: 70 }], [first, second]).located[0].sectionId, 'b');
  assert.equal(locatePlayers([{ ...player, world: 'nether' }], [first, second]).located[0].status, 'outside');
  assert.equal(locatePlayers([{ ...player, x: 110 }], [first]).located[0].status, 'outside');
  const overlapping = { ...second, calibration: c };
  assert.deepEqual(overlappingRegions([first, overlapping]), [['a', 'b']]);
  assert.equal(locatePlayers([player], [first, overlapping]).located[0].status, 'ambiguous');
  assert.equal(locatePlayers([player], [first, overlapping], new Map([[uuid, 'b']])).located[0].sectionId, 'b');
  assert.equal(locatePlayers([player], [first], new Map([[uuid, 'b']])).located[0].sectionId, 'a');
});

test('stacked floors switch by Y in both directions even when their tracking boxes overlap', () => {
  const section = (id, floorId, minY, maxY) => ({ id, name: id, floorId, floorName: floorId, placementX: 0, placementZ: 0,
    calibration: { ...calibration(), region: { min: { x: 90, y: minY, z: -30 }, max: { x: 110, y: maxY, z: -10 } } } });
  const lower = section('lower', 'Floor 9', 64, 77);
  const upper = section('upper', 'Floor 2', 70, 85);
  const top = section('top', 'Floor 0', 80, 90);
  let history = new Map();
  for (const [y, expected] of [[65, 'lower'], [69.99, 'lower'], [70, 'upper'], [76, 'upper'], [80, 'top'], [79.99, 'upper'], [69.99, 'lower'], [63.99, null], [90, null]]) {
    const result = locatePlayers([{ ...player, y }], [lower, upper, top], history);
    assert.equal(result.located[0].sectionId ?? null, expected, `Y ${y}`);
    history = result.assignments;
  }
  const fresh = locatePlayers([{ ...player, y: 72 }], [upper, lower, top]).located[0];
  assert.equal(fresh.floorId, upper.floorId, 'initial placement also uses elevation, not array or floor order');
  assert.deepEqual(fresh.trackingY, { min: 70, max: 85 });
  assert.equal(locatePlayers([{ ...player, y: 72, x: 200 }], [lower, upper]).located[0].status, 'outside');
  const otherWorld = { ...upper, calibration: { ...upper.calibration, world: 'nether' } };
  assert.equal(locatePlayers([{ ...player, y: 72 }], [lower, otherWorld]).located[0].sectionId, 'lower');
});

test('Y floor selection preserves ambiguity handling within a floor and does not fill unmapped vertical gaps', () => {
  const section = (id, floorId, minY, maxY) => ({ id, name: id, floorId, placementX: 0, placementZ: 0,
    calibration: { ...calibration(), region: { min: { x: 90, y: minY, z: -30 }, max: { x: 110, y: maxY, z: -10 } } } });
  const a = section('a', 'lower', 64, 80), b = section('b', 'lower', 66, 80), c = section('c', 'upper', 75, 85);
  assert.equal(locatePlayers([{ ...player, y: 70 }], [a, b]).located[0].status, 'ambiguous');
  assert.equal(locatePlayers([{ ...player, y: 70 }], [a, b], new Map([[uuid, 'a']])).located[0].sectionId, 'a');
  assert.equal(locatePlayers([{ ...player, y: 75 }], [a, b, c], new Map([[uuid, 'a']])).located[0].sectionId, 'c');
  const gap = section('gap', 'upper', 85, 95);
  assert.equal(locatePlayers([{ ...player, y: 82 }], [a, gap], new Map([[uuid, 'a']])).located[0].status, 'outside');
});

test('shared live updates change floorId for a followed player as its Y crosses an overlapping floor boundary', async () => {
  let time = 1000, y = 69;
  const tracker = createPlayerTracker({ now: () => time, fetcher: async () => Response.json({ players: [{ ...player, y }] }) });
  const region = (minY, maxY) => ({ min: { x: 90, y: minY, z: -30 }, max: { x: 110, y: maxY, z: -10 } });
  const manifest = { floors: [
    { id: 'lower', name: 'Lower', sections: [{ id: 'a', name: 'A', placementX: 0, placementZ: 0, calibration: { ...calibration(), region: region(64, 77) } }] },
    { id: 'upper', name: 'Upper', sections: [{ id: 'b', name: 'B', placementX: 40, placementZ: 0, calibration: { ...calibration(), region: region(70, 85) } }] }
  ] };
  assert.equal((await tracker.snapshot(manifest)).players[0].floorId, 'lower');
  time += 2000; y = 70;
  const upstairs = await tracker.snapshot(manifest);
  assert.equal(upstairs.players.length, 1);
  assert.equal(upstairs.players[0].floorId, 'upper');
  assert.equal(upstairs.players[0].uuid, uuid);
  time += 2000; y = 69;
  assert.equal((await tracker.snapshot(manifest)).players[0].floorId, 'lower');
});

test('new imports record their first flip before calibration rather than applying the legacy flip twice', () => {
  const db = openProject(':memory:');
  try {
    const imported = importSchematicSection(db, { version: 7, subVersion: 1, dataVersion: 5023, regions: [{ name: 'Room', min: { x: 0, y: 0, z: 0 }, dimensions: { x: 8, y: 4, z: 12 }, blocks: [{ x: 1, y: 0, z: 2, id: 'minecraft:stone', properties: {} }, { x: 6, y: 2, z: 6, id: 'minecraft:stone', properties: {} }] }] });
    assert.deepEqual(trackingSections(snapshotProject(db))[0].trackingOrientation, [1, 0, 0, 1]);
    transformSection(db, { sectionId: imported.sectionId, flipVertical: true }, 1);
    saveCalibration(db, imported.sectionId, { ...calibration(), local: { x: 1, y: 0, z: 9 } }, 2);
    const section = trackingSections(snapshotProject(db))[0];
    assert.deepEqual(section.trackingOrientation, [1, 0, 0, -1]);
    assert.deepEqual(locatePlayers([{ ...player, x: 100.25, z: -19.75 }], [section]).located[0].local, { x: 1.25, y: 1, z: 9.75 });
  } finally { db.close(); }
});

test('old published maps correct default tracking bounds without requiring a rerender or rewriting the release', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-tracking-release-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const db = openProject(':memory:'); seed(db);
  const legacy = { ...calibration(), region: { min: { x: 100, y: 64, z: -20 }, max: { x: 106, y: 70, z: -15 } }, invalidReason: null };
  db.prepare('UPDATE sections SET calibration_json=?').run(JSON.stringify(legacy));
  const snapshot = snapshotProject(db); db.close();
  delete snapshot.floors[0].sections[0].trackingOrientation;
  const directory = path.join(dataDir, 'releases', 'revision-1'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(dataDir, 'releases', 'current.json'), JSON.stringify({ revision: 1, directory: 'revision-1' }));
  await writeFile(path.join(directory, 'project.json'), JSON.stringify(snapshot));
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ projectRevision: 1, floors: snapshot.floors.map(({ blocks, ...floor }) => floor) }));
  const service = createGenerationService({ dataDir });
  const manifest = await service.currentManifest();
  const distant = locatePlayers([{ ...player, x: 105.5, y: 67, z: -23.5 }], trackingSections(manifest)).located[0];
  assert.deepEqual(distant.local, { x: 6.5, y: 3, z: 6.5 });
  const unchanged = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(unchanged.floors[0].sections[0].calibration, legacy);
});

test('shared polling deduplicates requests and expires failures without treating them as logout', async () => {
  let time = 1000, calls = 0, fail = false, entries = [player];
  const tracker = createPlayerTracker({ now: () => time, fetcher: async () => { calls++; if (fail) throw new Error('offline'); return Response.json({ players: entries }); } });
  const db = openProject(':memory:'); seed(db); saveCalibration(db, 's', calibration(), 0);
  const manifest = snapshotProject(db); db.close();
  const responses = await Promise.all([tracker.snapshot(manifest), tracker.snapshot(manifest)]);
  assert.equal(calls, 1); assert.equal(responses[0].players.length, 1);
  time += 2000; fail = true;
  const stale = await tracker.snapshot(manifest); assert.equal(stale.stale, true); assert.equal(stale.players.length, 1);
  time = 16000;
  const expired = await tracker.snapshot(manifest); assert.equal(expired.expired, true); assert.equal(expired.players.length, 0);
  time += 2000; fail = false; entries = [];
  const empty = await tracker.snapshot(manifest); assert.equal(empty.stale, false); assert.equal(empty.players.length, 0);
  time += 30000; entries = [{ ...player, x: '100' }];
  assert.equal((await tracker.snapshot(manifest)).stale, true, 'malformed upstream records are a failed update');
});

test('head cache uses official skin textures, composites the hat, caches across restart and falls back on errors', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rr-heads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pixels = Buffer.alloc(64 * 64 * 4);
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) { const i = (y * 64 + x) * 4; pixels[i] = 255; pixels[i + 3] = 255; }
  const hatIndex = (8 * 64 + 40) * 4; pixels[hatIndex + 1] = 255; pixels[hatIndex + 3] = 255;
  const skin = await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
  let calls = 0;
  const fetcher = async url => { calls++; return String(url).startsWith('https://sessionserver.mojang.com/') ? Response.json({ properties: [{ name: 'textures', value: Buffer.from(JSON.stringify({ textures: { SKIN: { url: 'http://textures.minecraft.net/texture/abcdef' } } })).toString('base64') }] }) : new Response(skin); };
  const cache = createHeadCache(directory, fetcher);
  const [head, duplicate] = await Promise.all([cache(uuid), cache(uuid)]);
  assert.deepEqual(head, duplicate); assert.equal(calls, 2);
  const raw = await sharp(head).ensureAlpha().raw().toBuffer(); assert.deepEqual([...raw.subarray(0, 4)], [0, 255, 0, 255]);
  const restart = createHeadCache(directory, () => { throw new Error('offline'); });
  assert.deepEqual(await restart(uuid), head);
  const expired = createHeadCache(directory, () => { throw new Error('offline'); }, () => Date.now() + 172800000);
  assert.deepEqual(await expired(uuid), head);
  assert.equal(await restart('a'.repeat(32)), null);
  const many = await Promise.all(Array.from({ length: 6 }, (_, i) => cache(String(i + 1).repeat(32))));
  assert.ok(many.every(Buffer.isBuffer), 'concurrent first-time heads queue instead of all falling back');
});

test('waypoint API requires auth/origin, publishes metadata without rendering, and survives backup restore', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-tracking-api-'));
  const db = openProject(path.join(dataDir, 'project.sqlite')); seed(db); db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run(); db.close();
  let renders = 0;
  const renderer = { async render({ output }) { renders++; await writeFile(output, await sharp({ create: { width: 128, height: 128, channels: 4, background: '#123456' } }).png().toBuffer()); return { width: 128, height: 128, bounds: { width: 8, depth: 8 }, renderer: { pixelSize: 16 } }; } };
  const app = createApp({ dataDir, initializeWorker: false, password: 'secret', renderer, playerFetcher: async () => Response.json({ players: [player] }) });
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const endpoint = `${origin}/api/project/sections/s/waypoint`;
  assert.equal((await fetch(endpoint, { method: 'PUT' })).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { origin, 'content-type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0] };
  const baseline = await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(baseline.status, 200, await baseline.text());
  assert.equal((await fetch(endpoint, { method: 'PUT', headers: { ...headers, origin: 'https://other.example' }, body: '{}' })).status, 403);
  const response = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 1, calibration: calibration() }) });
  const saved = await response.json(); assert.equal(response.status, 200, JSON.stringify(saved)); assert.equal(saved.saved, true); assert.equal(renders, 2);
  assert.equal((await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, calibration: calibration() }) })).status, 409);
  const live = await fetch(`${origin}/api/players`).then(r => r.json());
  assert.equal(live.players[0].sectionId, 's'); assert.equal(live.projectRevision, 2);
  assert.equal(live.diagnostics, undefined);
  const backup = await createProjectBackup({ dataDir });
  assert.equal((await fetch(endpoint, { method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: 2 }) })).status, 200);
  await restoreProjectBackup({ dataDir, bytes: backup, confirm: 'RESTORE PROJECT' });
  const restored = openProject(path.join(dataDir, 'project.sqlite'));
  try { assert.deepEqual(snapshotProject(restored).floors[0].sections[0].calibration, saved.calibration); } finally { restored.close(); }
});

test('adaptive upstream polling shares requests and switches between dungeon, online, empty and long-idle intervals', async () => {
  let time = 0, calls = 0, entries = [];
  const manifest = { floors: [{ id: 'f', sections: [{ id: 's', placementX: 0, placementZ: 0, calibration: { ...calibration(), region: { min: { x: 90, y: 60, z: -30 }, max: { x: 110, y: 70, z: -10 } } } }] }] };
  const tracker = createPlayerTracker({ now: () => time, fetcher: async () => { calls++; return Response.json({ players: entries }); } });
  assert.equal((await tracker.snapshot(manifest)).pollIntervalMs, 30000);
  time = 29999;
  assert.equal((await tracker.snapshot(manifest)).stale, false, 'scheduled idle cache is still valid');
  assert.equal(calls, 1);
  time = 30000; entries = [{ ...player, x: 1000 }];
  assert.equal((await tracker.snapshot(manifest)).pollIntervalMs, 15000);
  time = 44999; await tracker.snapshot(manifest); assert.equal(calls, 2);
  time = 45000; entries = [player];
  const snapshots = await Promise.all([tracker.snapshot(manifest), tracker.snapshot(manifest, true), tracker.snapshot(manifest, false, true)]);
  assert.equal(calls, 3); assert.equal(snapshots[0].pollIntervalMs, 1000);
  time = 45999; await tracker.snapshot(manifest); assert.equal(calls, 3);
  time = 46000; await tracker.snapshot(manifest); assert.equal(calls, 4);
  time = 47000; entries = [];
  assert.equal((await tracker.snapshot(manifest)).pollIntervalMs, 30000);
  for (time = 77000; time < 3647000; time += 30000) await tracker.snapshot(manifest);
  time = 3647000;
  assert.equal((await tracker.snapshot(manifest)).pollIntervalMs, 60000);
  const previousCalls = calls;
  time = 3676999; assert.equal((await tracker.snapshot(manifest)).stale, false); assert.equal(calls, previousCalls);
  time = 3677000; entries = [player];
  assert.equal((await tracker.snapshot(manifest)).pollIntervalMs, 1000);
  time += 1000; entries = [];
  assert.equal((await tracker.snapshot(manifest)).pollIntervalMs, 30000, 'player presence resets the empty-server hour');
});

test('failed feeds cannot establish an hour of emptiness and ambiguous dungeon positions poll quickly', async () => {
  let time = 0, fail = false, entries = [];
  const tracker = createPlayerTracker({ now: () => time, fetcher: async () => { if (fail) throw new Error('offline'); return Response.json({ players: entries }); } });
  const manifest = { floors: [{ id: 'f', sections: ['a', 'b'].map(id => ({ id, calibration: { ...calibration(), region: { min: { x: 90, y: 60, z: -30 }, max: { x: 110, y: 70, z: -10 } } } })) }] };
  await tracker.snapshot(manifest);
  time = 30000; fail = true; assert.equal((await tracker.snapshot(manifest)).stale, true);
  time = 3600000; fail = false;
  assert.equal((await tracker.snapshot(manifest)).pollIntervalMs, 30000);
  time += 30000; entries = [player];
  const ambiguous = await tracker.snapshot(manifest, false, true);
  assert.equal(ambiguous.observations[0].status, 'ambiguous');
  assert.equal(ambiguous.pollIntervalMs, 1000);
});


test('recorder keeps the shared feed polling every second throughout invisibility and releases it on timeout', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-invisible-poll-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = path.join(dir, 'project.sqlite');
  const manifest = { floors: [{ id: 'f', sections: [{ id: 's', placementX: 0, placementZ: 0, calibration: { ...calibration(), region: { min: { x: 90, y: 60, z: -30 }, max: { x: 110, y: 70, z: -10 } } } }] }] };
  let time = 1000, calls = 0, entries = [player];
  const tracker = createPlayerTracker({ now: () => time, fetcher: async () => { calls++; return Response.json({ players: entries }); } });
  const recorder = createRunRecorder({ database, tracker, manifest: async () => manifest, now: () => time, onError: (_, e) => { throw e; } });
  t.after(() => recorder.stop());
  await recorder.tick();
  time = 2000; entries = []; await recorder.tick();
  for (time = 3000; time <= 6000; time += 1000) {
    await Promise.all([recorder.tick(), tracker.snapshot(manifest)]);
    assert.equal((await tracker.snapshot(manifest)).pollIntervalMs, 1000);
  }
  assert.equal(calls, 6, 'browser and recorder share one request each second');
  time = 7000; entries = [player]; await recorder.tick();
  const db = openProject(database);
  try { assert.equal(activeRun(db).participants[0].absentSince, null); } finally { db.close(); }
  time = 8000; entries = []; await recorder.tick();
  time = 308000; await recorder.tick();
  assert.equal((await tracker.snapshot(manifest)).pollIntervalMs, 30000);
});
