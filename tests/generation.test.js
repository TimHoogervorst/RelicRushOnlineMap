import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGenerationService } from '../src/generation.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

test('publishes image, manifest, and project snapshot through one revision pointer', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-generation-'));
  const renderer = { async render({ output }) { await writeFile(output, png); return { width: 1, height: 1, bounds: { width: 1, depth: 1 } }; } };
  const generation = createGenerationService({ dataDir, assetsDir: path.join(dataDir, 'assets'), renderer });
  const snapshot = { revision: 4, floors: [{ id: 'f1', name: 'Floor 1', dimensions: { x: 1, y: 1, z: 1 }, blocks: [{ x: 0, y: 0, z: 0, id: 'minecraft:stone' }], sections: [{ id: 's1', name: 'Entry' }] }] };
  try {
    await generation.save(snapshot);
    const manifest = await generation.currentManifest('f1');
    assert.equal(manifest.projectRevision, 4);
    assert.deepEqual(manifest.sections.map(section => section.name), ['Entry']);
    const pointer = JSON.parse(await readFile(path.join(dataDir, 'releases', 'current.json'), 'utf8'));
    const savedSnapshot = JSON.parse(await readFile(path.join(dataDir, 'releases', pointer.directory, 'project.json'), 'utf8'));
    assert.equal(savedSnapshot.revision, manifest.projectRevision);
    assert.deepEqual(await readFile(path.join(dataDir, 'releases', pointer.directory, manifest.image)), png);
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
