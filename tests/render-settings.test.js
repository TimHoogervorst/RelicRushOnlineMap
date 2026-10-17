import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { openProject, projectRevision, readSectionBlocks, saveSectionRenderSettings, snapshotProject } from '../src/project-store.js';
import { createGenerationService } from '../src/generation.js';
import { renderOrthographic } from '../src/renderer.js';
import sharp from 'sharp';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(value), local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + filename.length); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); filename.copy(central, 46);
    centrals.push(central); offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function createProject(db) {
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('f1', 'Floor 1', 0);
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('s1', 'f1', 'Room', JSON.stringify({ x: 3, y: 4, z: 3 }), 0, 0, '{}');
  db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run();
  return db;
}

test('section cutaways/exclusions are validated and persisted without changing stored geometry', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-render-settings-db-')), file = path.join(dir, 'project.sqlite');
  let db = createProject(openProject(file));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const initialBlocks = [{ x: 0, y: 0, z: 0, id: 'minecraft:stone', properties: {} }, { x: 1, y: 2, z: 1, id: 'minecraft:torch', properties: {} }];
  const { encodeSectionChunks } = await import('../src/project-store.js');
  for (const chunk of encodeSectionChunks(initialBlocks)) db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)').run('s1', chunk.cx, chunk.cy, chunk.cz, chunk.compressed);
  const before = readSectionBlocks(db, 's1');
  const settings = { cutaways: [{ x: 0, y: 0, z: 0, width: 1, height: 1, depth: 1 }], excludedBlocks: ['minecraft:torch'], pixelSize: 20, heightShadePerBlock: 0.025 };
  assert.equal(saveSectionRenderSettings(db, 's1', settings, 1).revision, 2);
  const snapshot = snapshotProject(db);
  assert.deepEqual(snapshot.floors[0].sections[0].renderSettings, settings);
  assert.deepEqual(readSectionBlocks(db, 's1'), before);
  assert.throws(() => saveSectionRenderSettings(db, 's1', { ...settings, pixelSize: 100 }, 2), /4 to 32/);
  assert.throws(() => saveSectionRenderSettings(db, 's1', { ...settings, cutaways: [{ x: 0, y: 0, z: 0, width: 0, height: 2, depth: 2 }] }, 2), /positive bounded/);
  assert.equal(projectRevision(db), 2);
  db.close(); db = openProject(file);
  assert.deepEqual(snapshotProject(db).floors[0].sections[0].renderSettings, settings);
});

test('render generation applies cutaway and exclusion settings to an isolated copy and honors scale controls', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-render-settings-gen-'));
  const captured = [];
  const renderer = { async render({ schematic, output, pixelSize, heightShadePerBlock }) { captured.push({ schematic: structuredClone(schematic), pixelSize, heightShadePerBlock }); await writeFile(output, png); return { width: 1, height: 1 }; } };
  const generation = createGenerationService({ dataDir, assetsDir: path.join(dataDir, 'assets'), renderer });
  const blocks = [{ x: 0, y: 0, z: 0, localX: 0, localY: 0, localZ: 0, sectionId: 's1', id: 'minecraft:stone' }, { x: 1, y: 1, z: 0, localX: 1, localY: 1, localZ: 0, sectionId: 's1', id: 'minecraft:torch' }];
  const snapshot = { revision: 1, floors: [{ id: 'f1', name: 'Floor', dimensions: { x: 2, y: 2, z: 1 }, blocks, renderOptions: { pixelSize: 24, heightShadePerBlock: 0.01 }, sections: [{ id: 's1', renderSettings: { cutaways: [{ x: 0, y: 0, z: 0, width: 1, height: 1, depth: 1 }], excludedBlocks: ['minecraft:torch'] } }] }] };
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await generation.save(snapshot);
  assert.deepEqual(captured[0].schematic.blocks, []);
  assert.equal(captured[0].pixelSize, 24); assert.equal(captured[0].heightShadePerBlock, 0.01);
  assert.equal(snapshot.floors[0].blocks.length, 2, 'the source geometry snapshot is immutable');
  assert.deepEqual(blocks[0], { x: 0, y: 0, z: 0, localX: 0, localY: 0, localZ: 0, sectionId: 's1', id: 'minecraft:stone' });
});

