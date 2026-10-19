import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { encodeSectionChunks, floorToSectionLocal, importSchematicSection, moveSectionBlocks, openProject, projectRevision, readSectionBlock, readSectionBlocks, saveBlock, sectionLocalToFloor, setSectionLayout, snapshotProject } from '../src/project-store.js';
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

test('whole-section placement preserves local geometry and anchors, rejects occupied collisions, and survives reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rr-layout-'));
  const file = path.join(directory, 'project.sqlite');
  let db = sectionDb(file);
  try {
    db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('section-2', 'floor-1', 'East', JSON.stringify({ x: 4, y: 4, z: 4 }), 8, 0, '{}');
    const otherChunk = encodeSectionChunks([{ x: 0, y: 0, z: 0, id: 'minecraft:stone', properties: {} }])[0];
    db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)').run('section-2', 0, 0, 0, otherChunk.compressed);
    db.prepare('INSERT INTO markers(id,section_id,type,name,x,z) VALUES(?,?,?,?,?,?)').run('ordinary', 'section-2', 'chest', 'Cache', 1.5, 1.5);
    db.prepare('INSERT INTO markers(id,section_id,type,name,x,z) VALUES(?,?,?,?,?,?)').run('stairs', 'section-2', 'stairs', 'Stairs', 2.5, 1.5);
    const before = snapshotProject(db).floors[0];
    assert.equal(setSectionLayout(db, { sectionId: 'section-2', placementX: 12, placementZ: -3, labelX: 2.25, labelZ: 1.75 }, 1).revision, 2);
    const after = snapshotProject(db).floors[0];
    const section = after.sections.find(item => item.id === 'section-2');
    assert.deepEqual([section.placementX, section.placementZ, section.labelX, section.labelZ], [12, 0, 2.25, 1.75]);
    assert.deepEqual([db.prepare('SELECT placement_x,placement_z FROM sections WHERE id=?').get('section-2').placement_x, db.prepare('SELECT placement_z FROM sections WHERE id=?').get('section-2').placement_z], [12, -3]);
    assert.equal(readSectionBlocks(db, 'section-2')[0].id, 'minecraft:stone');
    assert.deepEqual(after.markers.filter(item => item.sectionId === 'section-2').map(item => [item.localX, item.localZ]).sort(), [[1.5, 1.5], [2.5, 1.5]]);
    assert.equal(after.markers.find(item => item.id === 'ordinary').x, 13.5 - Math.min(0, ...after.sections.map(item => item.placementX)));
    assert.throws(() => setSectionLayout(db, { sectionId: 'section-1', placementX: 12, placementZ: -3 }, 2), /collision/i);
    assert.equal(projectRevision(db), 2);
    db.close(); db = openProject(file);
    const reopened = snapshotProject(db).floors[0].sections.find(item => item.id === 'section-2');
    assert.deepEqual([reopened.placementX, reopened.placementZ, reopened.labelX, reopened.labelZ], [12, 0, 2.25, 1.75]);
    assert.deepEqual([db.prepare('SELECT placement_x,placement_z FROM sections WHERE id=?').get('section-2').placement_x, db.prepare('SELECT placement_z FROM sections WHERE id=?').get('section-2').placement_z], [12, -3]);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('whole-section placement allows empty overlap and exactly identical occupied overlap', () => {
  const db = sectionDb();
  try {
    db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('empty', 'floor-1', 'Empty', JSON.stringify({ x: 4, y: 4, z: 4 }), 12, 0, '{}');
    assert.equal(setSectionLayout(db, { sectionId: 'empty', placementX: 0, placementZ: 0 }, 1).revision, 2);
    db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('same', 'floor-1', 'Same block', JSON.stringify({ x: 4, y: 4, z: 4 }), 12, 0, '{}');
    const chest = { x: 0, y: 0, z: 0, id: 'minecraft:chest', properties: { facing: 'north', type: 'single', waterlogged: 'false' } };
    const chunk = encodeSectionChunks([chest])[0];
    db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)').run('same', 0, 0, 0, chunk.compressed);
    assert.equal(setSectionLayout(db, { sectionId: 'same', placementX: 0, placementZ: 0 }, 2).revision, 3);
  } finally { db.close(); }
});

test('section anchor transforms round-trip for markers, labels, and future connection endpoints', () => {
  const section = { placementX: 18, placementZ: -7 }, origin = { x: -3, z: -12 }, local = { x: 4.5, y: -2, z: 9.5 };
  assert.deepEqual(floorToSectionLocal(section, sectionLocalToFloor(section, local, origin), origin), local);
});

