import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeLitematic, unpackPaletteIndices } from '../src/litematic.js';
import { decodeChunkBlob, encodeSectionChunks, openProject, readSectionBlocks, seedInitialProject } from '../src/project-store.js';

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
