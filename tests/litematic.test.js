import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { decodeLitematic, unpackPaletteIndices } from '../src/litematic.js';
import { decodeChunkBlob, encodeSectionChunks, openProject, readSectionBlocks, seedInitialProject, importSchematicSection } from '../src/project-store.js';
import { renderOrthographic } from '../src/renderer.js';

test('packed palette indices can cross long boundaries', () => {
  // 5-bit values: index 12 starts at bit 60 and spans two 64-bit words.
  const values = Array.from({ length: 30 }, (_, i) => (i * 7) & 31);
  const words = new BigInt64Array(3);
  values.forEach((value, i) => {
    const bit = BigInt(i * 5), word = Number(bit / 64n), shift = bit % 64n;
    words[word] |= BigInt(value) << shift;
    if (shift + 5n > 64n) words[word + 1] |= BigInt(value) >> (64n - shift);
  });
  assert.deepEqual(Array.from(unpackPaletteIndices(words, values.length, 5)), values);
});

test('versioned compressed chunks round-trip block states across negative chunk coordinates', () => {
  const blocks = [
    { x: -1, y: -17, z: 16, id: 'minecraft:oak_stairs', properties: { facing: 'west', half: 'top' } },
    { x: 16, y: 0, z: -1, id: 'minecraft:water', properties: { level: '0' } }
  ];
  const chunks = encodeSectionChunks(blocks);
  assert.deepEqual(chunks.map(({ cx, cy, cz }) => [cx, cy, cz]).sort(), [[-1, -2, 1], [1, 0, -1]]);
  const restored = chunks.map(chunk => {
    const decoded = decodeChunkBlob(chunk.compressed);
    const index = decoded.indices.findIndex(value => value !== 0);
    return { block: decoded.palette[decoded.indices[index]], index };
  });
  assert.deepEqual(restored.map(({ block }) => block).sort((a, b) => a.id.localeCompare(b.id)), blocks.map(({ id, properties }) => ({ id, properties })).sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(restored.map(({ index }) => index).sort((a, b) => a - b), [240, 3855]);
});

test('first fixture import persists once to SQLite and reopens from chunks', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rr-map-test-'));
  const database = openProject(path.join(dir, 'project.sqlite'));
  try {
    const fixture = fileURLToPath(new URL('../schematics/Start 0F.litematic', import.meta.url));
    const first = seedInitialProject(database, fixture);
    const second = seedInitialProject(database, fixture);
    assert.equal(first.seeded, true);
    assert.equal(first.blocks, 3484);
    assert.equal(second.seeded, false);
    const restored = readSectionBlocks(database);
    assert.equal(restored.length, 3484);
    const chunkRows = database.prepare('SELECT blob FROM section_chunks WHERE format_version=1').all();
    assert.equal(chunkRows.length, first.chunks);
    assert.equal(chunkRows.reduce((total, row) => total + decodeChunkBlob(row.blob).blockEntities.length, 0), 48);
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('imports multiple regions in shared normalized coordinates with states and block entities', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rr-map-import-'));
  const db = openProject(path.join(dir, 'project.sqlite'));
  try {
    const imported = importSchematicSection(db, {
      version: 7, subVersion: 1, dataVersion: 5023,
      regions: [
        { name: 'west', min: { x: -4, y: 2, z: 8 }, dimensions: { x: 2, y: 1, z: 1 }, blocks: [{ x: 1, y: 0, z: 0, id: 'minecraft:oak_stairs', properties: { facing: 'west' } }], blockEntities: [{ x: 1, y: 0, z: 0, id: 'minecraft:sign' }] },
        { name: 'east', min: { x: 2, y: 2, z: 8 }, dimensions: { x: 1, y: 1, z: 1 }, blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:gold_block', properties: {} }], blockEntities: [] }
      ]
    }, { floorName: 'Floor 2', sectionName: 'Imported' });
    assert.equal(imported.createdFloor, true);
    assert.deepEqual(readSectionBlocks(db, imported.sectionId).map(({ x, id }) => [x, id]), [[1, 'minecraft:oak_stairs'], [6, 'minecraft:gold_block']]);
    const entities = db.prepare('SELECT blob FROM section_chunks WHERE section_id=?').all(imported.sectionId).flatMap(row => decodeChunkBlob(row.blob).blockEntities);
    assert.equal(entities[0].x, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('fixture block entities remain aligned with their blocks after section import', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rr-map-entity-import-'));
  const db = openProject(path.join(dir, 'project.sqlite'));
  try {
    const schematic = decodeLitematic(await readFile(new URL('../schematics/Start 0F.litematic', import.meta.url)));
    const imported = importSchematicSection(db, schematic, { floorName: 'Fixture', sectionName: 'Fixture area' });
    const expected = { x: 62, y: 10, z: 12 };
    assert.ok(readSectionBlocks(db, imported.sectionId).some(block => block.x === expected.x && block.y === expected.y && block.z === expected.z && block.id === 'minecraft:decorated_pot'));
    const storedEntities = db.prepare('SELECT blob FROM section_chunks WHERE section_id=?').all(imported.sectionId)
      .flatMap(row => decodeChunkBlob(row.blob).blockEntities);
    assert.ok(storedEntities.some(entity => entity.id === 'minecraft:decorated_pot' && entity.x === expected.x && entity.y === expected.y && entity.z === expected.z));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('rejects conflicting occupied region placements without creating project rows', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rr-map-collision-'));
  const db = openProject(path.join(dir, 'project.sqlite'));
  const schematic = { version: 7, regions: [
    { name: 'one', min: { x: 0, y: 0, z: 0 }, dimensions: { x: 1, y: 1, z: 1 }, blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:stone', properties: {} }], blockEntities: [] },
    { name: 'two', min: { x: 0, y: 0, z: 0 }, dimensions: { x: 1, y: 1, z: 1 }, blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:dirt', properties: {} }], blockEntities: [] }
  ] };
  try {
    assert.throws(() => importSchematicSection(db, schematic, { floorName: 'Floor 1', sectionName: 'Collision' }), /conflict.*one.*two/i);
    assert.equal(db.prepare('SELECT count(*) count FROM floors').get().count, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('decodes the supplied Litematic v7 fixture and normalizes negative Y extent', async () => {
  const bytes = await readFile(new URL('../schematics/Start 0F.litematic', import.meta.url));
  const schematic = decodeLitematic(bytes);
  assert.deepEqual(schematic.dimensions, { x: 67, y: 13, z: 49 });
  assert.equal(schematic.version, 7);
  assert.equal(schematic.subVersion, 1);
  assert.equal(schematic.dataVersion, 5023);
  assert.equal(schematic.blocks.length, 3484);
  assert.deepEqual(schematic.chests.map(({ x, y, z }) => [x, y, z]).sort(), [[27, 10, 8], [61, 9, 34]]);
  assert.equal(schematic.regions[0].signedSize.y, -13);
});

test('unsupported blocks appear in the rendered map and its diagnostics', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rr-map-render-test-'));
  try {
    const result = await renderOrthographic({
      dimensions: { x: 1, y: 1, z: 1 },
      blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:unknown_fixture_block', properties: {} }]
    }, { assets: dir, output: path.join(dir, 'map.png'), pixelSize: 16 });
    const { data, info } = await sharp(path.join(dir, 'map.png')).raw().toBuffer({ resolveWithObject: true });
    const center = (8 * info.width + 8) * info.channels;
    assert.deepEqual([...data.subarray(center, center + 4)], [255, 0, 220, 255]);
    assert.deepEqual(result.unsupportedBlocks, ['minecraft:unknown_fixture_block']);
    assert.match(result.specialBlockFallbacks[0], /visible magenta cross fallback/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