test('section layout API regenerates transformed anchors, rejects collisions, supports undo/redo and persists through restart', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-section-layout-route-'));
  const db = sectionDb(path.join(dataDir, 'project.sqlite'));
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('section-2', 'floor-1', 'East', JSON.stringify({ x: 4, y: 4, z: 4 }), 8, 0, '{}');
  const chunk = encodeSectionChunks([{ x: 0, y: 0, z: 0, id: 'minecraft:stone', properties: {} }])[0];
  db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)').run('section-2', 0, 0, 0, chunk.compressed);
  db.prepare('INSERT INTO markers(id,section_id,type,name,x,z) VALUES(?,?,?,?,?,?)').run('room-marker', 'section-2', 'chest', 'Cache', 1.5, 1.5);
  db.prepare('INSERT INTO markers(id,section_id,type,name,x,z) VALUES(?,?,?,?,?,?)').run('stair-marker', 'section-2', 'stairs', 'Downstairs', 2.5, 1.5);
  db.close();
  let renders = 0;
  const renderer = { async render({ output, schematic }) { renders++; await writeFile(output, png); return { width: schematic.dimensions.x * 16, height: schematic.dimensions.z * 16, bounds: { width: schematic.dimensions.x, depth: schematic.dimensions.z }, renderer: { pixelSize: 16 } }; } };
  let app = createApp({ dataDir, password: 'secret', initializeWorker: false, renderer });
  let { server, origin } = await listen(app);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) })).status, 200);
  const saveLayout = (expectedRevision, placementX, placementZ) => fetch(`${origin}/api/project/sections/section-2/layout`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision, placementX, placementZ, labelX: 2.25, labelZ: 1.75 }) });
  const moved = await saveLayout(1, 12, -3);
  assert.equal(moved.status, 200, (await moved.clone().json()).error);
  assert.equal((await moved.json()).revision, 2);
  assert.equal(renders, 2, 'layout commits regenerate the entire affected floor image');
  const manifest = await fetch(`${origin}/api/map/manifest?floor=floor-1`, { cache: 'no-store' }).then(response => response.json());
  const movedSection = manifest.sections.find(section => section.id === 'section-2');
  assert.deepEqual([movedSection.labelX, movedSection.labelZ], [2.25, 1.75]);
  assert.deepEqual(manifest.markers.filter(marker => marker.sectionId === 'section-2').map(marker => [marker.localX, marker.localZ, marker.x, marker.z]).sort((a,b) => a[0]-b[0]), [[1.5,1.5,13.5,1.5],[2.5,1.5,14.5,1.5]]);
  const preview = await fetch(`${origin}/api/project/sections/section-1/layout-preview?placementX=12&placementZ=-3`, { headers }).then(response => response.json());
  assert.deepEqual(preview.conflicts, [{ x: 12, y: 0, z: -3 }]);
  const collision = await fetch(`${origin}/api/project/sections/section-1/layout`, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 2, placementX: 12, placementZ: -3, labelX: 0, labelZ: 0 }) });
  assert.equal(collision.status, 409);
  assert.match((await collision.json()).error, /collision/i);
  const undo = await fetch(`${origin}/api/project/sections/layout/undo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(undo.status, 200, (await undo.clone().json()).error); assert.equal((await undo.json()).revision, 3);
  const redo = await fetch(`${origin}/api/project/sections/layout/redo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 3 }) });
  assert.equal(redo.status, 200, (await redo.clone().json()).error); assert.equal((await redo.json()).revision, 4);
  await new Promise(resolve => server.close(resolve));
  ({ server, origin } = await listen(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer })));
  t.after(async () => new Promise(resolve => server.close(resolve)));
  const afterRestart = await fetch(`${origin}/api/map/manifest?floor=floor-1`, { cache: 'no-store' }).then(response => response.json());
  assert.equal(afterRestart.projectRevision, 4);
  assert.deepEqual([afterRestart.sections.find(section => section.id === 'section-2').labelX, afterRestart.sections.find(section => section.id === 'section-2').placementZ], [2.25, 0]);
  assert.deepEqual(afterRestart.markers.map(marker => marker.name).sort(), ['Cache', 'Downstairs']);
});

test('group block move is atomic across negative Y and chunk boundaries and carries block entities', () => {
  const db = sectionDb();
  try {
    saveBlock(db, { sectionId: 'section-1', x: 15, y: -1, z: 15, state: { id: 'minecraft:chest', properties: { facing: 'north', type: 'single', waterlogged: 'false' } } }, 1);
    const before = snapshotProject(db).floors[0];
    const moved = moveSectionBlocks(db, { sectionId: 'section-1', blocks: [{ x: 0, y: 0, z: 0 }, { x: 15, y: -1, z: 15 }], dy: -2 }, 2);
    assert.equal(moved.revision, 3);
    assert.equal(readSectionBlock(db, 'section-1', 0, -2, 0).id, 'minecraft:chest');
    assert.equal(readSectionBlock(db, 'section-1', 0, -2, 0).blockEntities[0].Items[0].Slot, 0);
    assert.equal(readSectionBlock(db, 'section-1', 15, -1, 15), null);
    const after = snapshotProject(db).floors[0];
    assert.deepEqual(after.sections[0].placementX, before.sections[0].placementX);
    assert.deepEqual(after.sections[0].placementZ, before.sections[0].placementZ);
    assert.deepEqual(after.markers, before.markers);
    assert.equal(after.blocks.length, before.blocks.length);
  } finally { db.close(); }
});

