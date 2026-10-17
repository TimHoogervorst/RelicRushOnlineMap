import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openProject, readSectionBlocks, seedInitialProject } from './project-store.js';
import { createRendererAdapter } from './renderer-adapter.ts';
import { extractMatchingAssets } from './assets.js';

try {
  const renderer = createRendererAdapter();
  await mkdir(workerData.dataDir, { recursive: true });
  const db = openProject(path.join(workerData.dataDir, 'project.sqlite'));
  const seeded = seedInitialProject(db, workerData.fixturePath);
  const section = db.prepare('SELECT bounds_json, provenance_json FROM sections WHERE id=?').get('section-start-0f');
  if (!section) throw new Error('No initial project section exists; starting fixture is missing');
  const blocks = readSectionBlocks(db);
  const dimensions = JSON.parse(section.bounds_json);
  const schematic = { dimensions, blocks, version: 7, subVersion: 1, dataVersion: 5023, regions: [] };
  const releasesDir = path.join(workerData.dataDir, 'releases');
  await mkdir(releasesDir, { recursive: true });
  const currentPath = path.join(releasesDir, 'current.json');
  let existingRelease = null;
  try { existingRelease = JSON.parse(await readFile(currentPath, 'utf8')); } catch { /* first generation */ }
  let rendered = Boolean(existingRelease && existsSync(path.join(releasesDir, existingRelease.directory, 'manifest.json')));
  let warning = null;
  let assetsDir = workerData.assetsDir;
  if (workerData.clientJar && existsSync(workerData.clientJar)) {
    assetsDir ??= path.join(workerData.dataDir, 'assets', 'minecraft');
    try { await stat(path.join(assetsDir, 'asset-source.json')); }
    catch { await extractMatchingAssets(workerData.clientJar, assetsDir); }
  }
  if ((!existingRelease || workerData.forceRender) && assetsDir) {
    const temp = path.join(releasesDir, `.building-${randomUUID()}`);
    const revision = (existingRelease?.revision ?? 0) + 1;
    const final = path.join(releasesDir, `revision-${revision}`);
    await mkdir(temp, { recursive: true });
    try {
      const metadata = await renderer.render({ schematic, assets: assetsDir, output: path.join(temp, 'map.png') });
      let assetSource = null;
      try { assetSource = JSON.parse(await readFile(path.join(assetsDir, 'asset-source.json'), 'utf8')); } catch { /* supplied loose resource pack */ }
      const manifest = { manifestVersion: 1, projectRevision: revision, floorId: 'floor-0', floorName: 'Floor 0', sectionId: 'section-start-0f', sectionName: 'Starting Area', ...metadata, generatedAt: new Date().toISOString(), blockCount: blocks.length, assetSource, provenance: JSON.parse(section.provenance_json) };
      await writeFile(path.join(temp, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await rm(final, { recursive: true, force: true });
      await rename(temp, final);
      await writeFile(`${currentPath}.tmp`, JSON.stringify({ revision, directory: `revision-${revision}` }));
      await rename(`${currentPath}.tmp`, currentPath);
      rendered = true;
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      warning = error.message;
    }
  }
  db.close();
  parentPort.postMessage({ ready: true, seeded, blockCount: blocks.length, rendered, warning });
} catch (error) {
  parentPort.postMessage({ ready: false, error: error.stack ?? error.message });
}
