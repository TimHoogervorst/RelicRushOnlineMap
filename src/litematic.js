import { gunzipSync } from 'node:zlib';

class NbtReader {
  constructor(buffer) { this.buffer = buffer; this.offset = 0; }
  need(n) { if (this.offset + n > this.buffer.length) throw new Error('Truncated NBT data'); }
  u8() { this.need(1); return this.buffer.readUInt8(this.offset++); }
  i8() { this.need(1); return this.buffer.readInt8(this.offset++); }
  i16() { this.need(2); const v = this.buffer.readInt16BE(this.offset); this.offset += 2; return v; }
  i32() { this.need(4); const v = this.buffer.readInt32BE(this.offset); this.offset += 4; return v; }
  i64() { this.need(8); const v = this.buffer.readBigInt64BE(this.offset); this.offset += 8; return v; }
  f32() { this.need(4); const v = this.buffer.readFloatBE(this.offset); this.offset += 4; return v; }
  f64() { this.need(8); const v = this.buffer.readDoubleBE(this.offset); this.offset += 8; return v; }
  string() { const n = this.i16(); this.need(n); const v = this.buffer.toString('utf8', this.offset, this.offset + n); this.offset += n; return v; }
  payload(type, depth = 0) {
    if (depth > 64) throw new Error('NBT nesting limit exceeded');
    switch (type) {
      case 1: return this.i8();
      case 2: return this.i16();
      case 3: return this.i32();
      case 4: return this.i64();
      case 5: return this.f32();
      case 6: return this.f64();
      case 7: { const n = this.i32(); this.bound(n); this.need(n); const v = this.buffer.subarray(this.offset, this.offset + n); this.offset += n; return v; }
      case 8: return this.string();
      case 9: { const subtype = this.u8(), n = this.i32(); this.bound(n); return Array.from({ length: n }, () => this.payload(subtype, depth + 1)); }
      case 10: {
        const result = {};
        while (true) { const childType = this.u8(); if (!childType) return result; const name = this.string(); result[name] = this.payload(childType, depth + 1); }
      }
      case 11: { const n = this.i32(); this.bound(n); const out = new Int32Array(n); for (let i = 0; i < n; i++) out[i] = this.i32(); return out; }
      case 12: { const n = this.i32(); this.bound(n); const out = new BigInt64Array(n); for (let i = 0; i < n; i++) out[i] = this.i64(); return out; }
      default: throw new Error(`Unsupported NBT tag type ${type}`);
    }
  }
  bound(n) { if (!Number.isInteger(n) || n < 0 || n > 16_000_000) throw new Error(`Invalid NBT array/list length ${n}`); }
  root() { const type = this.u8(); if (type !== 10) throw new Error('Litematic root must be an NBT compound'); this.string(); return this.payload(type); }
}

export function unpackPaletteIndices(longArray, count, bits) {
  if (bits < 1 || bits > 32) throw new Error(`Invalid palette width ${bits}`);
  if (count > 16_000_000) throw new Error('Block count exceeds import limit');
  const mask = (1n << BigInt(bits)) - 1n;
  const words = Array.from(longArray, value => BigInt.asUintN(64, BigInt(value)));
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const bit = BigInt(i * bits), word = Number(bit >> 6n), shift = bit & 63n;
    if (word >= words.length) throw new Error('Packed block state array is too short');
    let value = words[word] >> shift;
    if (shift + BigInt(bits) > 64n) {
      if (word + 1 >= words.length) throw new Error('Packed block state crosses a missing long');
      value |= words[word + 1] << (64n - shift);
    }
    indices[i] = Number(value & mask);
  }
  return indices;
}

function int(tag, label) { const v = Number(tag); if (!Number.isSafeInteger(v)) throw new Error(`Invalid ${label}`); return v; }
function vec3(nbt, label) { return { x: int(nbt?.x, `${label}.x`), y: int(nbt?.y, `${label}.y`), z: int(nbt?.z, `${label}.z`) }; }

export function decodeLitematic(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > 128 * 1024 * 1024) throw new Error('Compressed Litematic exceeds 128 MiB import limit');
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }) : bytes;
  const root = new NbtReader(raw).root();
  const data = root.Metadata ? root : root;
  if (!data.Regions || typeof data.Regions !== 'object') throw new Error('Litematic is missing Regions');
  const regions = [];
  const allBlocks = [];
  const chests = [];
  for (const [regionName, region] of Object.entries(data.Regions)) {
    const position = vec3(region.Position, `${regionName} position`);
    const signedSize = vec3(region.Size, `${regionName} size`);
    const dimensions = { x: Math.abs(signedSize.x), y: Math.abs(signedSize.y), z: Math.abs(signedSize.z) };
    const volume = dimensions.x * dimensions.y * dimensions.z;
    if (!volume || volume > 16_000_000) throw new Error(`Invalid region dimensions for ${regionName}`);
    const palette = (region.BlockStatePalette ?? []).map(entry => {
      const id = entry.Name;
      if (typeof id !== 'string' || !id.includes(':')) throw new Error('Invalid namespaced block in palette');
      return { id, properties: entry.Properties ?? {} };
    });
    if (!palette.length) throw new Error(`Region ${regionName} has an empty palette`);
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const packed = region.BlockStates;
    const indices = unpackPaletteIndices(packed, volume, bits);
    const min = { x: position.x + Math.min(0, signedSize.x), y: position.y + Math.min(0, signedSize.y), z: position.z + Math.min(0, signedSize.z) };
    const blocks = [];
    // Litematica stores X fastest, then Z, then Y. Negative extents are normalized to min coordinates.
    for (let i = 0; i < volume; i++) {
      const index = indices[i];
      if (index >= palette.length) throw new Error(`Palette index ${index} exceeds palette size ${palette.length}`);
      const x0 = i % dimensions.x;
      const z0 = Math.floor(i / dimensions.x) % dimensions.z;
      const y0 = Math.floor(i / (dimensions.x * dimensions.z));
      // Palette storage uses normalized local indices even when the region's signed
      // extent is negative. Position+Size still supplies the absolute minimum.
      const x = min.x + x0;
      const y = min.y + y0;
      const z = min.z + z0;
      const state = palette[index];
      if (state.id !== 'minecraft:air' && state.id !== 'minecraft:cave_air' && state.id !== 'minecraft:void_air') {
        const block = { x: x - min.x, y: y - min.y, z: z - min.z, id: state.id, properties: state.properties };
        blocks.push(block); allBlocks.push({ ...block, region: regionName });
        if (state.id.endsWith('_chest') || state.id === 'minecraft:chest') chests.push({ x: block.x, y: block.y, z: block.z });
      }
    }
    const blockEntities = (region.TileEntities ?? []).map(entity => ({ ...entity }));
    regions.push({ name: regionName, position, signedSize, min, dimensions, palette, blocks, blockEntities });
  }
  const version = int(data.Version, 'Litematic version');
  const subVersion = int(data.SubVersion ?? 0, 'Litematic subversion');
  const dataVersion = int(data.MinecraftDataVersion, 'Minecraft data version');
  const first = regions.length === 1 ? regions[0] : null;
  const dimensions = first?.dimensions ?? regions.reduce((acc, r) => ({ x: Math.max(acc.x, r.dimensions.x), y: Math.max(acc.y, r.dimensions.y), z: Math.max(acc.z, r.dimensions.z) }), { x: 0, y: 0, z: 0 });
  return { version, subVersion, dataVersion, regions, dimensions, blocks: allBlocks, chests };
}
