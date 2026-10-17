import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { encodeSectionChunks, importSchematicSection, openProject, readSectionBlock, readSectionBlocks, saveBlock, snapshotProject } from '../src/project-store.js';
import { decodeLitematic } from '../src/litematic.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

function sectionDb(path = ':memory:') {
  const db = openProject(path);
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('floor-1', 'Floor 1', 0);
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('section-1', 'floor-1', 'Room', JSON.stringify({ x: 4, y: 4, z: 4 }), 0, 0, '{}');
  const chunks = encodeSectionChunks([{ x: 0, y: 0, z: 0, id: 'minecraft:chest', properties: { facing: 'north', type: 'single', waterlogged: 'false' } }], [{ x: 0, y: 0, z: 0, id: 'minecraft:chest', Items: [{ Slot: 0 }] }]);
  for (const chunk of chunks) db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)').run('section-1', chunk.cx, chunk.cy, chunk.cz, chunk.compressed);
  db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run();
  return db;
}

test('palette chunks round-trip negative coordinates and block entities; expansion keeps section-local origin', () => {
  const db = sectionDb();
  try {
    const placed = saveBlock(db, { sectionId: 'section-1', x: -17, y: -1, z: 19, state: { id: 'minecraft:stone', properties: {} } }, 1);
    assert.equal(placed.revision, 2);
    assert.deepEqual(readSectionBlock(db, 'section-1', -17, -1, 19), { x: -17, y: -1, z: 19, id: 'minecraft:stone', properties: {}, blockEntities: [] });
    assert.equal(readSectionBlock(db, 'section-1', 0, 0, 0).blockEntities[0].Items[0].Slot, 0);
    const before = snapshotProject(db).floors[0];
    assert.deepEqual(before.blocks.find(block => block.id === 'minecraft:stone') && [before.blocks.find(block => block.id === 'minecraft:stone').x, before.blocks.find(block => block.id === 'minecraft:stone').z], [0, 19]);
    assert.equal(db.prepare('SELECT placement_x FROM sections WHERE id=?').get('section-1').placement_x, 0);
  } finally { db.close(); }
});

test('block entity data follows retained block identity and is cleared on replacement', () => {
  const db = sectionDb();
  try {
    saveBlock(db, { sectionId: 'section-1', x: 0, y: 0, z: 0, state: { id: 'minecraft:chest', properties: { facing: 'south', type: 'single', waterlogged: 'false' } } }, 1);
    assert.equal(readSectionBlock(db, 'section-1', 0, 0, 0).blockEntities[0].Items[0].Slot, 0);
    saveBlock(db, { sectionId: 'section-1', x: 0, y: 0, z: 0, state: { id: 'minecraft:stone', properties: {} } }, 2);
    assert.deepEqual(readSectionBlock(db, 'section-1', 0, 0, 0).blockEntities, []);
  } finally { db.close(); }
});

test('real starting fixture supports stair/slab refinement and decoration removal without changing its source', async () => {
  const fixture = new URL('../schematics/Start 0F.litematic', import.meta.url);
  const bytes = await readFile(fixture), schematic = decodeLitematic(bytes), region = schematic.regions[0];
  const db = sectionDb();
  try {
    // Replace the synthetic section geometry with this actual imported fixture.
    db.prepare('DELETE FROM sections WHERE id=?').run('section-1');
    const imported = importSchematicSection(db, schematic, { sectionName: region.name });
    const slab = region.blocks.find(block => block.id.endsWith('_slab'));
    const decoration = region.blocks.find(block => /short_grass|tall_grass|ladder|glow_lichen/.test(block.id));
    assert.ok(slab && decoration, 'fixture has real slabs and decorations');
    const slabState = { id: slab.id, properties: { ...slab.properties, type: slab.properties.type === 'top' ? 'bottom' : 'top' } };
    const revision = 2;
    saveBlock(db, { sectionId: imported.sectionId, x: slab.x, y: slab.y, z: slab.z, state: slabState }, revision);
    saveBlock(db, { sectionId: imported.sectionId, x: decoration.x, y: decoration.y, z: decoration.z, state: null }, revision + 1);
    assert.deepEqual(readSectionBlock(db, imported.sectionId, slab.x, slab.y, slab.z).properties, slabState.properties);
    assert.equal(readSectionBlock(db, imported.sectionId, decoration.x, decoration.y, decoration.z), null);
    assert.equal(db.prepare('SELECT placement_x FROM sections WHERE id=?').get(imported.sectionId).placement_x, 0);
    assert.deepEqual(await readFile(fixture), bytes, 'editing copied palette chunks does not rewrite or depend on the input file');
  } finally { db.close(); }
});

