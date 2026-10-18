import path from 'node:path';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { SaveQueue } from './save-queue.js';

const GENERATOR_VERSION = '2';
const DEFAULT_HIDDEN_BLOCKS = new Set(['minecraft:brown_mushroom_block', 'minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:glow_lichen', 'minecraft:decorated_pot', 'minecraft:seagrass']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function projectHash(snapshot) {
  const { revision: _revision, ...content } = snapshot;
  return sha256(content);
}

function renderSettings(snapshot) {
  return (snapshot.floors ?? []).map(floor => ({
    id: floor.id,
    renderOptions: floor.renderOptions ?? {},
    sections: (floor.sections ?? []).map(section => ({ id: section.id, renderSettings: section.renderSettings ?? {} })).sort((a, b) => a.id.localeCompare(b.id)),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

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

  async function assetFingerprint() {
    let vanilla = null, resourcePack = null;
    try { vanilla = JSON.parse(await readFile(path.join(assetsDir, 'asset-source.json'), 'utf8')); } catch {}
    try { resourcePack = JSON.parse(await readFile(path.join(path.dirname(assetsDir), 'resource-pack', 'resource-pack-source.json'), 'utf8')); } catch {}
    const assetVersion = { minecraft: vanilla?.minecraftVersion ?? null, world: vanilla?.worldVersion ?? null, resourcePack: resourcePack?.packFormat ?? null };
    const assetHash = sha256({ vanilla: vanilla?.sha256 ?? null, resourcePack: resourcePack?.sha256 ?? null });
    return { assetVersion, assetHash };
  }

  async function save(snapshot) {
    return queue.enqueue(snapshot.revision, async ({ isLatest, progress }) => {
      if (!assetsDir) throw new Error('Minecraft assets are not configured. Upload the matching client JAR and retry Save.');
      await mkdir(releasesDir, { recursive: true });
      try {
        const pointer = JSON.parse(await readFile(path.join(releasesDir, 'current.json'), 'utf8'));
        if (pointer.revision > snapshot.revision) throw new Error('Stale revision; reload and retry your edit.');
        if (pointer.revision === snapshot.revision) {
          try {
            const currentManifest = JSON.parse(await readFile(path.join(releasesDir, pointer.directory, 'manifest.json'), 'utf8'));
            if (currentManifest.generatorVersion === GENERATOR_VERSION) return { revision: snapshot.revision, reused: true };
          } catch { /* Rebuild an incomplete or older release below. */ }
        }
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
          const sections = new Map((floor.sections ?? []).map(section => [section.id, section]));
          const blocks = floor.blocks.filter(block => {
            const settings = sections.get(block.sectionId)?.renderSettings ?? {};
            if (DEFAULT_HIDDEN_BLOCKS.has(block.id) || (settings.excludedBlocks ?? []).includes(block.id)) return false;
            const x = block.localX ?? block.x, y = block.localY ?? block.y, z = block.localZ ?? block.z;
            return !(settings.cutaways ?? []).some(box => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height && z >= box.z && z < box.z + box.depth);
          }).map(({ sectionId, localX, localY, localZ, ...block }) => block);
          const settings = floor.renderOptions ?? floor.sections?.[0]?.renderSettings ?? {};
          const rendered = await renderer.render({ schematic: { dimensions: floor.dimensions, blocks }, assets: assetsDir, output: path.join(temporary, output), pixelSize: settings.pixelSize ?? 16, heightShadePerBlock: settings.heightShadePerBlock ?? 0.018, assetOverrides: assetsDir ? [path.join(path.dirname(assetsDir), 'resource-pack')] : [] });
          const outputPath = path.join(temporary, output);
          const [info, signature] = await Promise.all([stat(outputPath), readFile(outputPath).then(bytes => bytes.subarray(0, 8))]);
          if (info.size < 24 || !signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || !Number.isSafeInteger(rendered?.width) || rendered.width < 1 || !Number.isSafeInteger(rendered?.height) || rendered.height < 1) {
            throw new Error(`Renderer produced invalid PNG output for floor ${floor.name}.`);
          }
          const heightGridPath = `${floor.id}-height-grid.json`;
          const heightGrid = rendered.heightGrid ?? { width: floor.dimensions.x, depth: floor.dimensions.z, values: Array.from({ length: floor.dimensions.z }, () => Array(floor.dimensions.x).fill(null)) };
          if (heightGrid.width !== floor.dimensions.x || heightGrid.depth !== floor.dimensions.z || !Array.isArray(heightGrid.values) || heightGrid.values.length !== heightGrid.depth || heightGrid.values.some(row => !Array.isArray(row) || row.length !== heightGrid.width || row.some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value))))) {
            throw new Error(`Renderer produced an invalid height grid for floor ${floor.name}.`);
          }
          await writeFile(path.join(temporary, heightGridPath), JSON.stringify({ format: 'rr-map-surface-height-grid', version: 1, projectRevision: snapshot.revision, floorId: floor.id, coordinateOrigin: floor.coordinateOrigin, xAxis: 'east', zAxis: 'south', rowOrder: 'z-ascending', values: heightGrid.values }));
          floors.push({ id: floor.id, name: floor.name, image: output, heightGrid: { path: heightGridPath, width: heightGrid.width, depth: heightGrid.depth, projectRevision: snapshot.revision }, coordinateOrigin: floor.coordinateOrigin, sections: floor.sections, markers: floor.markers ?? [], markerTypes: floor.markerTypes ?? [], connections: floor.connections ?? [], ...rendered, heightGrid: { path: heightGridPath, width: heightGrid.width, depth: heightGrid.depth, projectRevision: snapshot.revision } });
        }
        progress('Writing revision snapshot', 90);
        let resourcePack = null;
        try { resourcePack = JSON.parse(await readFile(path.join(path.dirname(assetsDir), 'resource-pack', 'resource-pack-source.json'), 'utf8')); } catch {}
        const assets = await assetFingerprint();
        const manifest = { manifestVersion: 1, generatorVersion: GENERATOR_VERSION, projectRevision: snapshot.revision, projectHash: projectHash(snapshot), assetVersion: assets.assetVersion, assetHash: assets.assetHash, renderSettingsHash: sha256(renderSettings(snapshot)), generatedAt: new Date().toISOString(), resourcePack, floors };
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
          if (oldFloor.heightGrid?.path) await copyFile(path.join(previousDir, oldFloor.heightGrid.path), path.join(temporary, oldFloor.heightGrid.path));
          floors.push({ ...oldFloor, name: floor.name, sortOrder: floor.sortOrder, sections: floor.sections, markers: floor.markers ?? [], markerTypes: floor.markerTypes ?? [], connections: floor.connections ?? [] });
        }
        if (!isLatest()) throw new Error('Save superseded by a newer project revision.');
        progress('Writing metadata revision', 90);
        floors.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
        const manifest = { ...previousManifest, projectRevision: snapshot.revision, projectHash: projectHash(snapshot), generatedAt: new Date().toISOString(), floors };
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
