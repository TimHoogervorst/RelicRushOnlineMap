import { inflateRawSync } from 'node:zlib';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function zipEntries(jar, maxEntries = 100000, maxEntryBytes = 16 * 1024 * 1024, resourcePack = false) {
  const eocd = jar.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Minecraft asset input is not a ZIP/JAR archive');
  const count = jar.readUInt16LE(eocd + 10), centralStart = jar.readUInt32LE(eocd + 16);
  if (!count || count > maxEntries || centralStart >= eocd) throw new Error('Minecraft asset archive has an invalid central directory');
  const entries = [];
  const names = new Set();
  let offset = centralStart;
  for (let i = 0; i < count; i++) {
    if (jar.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const flags = jar.readUInt16LE(offset + 8), method = jar.readUInt16LE(offset + 10), compressedSize = jar.readUInt32LE(offset + 20), size = jar.readUInt32LE(offset + 24);
    const nameLength = jar.readUInt16LE(offset + 28), extraLength = jar.readUInt16LE(offset + 30), commentLength = jar.readUInt16LE(offset + 32);
    const name = jar.toString('utf8', offset + 46, offset + 46 + nameLength), localOffset = jar.readUInt32LE(offset + 42);
    if ((name === 'version.json' || resourcePack && name === 'pack.mcmeta' || /^assets\/minecraft\/(items\/|blockstates\/|models\/(block|item)\/|textures\/(block|item)\/)/.test(name)) && !name.endsWith('/')) {
      if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').some(part => part === '..' || part === '.')) throw new Error(`Unsafe resource path in asset archive: ${name}`);
      if (names.has(name)) throw new Error(`Duplicate resource path in asset archive: ${name}`);
      names.add(name);
      if (size > maxEntryBytes || compressedSize > jar.length || localOffset + 30 > jar.length || localOffset >= centralStart || method !== 0 && method !== 8 || flags & 1) throw new Error(`Minecraft asset entry exceeds archive limits: ${name}`);
      if (jar.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid local ZIP header for ${name}`);
      const localNameLength = jar.readUInt16LE(localOffset + 26), localExtraLength = jar.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > centralStart) throw new Error(`Truncated resource data for ${name}`);
      entries.push({ name: name === 'version.json' || name === 'pack.mcmeta' ? name : name.slice('assets/minecraft/'.length), method, compressedSize, size, dataStart });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function extractResourcePack(packPath, outputDir, limits = {}) {
  const { maxArchiveBytes = 128 * 1024 * 1024, maxEntryBytes = 16 * 1024 * 1024, maxExpandedBytes = 256 * 1024 * 1024, maxEntries = 100000 } = limits;
  const archive = await readFile(packPath);
  if (archive.length > maxArchiveBytes) throw new Error('Resource pack exceeds the 128 MiB compressed limit.');
  const entries = zipEntries(archive, maxEntries, maxEntryBytes, true);
  const metadataEntry = entries.find(entry => entry.name === 'pack.mcmeta');
  if (!metadataEntry) throw new Error('Resource pack is missing pack.mcmeta.');
  const decode = entry => {
    const compressed = archive.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    const data = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
    if (data.length !== entry.size) throw new Error(`Invalid resource pack entry ${entry.name}.`);
    return data;
  };
  const mcmeta = JSON.parse(decode(metadataEntry).toString('utf8'));
  const packFormat = mcmeta.pack?.pack_format;
  if (!Number.isSafeInteger(packFormat) || packFormat < 1) throw new Error('Resource pack has invalid pack_format metadata.');
  const unique = randomUUID(), stage = `${outputDir}.staging-${unique}`;
  await mkdir(stage, { recursive: true });
  try {
    let expanded = 0;
    for (const entry of entries.filter(item => item.name !== 'pack.mcmeta')) {
      expanded += entry.size;
      if (expanded > maxExpandedBytes) throw new Error('Expanded resource pack exceeds the 256 MiB limit.');
      const output = path.join(stage, entry.name);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, decode(entry), { mode: 0o600 });
    }
    const metadata = { packFormat, description: String(mcmeta.pack.description ?? '').slice(0, 500), sourceName: path.basename(packPath), sha256: createHash('sha256').update(archive).digest('hex'), entries: entries.length - 1 };
    await writeFile(path.join(stage, 'resource-pack-source.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
    await chmod(stage, 0o700);
    const previous = `${outputDir}.previous-${unique}`;
    try {
      try { await rename(outputDir, previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(stage, outputDir);
      await rm(previous, { recursive: true, force: true });
    } catch (error) { try { await rename(previous, outputDir); } catch {} throw error; }
    return metadata;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

export async function extractMatchingAssets(jarPath, outputDir, expectedVersion = '26.3', limits = {}) {
  const { maxArchiveBytes = 128 * 1024 * 1024, maxEntryBytes = 16 * 1024 * 1024, maxExpandedBytes = 512 * 1024 * 1024, maxEntries = 100000 } = limits;
  const archive = await readFile(jarPath);
  if (archive.length > maxArchiveBytes) throw new Error(`Minecraft asset archive exceeds ${(maxArchiveBytes / 1024 / 1024).toLocaleString()} MiB compressed limit`);
  const entries = zipEntries(archive, maxEntries, maxEntryBytes);
  const versionEntry = entries.find(entry => entry.name === 'version.json');
  if (!versionEntry) throw new Error('Minecraft client archive is missing version.json');
  if (versionEntry.method !== 0 && versionEntry.method !== 8) throw new Error('Minecraft version metadata uses an unsupported compression method');
  const versionBytes = archive.subarray(versionEntry.dataStart, versionEntry.dataStart + versionEntry.compressedSize);
  const versionJson = JSON.parse((versionEntry.method === 0 ? versionBytes : inflateRawSync(versionBytes, { maxOutputLength: 64 * 1024 })).toString('utf8'));
  if (versionJson.id !== expectedVersion || versionJson.world_version !== 5023) throw new Error(`Expected Minecraft ${expectedVersion} / world version 5023 assets; received ${versionJson.id} / ${versionJson.world_version}`);
  const required = ['blockstates/stone.json', 'models/block/stone.json', 'textures/block/stone.png', 'textures/item/diamond.png'];
  for (const item of required) if (!entries.some(entry => entry.name === item)) throw new Error(`Minecraft asset archive is missing ${item}`);
  const unique = randomUUID();
  const stage = `${outputDir}.staging-${unique}`;
  await mkdir(stage, { recursive: true });
  try {
    let expandedBytes = 0;
    for (const entry of entries.filter(entry => entry.name !== 'version.json')) {
      expandedBytes += entry.size;
      if (expandedBytes > maxExpandedBytes) throw new Error(`Expanded Minecraft assets exceed ${(maxExpandedBytes / 1024 / 1024).toLocaleString()} MiB limit`);
      const compressed = archive.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
      const data = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }) : null;
      if (!data || data.length !== entry.size) throw new Error(`Invalid compressed Minecraft asset ${entry.name}`);
      const output = path.join(stage, entry.name);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, data, { mode: 0o600 });
    }
    const metadata = { minecraftVersion: versionJson.id, worldVersion: versionJson.world_version, sourceName: path.basename(jarPath), sha256: createHash('sha256').update(archive).digest('hex'), blockStates: entries.filter(e => e.name.startsWith('blockstates/')).length, blockModels: entries.filter(e => e.name.startsWith('models/block/')).length, blockTextures: entries.filter(e => e.name.startsWith('textures/block/')).length, itemDefinitions: entries.filter(e => e.name.startsWith('items/')).length, itemTextures: entries.filter(e => e.name.startsWith('textures/item/')).length };
    await writeFile(path.join(stage, 'asset-source.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
    await chmod(stage, 0o700);
    const previous = `${outputDir}.previous-${unique}`;
    try {
      try { await rename(outputDir, previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(stage, outputDir);
      await rm(previous, { recursive: true, force: true });
    } catch (error) {
      try { await rename(previous, outputDir); } catch {}
      throw error;
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  return JSON.parse(await readFile(path.join(outputDir, 'asset-source.json'), 'utf8'));
}