test('group block move permits source/destination overlap but rejects outside collisions without mutation', () => {
  const db = sectionDb();
  try {
    saveBlock(db, { sectionId: 'section-1', x: 0, y: 1, z: 0, state: { id: 'minecraft:stone', properties: {} } }, 1);
    assert.equal(moveSectionBlocks(db, { sectionId: 'section-1', blocks: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }], dy: 1 }, 2).revision, 3);
    assert.equal(readSectionBlock(db, 'section-1', 0, 1, 0).id, 'minecraft:chest');
    assert.equal(readSectionBlock(db, 'section-1', 0, 2, 0).id, 'minecraft:stone');
    const revision = projectRevision(db);
    assert.throws(() => moveSectionBlocks(db, { sectionId: 'section-1', blocks: [{ x: 0, y: 1, z: 0 }], dy: 1 }, revision), /collision/i);
    assert.equal(readSectionBlock(db, 'section-1', 0, 1, 0).id, 'minecraft:chest');
    assert.equal(projectRevision(db), revision);
  } finally { db.close(); }
});

test('group move route regenerates one atomic revision and undo/redo restore the full selection', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-group-move-'));
  const db = sectionDb(path.join(dataDir, 'project.sqlite')); db.close();
  const rendered = [];
  const renderer = { async render({ output, schematic }) { rendered.push(schematic.blocks); await writeFile(output, png); return { width: 64, height: 64, bounds: { width: 4, depth: 4 }, renderer: { pixelSize: 16 }, blockCount: schematic.blocks.length }; } };
  const { server, origin } = await listen(createApp({ dataDir, password: 'secret', initializeWorker: false, renderer }));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/generation/save`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) })).status, 200);
  const slice = await fetch(`${origin}/api/project/preview?floor=floor-1&maxY=-1`, { headers });
  assert.equal(slice.status, 200); assert.equal(slice.headers.get('content-type').split(';')[0], 'image/png'); assert.equal(rendered.at(-1).length, 0, 'height preview omits upper geometry for display');
  const revisionBeforeMove = openProject(path.join(dataDir, 'project.sqlite'));
  try { assert.equal(projectRevision(revisionBeforeMove), 1, 'slice preview does not mutate project data'); } finally { revisionBeforeMove.close(); }
  const move = await fetch(`${origin}/api/project/block-moves`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1, sectionId: 'section-1', blocks: [{ x: 0, y: 0, z: 0 }], dy: -1 }) });
  assert.equal(move.status, 200, (await move.clone().json()).error); assert.equal((await move.json()).revision, 2);
  const heights = await fetch(`${origin}/api/project/height-range?floor=floor-1`, { headers }).then(response => response.json());
  assert.deepEqual(heights, { minY: -1, maxY: 0 });
  const undo = await fetch(`${origin}/api/project/blocks/undo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(undo.status, 200); assert.equal((await undo.json()).revision, 3);
  const redo = await fetch(`${origin}/api/project/blocks/redo`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 3 }) });
  assert.equal(redo.status, 200); assert.equal((await redo.json()).revision, 4);
  const reopened = openProject(path.join(dataDir, 'project.sqlite'));
  try {
    assert.equal(readSectionBlock(reopened, 'section-1', 0, -1, 0).id, 'minecraft:chest');
    const floor = snapshotProject(reopened).floors[0];
    assert.deepEqual([floor.sections[0].placementX, floor.sections[0].placementZ], [0, 0]);
    assert.equal(readSectionBlock(reopened, 'section-1', 0, 0, 0), null);
  } finally { reopened.close(); }
});

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

test('group movement of a real fixture block entity extends height without moving section or marker anchors', async () => {
  const schematic = decodeLitematic(await readFile(new URL('../schematics/Start 0F.litematic', import.meta.url)));
  const db = sectionDb();
  try {
    db.prepare('DELETE FROM sections WHERE id=?').run('section-1');
    const imported = importSchematicSection(db, schematic, { sectionName: 'Fixture' });
    db.prepare('INSERT INTO markers(id,section_id,type,name,description,x,z) VALUES(?,?,?,?,?,?,?)').run('anchor', imported.sectionId, 'chest', 'Fixture marker', '', 2.5, 3.5);
    const entity = schematic.regions[0].blockEntities.find(item => readSectionBlock(db, imported.sectionId, item.x, item.y, item.z) && !readSectionBlock(db, imported.sectionId, item.x, item.y + 1, item.z));
    assert.ok(entity, 'fixture has a block entity with an empty cell above it');
    const before = snapshotProject(db).floors[0];
    const result = moveSectionBlocks(db, { sectionId: imported.sectionId, blocks: [{ x: entity.x, y: entity.y, z: entity.z }], dy: 1 }, projectRevision(db));
    const after = snapshotProject(db).floors[0];
    const moved = readSectionBlock(db, imported.sectionId, entity.x, entity.y + 1, entity.z);
    assert.equal(moved.blockEntities[0].y, entity.y + 1);
    assert.deepEqual(after.sections.map(({ placementX, placementZ, labelX, labelZ }) => [placementX, placementZ, labelX, labelZ]), before.sections.map(({ placementX, placementZ, labelX, labelZ }) => [placementX, placementZ, labelX, labelZ]));
    assert.deepEqual(after.markers, before.markers);
    assert.equal(result.after.length, 1);
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