test('rasterizer layers resource pack textures and rejects unsafe dimensions and render controls', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-render-pack-layer-')), vanilla = path.join(dir, 'vanilla'), pack = path.join(dir, 'pack');
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const root of [vanilla, pack]) {
    await mkdir(path.join(root, 'blockstates'), { recursive: true }); await mkdir(path.join(root, 'models', 'block'), { recursive: true }); await mkdir(path.join(root, 'textures', 'block'), { recursive: true });
    await writeFile(path.join(root, 'blockstates', 'stone.json'), JSON.stringify({ variants: { '': { model: 'minecraft:block/stone' } } }));
    await writeFile(path.join(root, 'models', 'block', 'stone.json'), JSON.stringify({ textures: { all: 'minecraft:block/stone' }, elements: [{ from: [0,0,0], to: [16,16,16], faces: { up: { texture: '#all', uv: [0,0,16,16] } } }] }));
  }
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 240, g: 20, b: 20, alpha: 1 } } }).png().toFile(path.join(vanilla, 'textures', 'block', 'stone.png'));
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 20, g: 240, b: 20, alpha: 1 } } }).png().toFile(path.join(pack, 'textures', 'block', 'stone.png'));
  const schematic = { dimensions: { x: 1, y: 1, z: 1 }, blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:stone', properties: {} }] };
  await renderOrthographic(schematic, { assets: vanilla, output: path.join(dir, 'vanilla.png'), pixelSize: 8 });
  await renderOrthographic(schematic, { assets: vanilla, assetOverrides: [pack], output: path.join(dir, 'packed.png'), pixelSize: 8 });
  const pixel = async file => { const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true }); return [...data.subarray((4 * info.width + 4) * 4, (4 * info.width + 4) * 4 + 3)]; };
  assert.deepEqual(await pixel(path.join(dir, 'vanilla.png')), [240,20,20]);
  assert.deepEqual(await pixel(path.join(dir, 'packed.png')), [20,240,20]);
  await assert.rejects(renderOrthographic(schematic, { assets: vanilla, output: path.join(dir, 'invalid.png'), pixelSize: 33 }), /4 to 32/);
  await assert.rejects(renderOrthographic({ dimensions: { x: 1000, y: 1, z: 1000 }, blocks: [] }, { assets: vanilla, output: path.join(dir, 'large.png'), pixelSize: 32 }), /8,000,000 pixel safety limit/);
});

test('render settings API requires editor auth, saves, undoes/redoes, and survives server restart', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-render-settings-api-'));
  const db = createProject(openProject(path.join(dataDir, 'project.sqlite')));
  db.close();
  const renderer = { async render({ output }) { await writeFile(output, png); return { width: 1, height: 1 }; } };
  async function listen() { const server = createServer(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer })); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return { server, origin: `http://127.0.0.1:${server.address().port}` }; }
  let app = await listen();
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await fetch(`${app.origin}/api/project/sections/s1/render-settings`, { method: 'PUT', body: '{}' })).status, 401);
  const login = await fetch(`${app.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin: app.origin, 'content-type': 'application/json' };
  const settings = { cutaways: [{ x: 0, y: 0, z: 0, width: 1, height: 2, depth: 1 }], excludedBlocks: ['minecraft:stone'], pixelSize: 18, heightShadePerBlock: 0.02 };
  const save = await fetch(`${app.origin}/api/project/sections/s1/render-settings`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 1, settings }) });
  assert.equal(save.status, 200, (await save.clone().json()).error);
  assert.equal((await save.json()).saved, true);
  assert.equal((await fetch(`${app.origin}/api/project/render-settings/undo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2 }) })).status, 200);
  assert.equal((await fetch(`${app.origin}/api/project/render-settings/redo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 3 }) })).status, 200);
  await new Promise(resolve => app.server.close(resolve)); app = await listen();
  const loaded = openProject(path.join(dataDir, 'project.sqlite'));
  try { assert.deepEqual(snapshotProject(loaded).floors[0].sections[0].renderSettings, settings); } finally { loaded.close(); }
  const visitor = await fetch(`${app.origin}/api/map/manifest`); assert.equal(visitor.status, 200);
  assert.deepEqual((await visitor.json()).floors[0].sections[0].renderSettings, settings);
});

test('resource pack upload requires authentication, advances rendered output and preserves metadata across restart', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-pack-api-'));
  const db = createProject(openProject(path.join(dataDir, 'project.sqlite'))); db.close();
  const renderer = { async render({ output }) { await writeFile(output, png); return { width: 1, height: 1 }; } };
  async function listen() { const server = createServer(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer })); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return { server, origin: `http://127.0.0.1:${server.address().port}` }; }
  let app = await listen();
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const bytes = zip([['pack.mcmeta', JSON.stringify({ pack: { pack_format: 34, description: 'Dungeon override' } })], ['assets/minecraft/textures/block/stone.png', 'test-png']]);
  assert.equal((await fetch(`${app.origin}/api/assets/resource-pack`, { method: 'POST', body: bytes })).status, 401);
  const login = await fetch(`${app.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin: app.origin, 'content-type': 'application/octet-stream' };
  const uploaded = await fetch(`${app.origin}/api/assets/resource-pack`, { method: 'POST', headers, body: bytes });
  const result = await uploaded.json(); assert.equal(uploaded.status, 200, result.error); assert.equal(result.saved, true); assert.equal(result.resourcePack.packFormat, 34);
  const publicManifest = await fetch(`${app.origin}/api/map/manifest`).then(response => response.json());
  assert.equal(publicManifest.projectRevision, 2); assert.equal(publicManifest.resourcePack.sha256, result.resourcePack.sha256);
  await new Promise(resolve => app.server.close(resolve)); app = await listen();
  const relogin = await fetch(`${app.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify({ password: 'secret' }) });
  const privateMetadata = await fetch(`${app.origin}/api/editor/project`, { headers: { cookie: relogin.headers.get('set-cookie').split(';')[0] } }).then(response => response.json());
  assert.equal(privateMetadata.resourcePack.sha256, result.resourcePack.sha256);
  assert.equal(await readFile(path.join(dataDir, 'assets', 'resource-pack', 'textures', 'block', 'stone.png'), 'utf8'), 'test-png');
});
