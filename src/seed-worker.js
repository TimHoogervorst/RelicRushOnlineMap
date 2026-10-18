import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openProject, projectRevision, seedInitialProject, snapshotProject } from './project-store.js';
import { createRendererAdapter } from './renderer-adapter.ts';
import { extractMatchingAssets } from './assets.js';
import { createGenerationService } from './generation.js';

let db;
try {
  await mkdir(workerData.dataDir, { recursive: true });
  db = openProject(path.join(workerData.dataDir, 'project.sqlite'));
  const seeded = seedInitialProject(db, workerData.fixturePath);
  const assetsDir = workerData.assetsDir;
  if (workerData.clientJar && existsSync(workerData.clientJar)) {
    let hasItemTextures = false;
    try { const source = JSON.parse(await readFile(path.join(assetsDir, 'asset-source.json'), 'utf8')); hasItemTextures = Number.isInteger(source.itemTextures) && source.itemTextures > 0; }
    catch { /* extract assets below */ }
    if (!hasItemTextures) await extractMatchingAssets(workerData.clientJar, assetsDir);
  }
  let warning = null;
  let rendered = false;
  if (assetsDir && existsSync(assetsDir)) {
    const generation = createGenerationService({ dataDir: workerData.dataDir, renderer: createRendererAdapter(), assetsDir });
    try { await generation.save(snapshotProject(db)); rendered = true; }
    catch (error) { warning = error.message; }
  }
  let currentRevision = 0;
  try { currentRevision = JSON.parse(await readFile(path.join(workerData.dataDir, 'releases', 'current.json'), 'utf8')).revision; } catch { /* no prior visitor release */ }
  parentPort.postMessage({ ready: true, seeded, rendered: rendered || currentRevision > 0, warning, projectRevision: projectRevision(db), currentRevision });
} catch (error) {
  parentPort.postMessage({ ready: false, error: error.stack ?? error.message });
} finally { db?.close(); }
