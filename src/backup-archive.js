import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
function crc32(data) { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function safePath(name) { return typeof name === 'string' && name.length > 0 && name.length <= 512 && !name.startsWith('/') && !name.includes('\\') && !/^[A-Za-z]:/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'); }

export function createArchive(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, raw] of files) {
    if (!safePath(name)) throw new Error(`Unsafe backup path: ${name}`);
    const filename = Buffer.from(name, 'utf8'), data = Buffer.from(raw), compressed = deflateRawSync(data, { level: 6 }), crc = crc32(data);
    const local = Buffer.alloc(30 + filename.length); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26); filename.copy(local, 30); locals.push(local, compressed);
    const central = Buffer.alloc(46 + filename.length); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((0o100600 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42); filename.copy(central, 46); centrals.push(central); offset += local.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(centrals.length, 8); end.writeUInt16LE(centrals.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

export function readArchive(bytes, { maxArchiveBytes = 1024 * 1024 * 1024, maxEntries = 150000, maxEntryBytes = 512 * 1024 * 1024, maxTotalBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > maxArchiveBytes) throw new Error('Backup ZIP exceeds its archive limit or is invalid.');
  let end = -1; for (let p = Math.max(0, bytes.length - 65557); p <= bytes.length - 22; p++) if (bytes.readUInt32LE(p) === 0x06054b50) end = p;
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error('Backup ZIP directory is invalid.');
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
  if (!count || count > Math.min(maxEntries, 65535) || directoryOffset + directorySize > end || directoryOffset + directorySize !== end) throw new Error('Backup ZIP has invalid entry bounds.');
  const files = new Map(); let cursor = directoryOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Backup ZIP directory entry is invalid.');
    const madeBy = bytes.readUInt16LE(cursor + 4), flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), external = bytes.readUInt32LE(cursor + 38), localOffset = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > end || flags & 1 || flags & 8 || ![0, 8].includes(method) || size > maxEntryBytes || (madeBy >> 8) === 3 && (((external >>> 16) & 0xf000) === 0xa000)) throw new Error('Backup ZIP contains an unsupported or oversized entry.');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'); if (!safePath(name) || files.has(name)) throw new Error(`Backup ZIP has an unsafe or duplicate path: ${name}`);
    if (localOffset + 30 > directoryOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Backup ZIP local entry is invalid.');
    const localName = bytes.readUInt16LE(localOffset + 26), localExtra = bytes.readUInt16LE(localOffset + 28), dataStart = localOffset + 30 + localName + localExtra;
    if (!bytes.subarray(localOffset + 30, localOffset + 30 + localName).equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength)) || dataStart + compressedSize > directoryOffset) throw new Error('Backup ZIP data bounds are invalid.');
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize); let data;
    try { data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: maxEntryBytes }); } catch { throw new Error(`Backup ZIP entry cannot be decoded: ${name}`); }
    if (data.length !== size || crc32(data) !== crc) throw new Error(`Backup ZIP checksum is invalid: ${name}`);
    total += data.length; if (total > maxTotalBytes) throw new Error('Backup ZIP exceeds the decoded size limit.');
    files.set(name, data); cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== directoryOffset + directorySize) throw new Error('Backup ZIP directory length is inconsistent.');
  return files;
}

export function makeManifest(files) {
  return { format: 'rr-map-project-backup', formatVersion: 1, createdAt: new Date().toISOString(), entries: [...files].map(([path, data]) => ({ path, size: data.length, sha256: createHash('sha256').update(data).digest('hex') })).sort((a, b) => a.path.localeCompare(b.path)) };
}

export function validateManifest(files) {
  let manifest; try { manifest = JSON.parse(files.get('manifest.json')?.toString('utf8')); } catch { throw new Error('Backup manifest is missing or invalid.'); }
  if (manifest.format !== 'rr-map-project-backup' || manifest.formatVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > 150000) throw new Error('Backup format version is unsupported.');
  if (manifest.entries.length !== files.size - 1) throw new Error('Backup manifest file list does not match the archive.');
  const seen = new Set();
  for (const entry of manifest.entries) {
    const data = files.get(entry.path); if (!safePath(entry.path) || seen.has(entry.path) || !data || data.length !== entry.size || createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error(`Backup checksum validation failed for ${entry.path}.`);
    seen.add(entry.path);
  }
  if ([...files.keys()].some(name => name !== 'manifest.json' && !seen.has(name))) throw new Error('Backup manifest omits one or more archive files.');
  if (!files.has('project.sqlite')) throw new Error('Backup is missing project.sqlite.');
  return manifest;
}
