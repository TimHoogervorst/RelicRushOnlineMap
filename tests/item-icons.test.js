import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { listItemIcons, renderItemIcon } from '../src/item-icons.js';
import { createApp } from '../src/server.js';

test('inventory catalog and endpoint support block models, flat items, and resource packs', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-icons-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vanilla = path.join(dir, 'assets/minecraft'), pack = path.join(dir, 'assets/resource-pack');
  const json = async (name, value) => { const file = path.join(vanilla, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
  await json('items/stone.json', { model: { type: 'minecraft:model', model: 'minecraft:block/stone' } });
  await json('models/block/stone.json', { parent: 'minecraft:block/cube', textures: { all: 'minecraft:block/stone' } });
  await json('models/block/cube.json', { display: { gui: { rotation: [30,225,0], scale: [.625,.625,.625] } }, elements: [{ from: [0,0,0], to: [16,16,16], faces: Object.fromEntries(['up','down','north','south','east','west'].map(face => [face, { texture: '#all' }])) }] });
  await json('items/door.json', { model: { type: 'minecraft:model', model: 'minecraft:item/door' } });
  await json('models/item/door.json', { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/door' } });
  for (const [root, folder, name, color] of [[vanilla,'block','stone','#ff0000'],[pack,'block','stone','#00ff00'],[vanilla,'item','door','#0000ff']]) {
    await mkdir(path.join(root, 'textures', folder), { recursive: true });
    await sharp({ create: { width: 16, height: 16, channels: 4, background: color } }).png().toFile(path.join(root, 'textures', folder, `${name}.png`));
  }
  const roots = [pack, vanilla];
  assert.deepEqual((await listItemIcons(roots)).map(item => item.id), ['minecraft:door','minecraft:stone']);
  const stone = await renderItemIcon(roots, 'minecraft:stone');
  const { data, info } = await sharp(stone).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 64);
  assert.equal(data[3], 0, 'inventory cube has transparent corners instead of filling a texture square');
  assert.ok(data[(32 * 64 + 32) * 4 + 1] > 100, 'resource-pack block texture is used');
  assert.equal(data[(32 * 64 + 32) * 4], 0);
  const blue = await sharp(await renderItemIcon(roots, 'minecraft:door')).raw().toBuffer();
  assert.deepEqual([...blue.subarray(0,4)], [0,0,255,255], 'flat inventory items retain their item texture');
  assert.equal(await renderItemIcon(roots, 'minecraft:../secret'), null);
  assert.equal(await renderItemIcon(roots, 'minecraft:unknown'), null);
  const server = createServer(createApp({ dataDir: dir, initializeWorker: false }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.ok((await fetch(`${origin}/api/item-icons`).then(r => r.json())).some(item => item.id === 'minecraft:stone'));
  const response = await fetch(`${origin}/api/item-icon?id=minecraft:stone`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /image\/png/);
  assert.equal((await fetch(`${origin}/api/item-icon?id=minecraft:..%2Fsecret`)).status, 400);
});