async function listen(app) {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('authenticated block edits validate palette states, regenerate, and undo/redo as new saved revisions', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-blocks-'));
  await mkdir(path.join(dataDir, 'assets', 'minecraft', 'blockstates'), { recursive: true });
  await writeFile(path.join(dataDir, 'assets', 'minecraft', 'blockstates', 'chest.json'), JSON.stringify({ variants: { 'facing=north,type=single,waterlogged=false': { model: 'minecraft:block/chest' } } }));
  await writeFile(path.join(dataDir, 'assets', 'minecraft', 'blockstates', 'oak_stairs.json'), JSON.stringify({ variants: { 'facing=north,half=bottom,shape=straight,waterlogged=false': {}, 'facing=south,half=top,shape=straight,waterlogged=false': {} } }));
  const db = sectionDb(path.join(dataDir, 'project.sqlite')); db.close();
  let renders = 0;
  const renderer = { async render({ output }) { renders++; await writeFile(output, png); return { width: 64, height: 64, bounds: { width: 4, depth: 4 }, renderer: { pixelSize: 16 } }; } };
  const { server, origin } = await listen(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await fetch(`${origin}/api/project/blocks`, { method: 'POST', body: '{}' })).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/project/block-palette`, { headers }).then(response => response.json())).blocks.length, 2);
  const baseline = await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(baseline.status, 200); assert.equal(renders, 1);
  const add = await fetch(`${origin}/api/project/blocks`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1, sectionId: 'section-1', x: -1, y: 1, z: 5, state: { id: 'minecraft:oak_stairs', properties: { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' } } }) });
  assert.equal(add.status, 201, (await add.clone().json()).error); assert.equal((await add.json()).revision, 2); assert.equal(renders, 2);
  const invalid = await fetch(`${origin}/api/project/blocks`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2, sectionId: 'section-1', x: -1, y: 1, z: 5, state: { id: 'minecraft:oak_stairs', properties: { facing: 'sideways' } } }) });
  assert.equal(invalid.status, 400);
  const invalidCombo = await fetch(`${origin}/api/project/blocks`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2, sectionId: 'section-1', x: -1, y: 1, z: 5, state: { id: 'minecraft:oak_stairs', properties: { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' } } }) });
  assert.equal(invalidCombo.status, 400, 'each individually allowed value must still form a valid blockstate variant');
  const remove = await fetch(`${origin}/api/project/blocks`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2, sectionId: 'section-1', x: 0, y: 0, z: 0, state: null }) });
  assert.equal(remove.status, 200); assert.equal((await remove.json()).revision, 3);
  const undo = await fetch(`${origin}/api/project/blocks/undo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 3 }) });
  assert.equal(undo.status, 200, (await undo.clone().json()).error); assert.equal((await undo.json()).revision, 4);
  const redo = await fetch(`${origin}/api/project/blocks/redo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 4 }) });
  assert.equal(redo.status, 200); assert.equal((await redo.json()).revision, 5); assert.equal(renders, 5);
  const current = await fetch(`${origin}/api/map/manifest?floor=floor-1`, { cache: 'no-store' }).then(response => response.json());
  assert.equal(current.projectRevision, 5);
  assert.equal(current.sections[0].placementX, 1, 'display frame expands while section local placement/origin remains independent');
});

test('failed block rendering keeps last public output while retaining revisioned geometry for retry', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-block-fail-'));
  await mkdir(path.join(dataDir, 'assets', 'minecraft', 'blockstates'), { recursive: true });
  await writeFile(path.join(dataDir, 'assets', 'minecraft', 'blockstates', 'stone.json'), JSON.stringify({ variants: { '': { model: 'minecraft:block/stone' } } }));
  const db = sectionDb(path.join(dataDir, 'project.sqlite')); db.close();
  let fail = false;
  const renderer = { async render({ output }) { if (fail) throw new Error('injected render failure'); await writeFile(output, png); return { width: 64, height: 64, bounds: { width: 4, depth: 4 }, renderer: { pixelSize: 16 } }; } };
  const { server, origin } = await listen(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) })).status, 200);
  fail = true;
  const response = await fetch(`${origin}/api/project/blocks`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1, sectionId: 'section-1', x: 2, y: 1, z: 1, state: { id: 'minecraft:stone', properties: {} } }) });
  assert.equal(response.status, 202);
  const result = await response.json(); assert.equal(result.saved, false); assert.match(result.warning, /injected render failure/);
  const publicMap = await fetch(`${origin}/api/map/manifest?floor=floor-1`, { cache: 'no-store' }).then(item => item.json());
  assert.equal(publicMap.projectRevision, 1, 'failed output never replaces the last complete visitor release');
  const project = openProject(path.join(dataDir, 'project.sqlite'));
  try { assert.equal(readSectionBlock(project, 'section-1', 2, 1, 1).id, 'minecraft:stone', 'accepted geometry remains recoverable'); }
  finally { project.close(); }
  fail = false;
  const retry = await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(retry.status, 200);
  assert.equal((await fetch(`${origin}/api/map/manifest?floor=floor-1`, { cache: 'no-store' }).then(item => item.json())).projectRevision, 2);
});
