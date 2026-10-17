import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

function zipEntries(jar) {
  const eocd = jar.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Minecraft asset input is not a ZIP/JAR archive');
  const count = jar.readUInt16LE(eocd + 10), centralStart = jar.readUInt32LE(eocd + 16);
  const entries = [];
  let offset = centralStart;
  for (let i = 0; i < count; i++) {
    if (jar.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const method = jar.readUInt16LE(offset + 10), compressedSize = jar.readUInt32LE(offset + 20), size = jar.readUInt32LE(offset + 24);
    const nameLength = jar.readUInt16LE(offset + 28), extraLength = jar.readUInt16LE(offset + 30), commentLength = jar.readUInt16LE(offset + 32);
    const name = jar.toString('utf8', offset + 46, offset + 46 + nameLength), localOffset = jar.readUInt32LE(offset + 42);
    if ((name === 'version.json' || /^assets\/minecraft\/(blockstates\/|models\/|textures\/block\/)/.test(name)) && !name.endsWith('/')) {
      if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.includes('..')) throw new Error(`Unsafe resource path in asset archive: ${name}`);
      const localNameLength = jar.readUInt16LE(localOffset + 26), localExtraLength = jar.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      entries.push({ name: name === 'version.json' ? name : name.slice('assets/minecraft/'.length), method, compressedSize, size, dataStart });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function extractMatchingAssets(jarPath, outputDir, expectedVersion = '26.3') {
  const archive = await readFile(jarPath);
  if (archive.length > 512 * 1024 * 1024) throw new Error('Minecraft asset archive exceeds 512 MiB limit');
  const entries = zipEntries(archive);
  const versionEntry = entries.find(entry => entry.name === 'version.json');
  if (!versionEntry) throw new Error('Minecraft client archive is missing version.json');
  const versionBytes = archive.subarray(versionEntry.dataStart, versionEntry.dataStart + versionEntry.compressedSize);
  const versionJson = JSON.parse((versionEntry.method === 0 ? versionBytes : inflateRawSync(versionBytes)).toString('utf8'));
  if (versionJson.id !== expectedVersion || versionJson.world_version !== 5023) throw new Error(`Expected Minecraft ${expectedVersion} / world version 5023 assets; received ${versionJson.id} / ${versionJson.world_version}`);
  const required = ['blockstates/stone.json', 'models/block/stone.json', 'textures/block/stone.png'];
  for (const item of required) if (!entries.some(entry => entry.name === item)) throw new Error(`Minecraft asset archive is missing ${item}`);
  const stage = `${outputDir}.staging-${process.pid}`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    for (const entry of entries.filter(entry => entry.name !== 'version.json')) {
      const compressed = archive.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
      const data = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }) : null;
      if (!data || data.length !== entry.size) throw new Error(`Invalid compressed Minecraft asset ${entry.name}`);
      const output = path.join(stage, entry.name);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, data);
    }
    await writeFile(path.join(stage, 'asset-source.json'), JSON.stringify({ minecraftVersion: versionJson.id, worldVersion: versionJson.world_version, sourceName: path.basename(jarPath), sha256: createHash('sha256').update(archive).digest('hex'), blockStates: entries.filter(e => e.name.startsWith('blockstates/')).length, blockModels: entries.filter(e => e.name.startsWith('models/block/')).length, blockTextures: entries.filter(e => e.name.startsWith('textures/block/')).length }, null, 2));
    await rm(outputDir, { recursive: true, force: true });
    await rename(stage, outputDir);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  return JSON.parse(await readFile(path.join(outputDir, 'asset-source.json'), 'utf8'));
}
