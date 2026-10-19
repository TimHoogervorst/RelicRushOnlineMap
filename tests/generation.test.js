import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createGenerationService } from '../src/generation.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

test('content hashes are stable across revisions and object key order', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-hashes-'));
  const renderer = { async render({ output }) { await writeFile(output, png); return { width: 1, height: 1, bounds: { width: 1, depth: 1 }, heightGrid: { width: 1, depth: 1, values: [[null]] } }; } };
  const generation = createGenerationService({ dataDir, assetsDir: path.join(dataDir, 'assets'), renderer });
  const first = { revision: 1, floors: [{ id: 'f1', name: 'Floor', dimensions: { x: 1, y: 1, z: 1 }, blocks: [], sections: [], renderOptions: { pixelSize: 16 } }] };
  const second = { floors: [{ renderOptions: { pixelSize: 16 }, sections: [], blocks: [], dimensions: { z: 1, y: 1, x: 1 }, name: 'Floor', id: 'f1' }], revision: 2 };
  try {
    await generation.save(first);
    const firstManifest = JSON.parse(await readFile(path.join(dataDir, 'releases', 'revision-1', 'manifest.json')));
    await generation.save(second);
    const secondManifest = JSON.parse(await readFile(path.join(dataDir, 'releases', 'revision-2', 'manifest.json')));
    assert.equal(firstManifest.projectRevision, 1);
    assert.equal(secondManifest.projectRevision, 2);
    assert.equal(secondManifest.projectHash, firstManifest.projectHash);
    assert.equal(secondManifest.assetHash, firstManifest.assetHash);
    assert.equal(secondManifest.renderSettingsHash, firstManifest.renderSettingsHash);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('publishes image, manifest, and project snapshot through one revision pointer', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-generation-'));
  const renderer = { async render({ output }) { await writeFile(output, png); return { width: 1, height: 1, bounds: { width: 1, depth: 1 } }; } };
  const generation = createGenerationService({ dataDir, assetsDir: path.join(dataDir, 'assets'), renderer });
  const snapshot = { revision: 4, floors: [{ id: 'f1', name: 'Floor 1', dimensions: { x: 1, y: 1, z: 1 }, blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:stone' }], sections: [{ id: 's1', name: 'Entry' }] }] };
  try {
    await generation.save(snapshot);
    const manifest = await generation.currentManifest('f1');
    assert.equal(manifest.projectRevision, 4);
    const fullManifest = JSON.parse(await readFile(path.join(dataDir, 'releases', 'revision-4', 'manifest.json')));
    assert.equal(fullManifest.generatorVersion, '13');
    assert.match(fullManifest.projectHash, /^[a-f0-9]{64}$/);
    assert.match(fullManifest.assetHash, /^[a-f0-9]{64}$/);
    assert.match(fullManifest.renderSettingsHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(fullManifest.assetVersion, { minecraft: null, world: null, resourcePack: null });
    assert.deepEqual(manifest.sections.map(section => section.name), ['Entry']);
    const pointer = JSON.parse(await readFile(path.join(dataDir, 'releases', 'current.json'), 'utf8'));
    const savedSnapshot = JSON.parse(await readFile(path.join(dataDir, 'releases', pointer.directory, 'project.json'), 'utf8'));
    assert.equal(savedSnapshot.revision, manifest.projectRevision);
    assert.deepEqual(await readFile(path.join(dataDir, 'releases', pointer.directory, manifest.image)), png);
    assert.equal(manifest.heightGrid.path, 'f1-height-grid.json');
    assert.equal(manifest.heightGrid.projectRevision, 4);
    const grid = JSON.parse(await readFile(path.join(dataDir, 'releases', pointer.directory, manifest.heightGrid.path), 'utf8'));
    assert.equal(grid.projectRevision, 4);
    assert.deepEqual(grid.values, [[null]]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('failed generation leaves the last complete public revision in place and is retryable', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-generation-failure-'));
  let fail = false;
  const renderer = { async render({ output }) { if (fail) throw new Error('injected renderer failure'); await writeFile(output, png); return { width: 1, height: 1 }; } };
  const generation = createGenerationService({ dataDir, assetsDir: path.join(dataDir, 'assets'), renderer });
  const snapshot = revision => ({ revision, floors: [{ id: 'f1', name: 'Floor 1', dimensions: { x: 1, y: 1, z: 1 }, blocks: [], sections: [] }] });
  try {
    await generation.save(snapshot(1));
    fail = true;
    await assert.rejects(generation.save(snapshot(2)), /injected renderer failure/);
    assert.equal((await generation.currentManifest('f1')).projectRevision, 1);
    assert.equal(generation.queue.status.state, 'failed');
    fail = false;
    await generation.save(snapshot(2));
    assert.equal((await generation.currentManifest('f1')).projectRevision, 2);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('invalid renderer output cannot replace a complete revision', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-generation-invalid-'));
  let invalid = false;
  const renderer = { async render({ output }) { await writeFile(output, invalid ? 'not a PNG' : png); return { width: 1, height: 1 }; } };
  const generation = createGenerationService({ dataDir, assetsDir: path.join(dataDir, 'assets'), renderer });
  const snapshot = revision => ({ revision, floors: [{ id: 'f1', name: 'Floor 1', dimensions: { x: 1, y: 1, z: 1 }, blocks: [], sections: [] }] });
  try {
    await generation.save(snapshot(1));
    invalid = true;
    await assert.rejects(generation.save(snapshot(2)), /invalid PNG/);
    assert.equal((await generation.currentManifest('f1')).projectRevision, 1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('metadata-only release advances the public manifest without rerendering floor images', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-generation-metadata-'));
  let renders = 0;
  const renderer = { async render({ output }) { renders++; await writeFile(output, png); return { width: 1, height: 1, bounds: { width: 1, depth: 1 }, renderer: { pixelSize: 16 } }; } };
  const generation = createGenerationService({ dataDir, assetsDir: path.join(dataDir, 'assets', 'minecraft'), renderer });
  const snapshot = (revision, markers = []) => ({ revision, floors: [{ id: 'f1', name: 'Floor 1', dimensions: { x: 1, y: 1, z: 1 }, blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:stone' }], renderOptions: { pixelSize: 16 }, sections: [{ id: 's1', name: 'Entry', placementX: 0, placementZ: 0, renderSettings: { heightShadePerBlock: 0.02 } }], markers }] });
  try {
    await mkdir(path.join(dataDir, 'assets', 'minecraft'), { recursive: true });
    await writeFile(path.join(dataDir, 'assets', 'minecraft', 'asset-source.json'), JSON.stringify({ minecraftVersion: '26.3', worldVersion: 5023, sha256: 'a'.repeat(64) }));
    await mkdir(path.join(dataDir, 'assets', 'resource-pack'), { recursive: true });
    await writeFile(path.join(dataDir, 'assets', 'resource-pack', 'resource-pack-source.json'), JSON.stringify({ packFormat: 75, sha256: 'b'.repeat(64) }));
    await generation.save(snapshot(1));
    const before = JSON.parse(await readFile(path.join(dataDir, 'releases', 'revision-1', 'manifest.json')));
    assert.deepEqual(before.assetVersion, { minecraft: '26.3', world: 5023, resourcePack: 75 });
    assert.equal(before.assetHash, createHash('sha256').update(JSON.stringify({ resourcePack: 'b'.repeat(64), vanilla: 'a'.repeat(64) })).digest('hex'));
    const firstImage = await readFile(path.join(dataDir, 'releases', 'revision-1', 'f1.png'));
    await generation.saveMetadata(snapshot(2, [{ id: 'm1', sectionId: 's1', type: 'chest', name: 'Chest A', x: 61.5, z: 34.5, localX: 61.5, localZ: 34.5 }]));
    const manifest = JSON.parse(await readFile(path.join(dataDir, 'releases', 'revision-2', 'manifest.json')));
    assert.equal(renders, 2, 'base and detail are rendered once, then reused by metadata saves');
    assert.deepEqual(await readFile(path.join(dataDir, 'releases', 'revision-2', manifest.floors[0].detailImage.image)), await readFile(path.join(dataDir, 'releases', 'revision-1', before.floors[0].detailImage.image)));
    assert.equal(manifest.projectRevision, 2);
    assert.notEqual(manifest.projectHash, before.projectHash);
    assert.equal(manifest.renderSettingsHash, before.renderSettingsHash);
    assert.equal(manifest.assetHash, before.assetHash);
    assert.deepEqual(manifest.assetVersion, before.assetVersion);
    assert.equal(manifest.floors[0].markers[0].x, 61.5);
    assert.deepEqual(await readFile(path.join(dataDir, 'releases', 'revision-2', 'f1.png')), firstImage);
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'releases', 'revision-2', manifest.floors[0].heightGrid.path), 'utf8')).projectRevision, 1, 'reused geometry height data stays associated with its geometry revision');
    const restarted = createGenerationService({ dataDir, assetsDir: path.join(dataDir, 'assets', 'minecraft'), renderer });
    const reopened = await restarted.currentManifest();
    assert.equal(reopened.projectHash, manifest.projectHash);
    assert.equal(reopened.renderSettingsHash, before.renderSettingsHash);
    assert.equal(reopened.assetHash, before.assetHash);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
