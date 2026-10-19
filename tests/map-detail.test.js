import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { detailPixelSize } from '../src/detail-resolution.js';
import { createGenerationService } from '../src/generation.js';
import { renderOrthographic } from '../src/renderer.js';
import { createApp } from '../src/server.js';
import { mountMapDetail, wantsMapDetail } from '../public/map-detail.js';

test('detail resolution respects the renderer memory limit and existing high-resolution maps', () => {
  assert.equal(detailPixelSize({ x: 100, z: 100 }, 16), 32);
  assert.equal(detailPixelSize({ x: 200, z: 200 }, 16), 20);
  assert.equal(detailPixelSize({ x: 250, z: 250 }, 16), null);
  assert.equal(detailPixelSize({ x: 10, z: 10 }, 32), null);
  assert.equal(wantsMapDetail(.5, 2), false);
  assert.equal(wantsMapDetail(1, 2), true);
  assert.equal(wantsMapDetail(2, 1), true);
});

test('detail loads on demand, hides for previews, and leaves the base image intact on failure', () => {
  class ImageStub extends EventTarget {
    requests = [];
    set src(value) { this.requests.push(value); }
    remove() {}
  }
  const images = [], base = { src: 'base.png', style: {}, after() {} };
  const controller = mountMapDetail(base, { createImage: () => { const node = new ImageStub(); images.push(node); return node; }, pixelRatio: () => 1 });
  const floor = { id: 'f', projectRevision: 1, imageVersion: 'v', detailImage: { pixelSize: 32 } };
  controller.setFloor(floor); controller.update(.5);
  const detail = images[0];
  assert.equal(detail.requests.length, 0);
  controller.update(2); assert.equal(detail.hidden, true);
  detail.dispatchEvent(new Event('load')); assert.equal(detail.hidden, false);
  assert.equal(base.style.opacity, '0');
  controller.update(3); assert.equal(detail.requests.length, 1);
  controller.update(3, true); assert.equal(detail.hidden, true);
  assert.equal(base.style.opacity, '');
  controller.update(3); assert.equal(detail.hidden, false);
  controller.update(.5); assert.equal(detail.hidden, true);
  controller.setFloor({ ...floor, id: 'other' }); controller.update(2);
  detail.dispatchEvent(new Event('load'));
  assert.equal(images[1].hidden, true, 'a late load from the previous floor cannot reveal the next image');
  images[1].dispatchEvent(new Event('error'));
  controller.update(3); assert.equal(images[1].hidden, true); assert.equal(images[1].requests.length, 1);
  assert.equal(base.style.opacity, '');
  controller.setFloor({ ...floor, detailImage: null }); controller.update(3);
  assert.equal(images.length, 2); assert.equal(base.src, 'base.png');
});

test('detail is rendered from geometry and served separately without changing base coordinates', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-map-detail-'));
  const assets = path.join(dataDir, 'assets', 'minecraft'); await mkdir(assets, { recursive: true });
  for (const directory of ['blockstates', 'models/block', 'textures/block']) await mkdir(path.join(assets, directory), { recursive: true });
  await writeFile(path.join(assets, 'blockstates/stone.json'), JSON.stringify({ variants: { '': { model: 'minecraft:block/stone' } } }));
  await writeFile(path.join(assets, 'models/block/stone.json'), JSON.stringify({ textures: { top: 'minecraft:block/stone' }, elements: [{ from: [0, 0, 0], to: [5.5, 16, 16], faces: { up: { texture: '#top' } } }] }));
  await sharp({ create: { width: 16, height: 16, channels: 4, background: '#eeeeee' } }).png().toFile(path.join(assets, 'textures/block/stone.png'));
  const generation = createGenerationService({ dataDir, assetsDir: assets, renderer: { render: input => renderOrthographic(input.schematic, input) } });
  await generation.save({ revision: 1, floors: [{ id: 'f', name: 'Floor 0', dimensions: { x: 2, y: 1, z: 1 }, blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:stone', properties: {} }], sections: [], renderOptions: { pixelSize: 16 } }] });
  const floor = await generation.currentManifest('f');
  assert.equal(floor.width, 32); assert.equal(floor.height, 16); assert.equal(floor.renderer.pixelSize, 16);
  assert.equal(floor.detailImage.width, 64); assert.equal(floor.detailImage.height, 32);
  const detail = await sharp(await readFile(path.join(dataDir, 'releases', 'revision-1', floor.detailImage.image))).metadata();
  assert.equal(detail.width, 64); assert.equal(detail.height, 32);
  const basePixels = await sharp(path.join(dataDir, 'releases', 'revision-1', floor.image)).resize(64, 32, { kernel: 'nearest' }).raw().toBuffer();
  const detailPixels = await sharp(path.join(dataDir, 'releases', 'revision-1', floor.detailImage.image)).raw().toBuffer();
  assert.notDeepEqual(detailPixels, basePixels, 'detail resolves subpixel geometry rather than enlarging the base PNG');
  const app = createApp({ dataDir, initializeWorker: false, recordRuns: false });
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.locals.runRecorder.stop(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [query, width] of [['', 32], ['&detail=1', 64]]) {
    const response = await fetch(`${origin}/api/map/image?revision=1&floor=f${query}`);
    assert.equal(response.status, 200);
    assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width, width);
  }
});
