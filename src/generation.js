import path from 'node:path';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { SaveQueue } from './save-queue.js';

function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  return writeFile(temporary, JSON.stringify(value)).then(() => rename(temporary, file));
}

export function renderInWorker(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./render-worker.js', import.meta.url), { workerData: input });
    let replied = false;
    worker.once('message', message => {
      replied = true;
      if (message?.ok) resolve(message.manifest);
      else reject(new Error(message?.error ?? 'Map rendering worker failed.'));
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0 && !replied) reject(new Error(`Map rendering worker exited (${code}).`)); });
  });
}

/** An immutable geometry snapshot is rendered, then exposed through one atomic pointer swap. */
export function createGenerationService({ dataDir, renderer, assetsDir }) {
  const queue = new SaveQueue();
  const releasesDir = path.join(dataDir, 'releases');

  async function save(snapshot) {
    return queue.enqueue(snapshot.revision, async ({ isLatest, progress }) => {
      if (!assetsDir) throw new Error('Minecraft assets are not configured. Upload the matching client JAR and retry Save.');
      await mkdir(releasesDir, { recursive: true });
      try {
        const pointer = JSON.parse(await readFile(path.join(releasesDir, 'current.json'), 'utf8'));
        if (pointer.revision > snapshot.revision) throw new Error('Stale revision; reload and retry your edit.');
        if (pointer.revision === snapshot.revision) return { revision: snapshot.revision, reused: true };
      } catch (error) { if (error.message.startsWith('Stale revision')) throw error; }
      const tempName = `.building-${snapshot.revision}-${randomUUID()}`;
      const temporary = path.join(releasesDir, tempName);
      const final = path.join(releasesDir, `revision-${snapshot.revision}`);
      await mkdir(temporary, { recursive: false });
      try {
        const floors = [];
        for (let index = 0; index < snapshot.floors.length; index++) {
          const floor = snapshot.floors[index];
          progress(`Rendering ${floor.name}`, Math.floor(index / Math.max(1, snapshot.floors.length) * 85));
          const output = `${floor.id}.png`;
          const rendered = await renderer.render({ schematic: { dimensions: floor.dimensions, blocks: floor.blocks }, assets: assetsDir, output: path.join(temporary, output) });
          const outputPath = path.join(temporary, output);
          const [info, signature] = await Promise.all([stat(outputPath), readFile(outputPath).then(bytes => bytes.subarray(0, 8))]);
          if (info.size < 24 || !signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || !Number.isSafeInteger(rendered?.width) || rendered.width < 1 || !Number.isSafeInteger(rendered?.height) || rendered.height < 1) {
            throw new Error(`Renderer produced invalid PNG output for floor ${floor.name}.`);
          }
          floors.push({ id: floor.id, name: floor.name, image: output, coordinateOrigin: floor.coordinateOrigin, sections: floor.sections, markers: floor.markers ?? [], connections: floor.connections ?? [], ...rendered });
        }
        progress('Writing revision snapshot', 90);
        const manifest = { manifestVersion: 1, projectRevision: snapshot.revision, generatedAt: new Date().toISOString(), floors };
        await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2));
        await writeFile(path.join(temporary, 'project.json'), JSON.stringify(snapshot));
        if (!isLatest()) throw new Error('Save superseded by a newer project revision.');
        await rm(final, { recursive: true, force: true });
        await rename(temporary, final);
        if (!isLatest()) throw new Error('Save superseded by a newer project revision.');
        await atomicJson(path.join(releasesDir, 'current.json'), { revision: snapshot.revision, directory: `revision-${snapshot.revision}` });
        progress('Saved', 100);
        return { revision: snapshot.revision, floors: floors.length };
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    });
  }

  /** Publish marker-only metadata into a new immutable release while reusing its terrain PNGs. */
  async function saveMetadata(snapshot) {
    return queue.enqueue(snapshot.revision, async ({ isLatest, progress }) => {
      await mkdir(releasesDir, { recursive: true });
      const pointer = JSON.parse(await readFile(path.join(releasesDir, 'current.json'), 'utf8'));
      if (pointer.revision >= snapshot.revision) throw new Error('Stale revision; reload and retry your edit.');
      const previousDir = path.join(releasesDir, pointer.directory);
      const previousProject = JSON.parse(await readFile(path.join(previousDir, 'project.json'), 'utf8'));
      const geometry = value => (value.floors ?? []).map(({ id, dimensions, blocks, sections }) => ({ id, dimensions, blocks, sections }));
      if (JSON.stringify(geometry(previousProject)) !== JSON.stringify(geometry(snapshot))) throw new Error('Geometry has not been saved yet. Save the complete project before marker changes.');
      const previousManifest = JSON.parse(await readFile(path.join(previousDir, 'manifest.json'), 'utf8'));
      const tempName = `.building-${snapshot.revision}-${randomUUID()}`;
      const temporary = path.join(releasesDir, tempName);
      const final = path.join(releasesDir, `revision-${snapshot.revision}`);
      await mkdir(temporary, { recursive: false });
      try {
        const floors = [];
        for (const oldFloor of previousManifest.floors) {
          const floor = snapshot.floors.find(item => item.id === oldFloor.id);
          if (!floor) throw new Error('Metadata-only save cannot change the floor list.');
          await copyFile(path.join(previousDir, oldFloor.image), path.join(temporary, oldFloor.image));
          floors.push({ ...oldFloor, sections: floor.sections, markers: floor.markers ?? [], connections: floor.connections ?? [] });
        }
        if (!isLatest()) throw new Error('Save superseded by a newer project revision.');
        progress('Writing metadata revision', 90);
        const manifest = { ...previousManifest, projectRevision: snapshot.revision, generatedAt: new Date().toISOString(), floors };
        await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2));
        await writeFile(path.join(temporary, 'project.json'), JSON.stringify(snapshot));
        await rm(final, { recursive: true, force: true });
        await rename(temporary, final);
        if (!isLatest()) throw new Error('Save superseded by a newer project revision.');
        await atomicJson(path.join(releasesDir, 'current.json'), { revision: snapshot.revision, directory: `revision-${snapshot.revision}` });
        progress('Saved', 100);
        return { revision: snapshot.revision, floors: floors.length, rendered: false };
      } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
    });
  }

  async function currentManifest(floorId) {
    const pointer = JSON.parse(await readFile(path.join(releasesDir, 'current.json'), 'utf8'));
    if (!/^revision-[0-9]+$/.test(pointer.directory) || Number(pointer.directory.slice(9)) !== pointer.revision) throw new Error('Invalid saved revision pointer');
    const manifest = JSON.parse(await readFile(path.join(releasesDir, pointer.directory, 'manifest.json'), 'utf8'));
    if (manifest.projectRevision !== pointer.revision) throw new Error('Saved map revision is inconsistent');
    if (floorId) {
      const floor = manifest.floors.find(item => item.id === floorId);
      if (!floor) throw new Error('Floor does not exist in the saved map.');
      return { ...floor, projectRevision: manifest.projectRevision, generatedAt: manifest.generatedAt };
    }
    return manifest;
  }
  return { queue, save, saveMetadata, currentManifest, releasesDir };
}
