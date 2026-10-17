import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractMatchingAssets, extractResourcePack } from '../src/assets.js';

function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(content);
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); filename.copy(central, 46);
    centrals.push(central); offset += local.length + data.length;
  }
  const end = Buffer.alloc(22), centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const required = [
  ['blockstates/stone.json', '{}'],
  ['models/block/stone.json', '{}'],
  ['textures/block/stone.png', 'png']
];
const source = version => [['version.json', JSON.stringify({ id: version, world_version: 5023 })], ...required.map(([name, data]) => [`assets/minecraft/${name}`, data])];

test('asset extraction rejects cumulative expansion over its configured bound and preserves output', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const jar = path.join(dir, 'client.jar'), output = path.join(dir, 'assets');
  await writeFile(jar, zip(source('26.3')));
  const metadata = await extractMatchingAssets(jar, output);
  assert.equal(metadata.minecraftVersion, '26.3');
  await writeFile(jar, zip(source('26.3').map(([name, data]) => [name, name === 'version.json' ? data : `${data}123456`])));
  await assert.rejects(extractMatchingAssets(jar, output, '26.3', { maxExpandedBytes: 8 }), /Expanded Minecraft assets exceed/);
  assert.equal(JSON.parse(await readFile(path.join(output, 'asset-source.json'), 'utf8')).sha256, metadata.sha256);
});

test('asset extraction enforces the compressed archive size limit', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const jar = path.join(dir, 'client.jar');
  const bytes = zip(source('26.3'));
  await writeFile(jar, bytes);
  await assert.rejects(extractMatchingAssets(jar, path.join(dir, 'out'), '26.3', { maxArchiveBytes: bytes.length - 1 }), /compressed limit/);
});

test('asset extraction rejects duplicate and traversal paths', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const jar = path.join(dir, 'bad.jar');
  await writeFile(jar, zip([...source('26.3'), ['assets/minecraft/blockstates/stone.json', '{}']]));
  await assert.rejects(extractMatchingAssets(jar, path.join(dir, 'out')), /Duplicate resource path/);
  await writeFile(jar, zip([...source('26.3'), ['assets/minecraft/textures/block/../../bad.png', 'x']]));
  await assert.rejects(extractMatchingAssets(jar, path.join(dir, 'out')), /Unsafe resource path/);
});


test('resource packs validate paths and metadata, layerable extraction is atomic and tracks hash and format', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-pack-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, 'pack.zip'), output = path.join(dir, 'resource-pack');
  const pack = entries => [['pack.mcmeta', JSON.stringify({ pack: { pack_format: 34, description: 'Test pack' } })], ...entries];
  await writeFile(zipPath, zip(pack([['assets/minecraft/textures/block/stone.png', 'override']])));
  const metadata = await extractResourcePack(zipPath, output);
  assert.equal(metadata.packFormat, 34); assert.equal(metadata.description, 'Test pack'); assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(output, 'textures/block/stone.png'), 'utf8'), 'override');
  await writeFile(zipPath, zip(pack([['assets/minecraft/models/block/../../escape.json', 'bad']])));
  await assert.rejects(extractResourcePack(zipPath, output), /Unsafe resource path/);
  assert.equal(await readFile(path.join(output, 'textures/block/stone.png'), 'utf8'), 'override');
  await writeFile(zipPath, zip([['assets/minecraft/textures/block/stone.png', 'missing metadata']]));
  await assert.rejects(extractResourcePack(zipPath, output), /pack.mcmeta/);
});
