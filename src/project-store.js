import Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { decodeLitematic } from './litematic.js';

const CHUNK_SIZE = 16;
const localIndex = (x, y, z) => (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;

export function encodeSectionChunks(blocks, blockEntities = []) {
  const grouped = new Map();
  for (const block of blocks) {
    const cx = Math.floor(block.x / CHUNK_SIZE), cy = Math.floor(block.y / CHUNK_SIZE), cz = Math.floor(block.z / CHUNK_SIZE);
    const key = `${cx},${cy},${cz}`;
    if (!grouped.has(key)) grouped.set(key, { cx, cy, cz, states: new Map([['minecraft:air|{}', { id: 'minecraft:air', properties: {} }]]), cells: [], blockEntities: [] });
    grouped.get(key).cells.push(block);
  }
  for (const entity of blockEntities) {
    if (![entity.x, entity.y, entity.z].every(Number.isSafeInteger)) continue;
    const cx = Math.floor(entity.x / CHUNK_SIZE), cy = Math.floor(entity.y / CHUNK_SIZE), cz = Math.floor(entity.z / CHUNK_SIZE);
    const key = `${cx},${cy},${cz}`;
    if (!grouped.has(key)) grouped.set(key, { cx, cy, cz, states: new Map([['minecraft:air|{}', { id: 'minecraft:air', properties: {} }]]), cells: [], blockEntities: [] });
    grouped.get(key).blockEntities.push(entity);
  }
  return [...grouped.values()].map(chunk => {
    const palette = [...chunk.states.values()];
    const indices = new Array(4096).fill(0);
    for (const block of chunk.cells) {
      const stateKey = `${block.id}|${JSON.stringify(block.properties ?? {})}`;
      let paletteIndex = palette.findIndex(state => `${state.id}|${JSON.stringify(state.properties)}` === stateKey);
      if (paletteIndex < 0) { paletteIndex = palette.length; palette.push({ id: block.id, properties: block.properties ?? {} }); }
      const lx = ((block.x % 16) + 16) % 16, ly = ((block.y % 16) + 16) % 16, lz = ((block.z % 16) + 16) % 16;
      indices[localIndex(lx, ly, lz)] = paletteIndex;
    }
    return { cx: chunk.cx, cy: chunk.cy, cz: chunk.cz, compressed: gzipSync(Buffer.from(JSON.stringify({ version: 1, palette, indices, blockEntities: chunk.blockEntities }))) };
  });
}

export function decodeChunkBlob(blob) {
  const chunk = JSON.parse(gunzipSync(blob, { maxOutputLength: 1024 * 1024 }).toString('utf8'));
  if (chunk.version !== 1 || !Array.isArray(chunk.palette) || chunk.palette[0]?.id !== 'minecraft:air' || !Array.isArray(chunk.indices) || chunk.indices.length !== 4096) {
    throw new Error('Invalid section chunk blob');
  }
  for (const index of chunk.indices) if (!Number.isInteger(index) || index < 0 || index >= chunk.palette.length) throw new Error('Chunk palette index is out of range');
  return chunk;
}

export function openProject(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS floors (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, floor_id TEXT NOT NULL REFERENCES floors(id), name TEXT NOT NULL, bounds_json TEXT NOT NULL, placement_x INTEGER NOT NULL DEFAULT 0, placement_z INTEGER NOT NULL DEFAULT 0, label_x REAL NOT NULL DEFAULT 0, label_z REAL NOT NULL DEFAULT 0, provenance_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS section_chunks (section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE, chunk_x INTEGER NOT NULL, chunk_y INTEGER NOT NULL, chunk_z INTEGER NOT NULL, format_version INTEGER NOT NULL, blob BLOB NOT NULL, PRIMARY KEY(section_id, chunk_x, chunk_y, chunk_z));
    CREATE TABLE IF NOT EXISTS markers (id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', x REAL NOT NULL, z REAL NOT NULL, stair_destination_id TEXT REFERENCES markers(id));
  `);
  const sectionColumns = new Set(db.pragma('table_info(sections)').map(column => column.name));
  if (!sectionColumns.has('label_x')) db.exec('ALTER TABLE sections ADD COLUMN label_x REAL NOT NULL DEFAULT 0');
  if (!sectionColumns.has('label_z')) db.exec('ALTER TABLE sections ADD COLUMN label_z REAL NOT NULL DEFAULT 0');
  db.prepare("INSERT OR IGNORE INTO project_meta(key,value) VALUES('revision','0')").run();
  return db;
}

export function projectRevision(db) {
  const value = db.prepare("SELECT value FROM project_meta WHERE key='revision'").get()?.value;
  return Number.isSafeInteger(Number(value)) ? Number(value) : 0;
}

export function advanceProjectRevision(db, expectedRevision = projectRevision(db)) {
  const result = db.prepare("UPDATE project_meta SET value=? WHERE key='revision' AND value=?")
    .run(String(expectedRevision + 1), String(expectedRevision));
  if (result.changes !== 1) throw new Error('Project changed in another editor tab. Reload and retry your edit.');
  return expectedRevision + 1;
}

const BUILT_IN_MARKER_TYPES = new Set(['chest', 'relic', 'shop', 'stairs', 'other']);
function validateMarker(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Marker data is required.');
  if (typeof input.type !== 'string' || !BUILT_IN_MARKER_TYPES.has(input.type)) throw new Error('Choose a supported marker type.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new Error('Marker name must contain 1–80 characters.');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) throw new Error('Marker description must be 500 characters or fewer.');
  if (![input.x, input.z].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000)) throw new Error('Marker coordinates must be finite block coordinates.');
}

/** Save a marker mutation atomically with the caller's expected project revision. */
export function saveMarker(db, input, expectedRevision, id = null, { preserveDisplayedPosition = false } = {}) {
  validateMarker(input);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const target = db.prepare('SELECT id,floor_id,placement_x,placement_z FROM sections WHERE id=?').get(input.sectionId);
  if (!target) throw new Error('Choose an existing owning section.');
  let x = input.x, z = input.z;
  if (id && preserveDisplayedPosition) {
    const current = db.prepare('SELECT m.*,s.floor_id,s.placement_x,s.placement_z FROM markers m JOIN sections s ON s.id=m.section_id WHERE m.id=?').get(id);
    if (!current) throw new Error('Marker does not exist.');
    if (current.floor_id !== target.floor_id) throw new Error('Changing floors requires an explicit new position.');
    x = current.x + current.placement_x - target.placement_x;
    z = current.z + current.placement_z - target.placement_z;
  }
  const tx = db.transaction(() => {
    if (id) {
      const result = db.prepare('UPDATE markers SET section_id=?,type=?,name=?,description=?,x=?,z=? WHERE id=?').run(input.sectionId, input.type, input.name.trim(), input.description ?? '', x, z, id);
      if (result.changes !== 1) throw new Error('Marker does not exist.');
    } else {
      id = randomUUID();
      db.prepare('INSERT INTO markers(id,section_id,type,name,description,x,z) VALUES(?,?,?,?,?,?,?)').run(id, input.sectionId, input.type, input.name.trim(), input.description ?? '', x, z);
    }
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { id, sectionId: input.sectionId, type: input.type, name: input.name.trim(), description: input.description ?? '', x, z, revision: expectedRevision + 1 };
}

export function deleteMarker(db, id, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    const result = db.prepare('DELETE FROM markers WHERE id=?').run(id);
    if (result.changes !== 1) throw new Error('Marker does not exist.');
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { revision: expectedRevision + 1 };
}

export function readMarker(db, id) {
  const row = db.prepare('SELECT id,section_id AS sectionId,type,name,description,x,z,stair_destination_id AS stairDestinationId FROM markers WHERE id=?').get(id);
  return row ?? null;
}

/** Apply a marker command's before/after value as one revisioned project mutation. */
export function restoreMarker(db, id, marker, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    if (marker === null) db.prepare('DELETE FROM markers WHERE id=?').run(id);
    else {
      validateMarker(marker);
      if (!db.prepare('SELECT 1 FROM sections WHERE id=?').get(marker.sectionId)) throw new Error('The marker section no longer exists.');
      db.prepare(`INSERT INTO markers(id,section_id,type,name,description,x,z,stair_destination_id) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET section_id=excluded.section_id,type=excluded.type,name=excluded.name,description=excluded.description,x=excluded.x,z=excluded.z,stair_destination_id=excluded.stair_destination_id`)
        .run(id, marker.sectionId, marker.type, marker.name, marker.description ?? '', marker.x, marker.z, marker.stairDestinationId ?? null);
    }
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { revision: expectedRevision + 1 };
}

export function snapshotProject(db) {
  const revision = projectRevision(db);
  const floors = db.prepare('SELECT id,name,sort_order AS sortOrder FROM floors ORDER BY sort_order,id').all();
  return { revision, floors: floors.map(floor => {
    const sections = db.prepare('SELECT id,name,bounds_json,placement_x,placement_z,label_x,label_z FROM sections WHERE floor_id=? ORDER BY id').all(floor.id).map(row => ({
      id: row.id, name: row.name, bounds: JSON.parse(row.bounds_json), placementX: row.placement_x, placementZ: row.placement_z, labelX: row.label_x, labelZ: row.label_z
    }));
    const sectionBlocks = new Map(sections.map(section => [section.id, readSectionBlocks(db, section.id)]));
    for (const section of sections) {
      const blocks = sectionBlocks.get(section.id);
      section.localBounds = {
        minX: Math.min(0, ...blocks.map(block => block.x)), minZ: Math.min(0, ...blocks.map(block => block.z)),
        maxX: Math.max(section.bounds.x, ...blocks.map(block => block.x + 1)), maxZ: Math.max(section.bounds.z, ...blocks.map(block => block.z + 1))
      };
    }
    // The floor image frame may expand around out-of-bounds edits, while each section's stored local origin stays fixed.
    const minX = Math.min(0, ...sections.flatMap(section => [section.placementX, ...sectionBlocks.get(section.id).map(block => section.placementX + block.x)]));
    const minZ = Math.min(0, ...sections.flatMap(section => [section.placementZ, ...sectionBlocks.get(section.id).map(block => section.placementZ + block.z)]));
    const maxX = Math.max(0, ...sections.flatMap(section => [section.placementX + section.bounds.x, ...sectionBlocks.get(section.id).map(block => section.placementX + block.x + 1)]));
    const maxZ = Math.max(0, ...sections.flatMap(section => [section.placementZ + section.bounds.z, ...sectionBlocks.get(section.id).map(block => section.placementZ + block.z + 1)]));
    const maxY = Math.max(1, ...sections.map(section => section.bounds.y));
    const blocks = sections.flatMap(section => sectionBlocks.get(section.id).map(block => ({ ...block, x: block.x + section.placementX - minX, z: block.z + section.placementZ - minZ })));
    for (const section of sections) { section.placementX -= minX; section.placementZ -= minZ; }
    const markers = db.prepare(`SELECT m.id,m.section_id AS sectionId,m.type,m.name,m.description,m.x,m.z,m.stair_destination_id AS stairDestinationId,s.placement_x AS sectionX,s.placement_z AS sectionZ FROM markers m JOIN sections s ON s.id=m.section_id WHERE s.floor_id=? ORDER BY m.id`).all(floor.id).map(marker => ({
      id: marker.id, sectionId: marker.sectionId, type: marker.type, name: marker.name, description: marker.description,
      x: sectionLocalToFloor({ placementX: marker.sectionX, placementZ: marker.sectionZ }, { x: marker.x, z: marker.z }, { x: minX, z: minZ }).x,
      z: sectionLocalToFloor({ placementX: marker.sectionX, placementZ: marker.sectionZ }, { x: marker.x, z: marker.z }, { x: minX, z: minZ }).z,
      localX: marker.x, localZ: marker.z, stairDestinationId: marker.stairDestinationId
    }));
    return { ...floor, coordinateOrigin: { x: minX, z: minZ }, dimensions: { x: Math.max(1, maxX - minX), y: maxY, z: Math.max(1, maxZ - minZ) }, blocks, sections, markers };
  }) };
}

export function seedInitialProject(db, fixturePath) {
  const sectionCount = db.prepare('SELECT COUNT(*) count FROM sections').get().count;
  if (sectionCount !== 0 || !fixturePath || !existsSync(fixturePath)) return { seeded: false, reason: sectionCount ? 'project-exists' : 'fixture-missing' };
  const bytes = readFileSync(fixturePath);
  const schematic = decodeLitematic(bytes);
  const region = schematic.regions[0];
  if (!region) throw new Error('The starting fixture has no region to import');
  const chunks = encodeSectionChunks(region.blocks, region.blockEntities);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('floor-0', 'Floor 0', 0);
    db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run(
      'section-start-0f', 'floor-0', 'Starting Area', JSON.stringify(region.dimensions), 0, 0,
      JSON.stringify({ sourceName: 'Start 0F.litematic', litematicVersion: schematic.version, subVersion: schematic.subVersion, dataVersion: schematic.dataVersion })
    );
    const insert = db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,?,?)');
    for (const chunk of chunks) insert.run('section-start-0f', chunk.cx, chunk.cy, chunk.cz, 1, chunk.compressed);
    db.prepare("INSERT OR REPLACE INTO project_meta(key,value) VALUES('schema_version','1'),('revision','1'),('coordinate_contract','section-local x,y,z; chunks 16^3; index=(y*16+z)*16+x')").run();
  });
  tx();
  return { seeded: true, sectionId: 'section-start-0f', blocks: region.blocks.length, chunks: chunks.length, dimensions: region.dimensions };
}

export function readSectionBlocks(db, sectionId = 'section-start-0f') {
  const result = [];
  const rows = db.prepare('SELECT chunk_x,chunk_y,chunk_z,blob FROM section_chunks WHERE section_id=? ORDER BY chunk_y,chunk_z,chunk_x').all(sectionId);
  for (const row of rows) {
    const chunk = decodeChunkBlob(row.blob);
    for (let i = 0; i < chunk.indices.length; i++) {
      const state = chunk.palette[chunk.indices[i]];
      if (state.id === 'minecraft:air') continue;
      const x = i % 16, z = Math.floor(i / 16) % 16, y = Math.floor(i / 256);
      result.push({ x: row.chunk_x * 16 + x, y: row.chunk_y * 16 + y, z: row.chunk_z * 16 + z, id: state.id, properties: state.properties });
    }
  }
  return result;
}

function validateBlockState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.id !== 'string' || !/^minecraft:[a-z0-9_./-]+$/.test(state.id)) throw new Error('Choose a Minecraft block from the palette.');
  const properties = state.properties ?? {};
  if (!properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 32) throw new Error('Block state properties are invalid.');
  for (const [key, value] of Object.entries(properties)) if (!/^[a-z0-9_]+$/.test(key) || typeof value !== 'string' || value.length > 80) throw new Error('Block state properties are invalid.');
  return { id: state.id, properties };
}

export function readSectionBlock(db, sectionId, x, y, z) {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
  const row = db.prepare('SELECT blob FROM section_chunks WHERE section_id=? AND chunk_x=? AND chunk_y=? AND chunk_z=?').get(sectionId, cx, cy, cz);
  if (!row) return null;
  const chunk = decodeChunkBlob(row.blob);
  const index = localIndex(((x % 16) + 16) % 16, ((y % 16) + 16) % 16, ((z % 16) + 16) % 16);
  const state = chunk.palette[chunk.indices[index]];
  if (state.id === 'minecraft:air') return null;
  return { x, y, z, id: state.id, properties: state.properties ?? {}, blockEntities: chunk.blockEntities.filter(entity => entity.x === x && entity.y === y && entity.z === z) };
}

/** Store one block cell mutation as an atomic palette-chunk and revision update. */
export function saveBlock(db, { sectionId, x, y, z, state = null, blockEntities }, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  if (![x, y, z].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000)) throw new Error('Block coordinates must be whole numbers within the supported range.');
  if (!db.prepare('SELECT 1 FROM sections WHERE id=?').get(sectionId)) throw new Error('Choose an existing owning section.');
  const before = readSectionBlock(db, sectionId, x, y, z);
  const next = state === null ? null : validateBlockState(state);
  if (JSON.stringify(before && { id: before.id, properties: before.properties }) === JSON.stringify(next)) throw new Error('The block already has that state.');
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
  const index = localIndex(((x % 16) + 16) % 16, ((y % 16) + 16) % 16, ((z % 16) + 16) % 16);
  const row = db.prepare('SELECT blob FROM section_chunks WHERE section_id=? AND chunk_x=? AND chunk_y=? AND chunk_z=?').get(sectionId, cx, cy, cz);
  const chunk = row ? decodeChunkBlob(row.blob) : { version: 1, palette: [{ id: 'minecraft:air', properties: {} }], indices: new Array(4096).fill(0), blockEntities: [] };
  if (!chunk.palette.some(item => item.id === 'minecraft:air' && JSON.stringify(item.properties ?? {}) === '{}')) chunk.palette.unshift({ id: 'minecraft:air', properties: {} });
  const air = chunk.palette.findIndex(item => item.id === 'minecraft:air');
  if (next) {
    let paletteIndex = chunk.palette.findIndex(item => item.id === next.id && JSON.stringify(item.properties ?? {}) === JSON.stringify(next.properties));
    if (paletteIndex < 0) { paletteIndex = chunk.palette.length; chunk.palette.push(next); }
    chunk.indices[index] = paletteIndex;
  } else chunk.indices[index] = air;
  // A block entity belongs to a block identity. Replacing or removing its owner clears it.
  const entities = chunk.blockEntities.filter(entity => entity.x !== x || entity.y !== y || entity.z !== z);
  if (blockEntities !== undefined) chunk.blockEntities = [...entities, ...blockEntities];
  else if (before && next?.id === before.id) chunk.blockEntities = chunk.blockEntities;
  else chunk.blockEntities = entities;
  const tx = db.transaction(() => {
    const packed = gzipSync(Buffer.from(JSON.stringify(chunk)));
    db.prepare(`INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)
      ON CONFLICT(section_id,chunk_x,chunk_y,chunk_z) DO UPDATE SET format_version=1,blob=excluded.blob`).run(sectionId, cx, cy, cz, packed);
    const boundsRow = db.prepare('SELECT bounds_json FROM sections WHERE id=?').get(sectionId);
    const bounds = JSON.parse(boundsRow.bounds_json);
    bounds.x = Math.max(bounds.x, x + 1); bounds.y = Math.max(bounds.y, y + 1); bounds.z = Math.max(bounds.z, z + 1);
    db.prepare('UPDATE sections SET bounds_json=? WHERE id=?').run(JSON.stringify(bounds), sectionId);
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { sectionId, x, y, z, state: next, before: before && { id: before.id, properties: before.properties }, revision: expectedRevision + 1 };
}

const cellKey = block => `${block.x},${block.y},${block.z}`;
function chunkKeyAt({ x, y, z }) { return `${Math.floor(x / 16)},${Math.floor(y / 16)},${Math.floor(z / 16)}`; }
function emptyChunk() { return { version: 1, palette: [{ id: 'minecraft:air', properties: {} }], indices: new Array(4096).fill(0), blockEntities: [] }; }
function mutableChunk(db, sectionId, position, chunks) {
  const key = chunkKeyAt(position);
  if (!chunks.has(key)) {
    const [cx, cy, cz] = key.split(',').map(Number);
    const row = db.prepare('SELECT blob FROM section_chunks WHERE section_id=? AND chunk_x=? AND chunk_y=? AND chunk_z=?').get(sectionId, cx, cy, cz);
    chunks.set(key, row ? decodeChunkBlob(row.blob) : emptyChunk());
  }
  return chunks.get(key);
}
function stateAt(chunk, position) {
  const index = localIndex(((position.x % 16) + 16) % 16, ((position.y % 16) + 16) % 16, ((position.z % 16) + 16) % 16);
  return { index, state: chunk.palette[chunk.indices[index]] };
}
function placeInChunk(chunk, position, state, entities) {
  let paletteIndex = chunk.palette.findIndex(item => item.id === state.id && JSON.stringify(item.properties ?? {}) === JSON.stringify(state.properties ?? {}));
  if (paletteIndex < 0) { paletteIndex = chunk.palette.length; chunk.palette.push({ id: state.id, properties: state.properties ?? {} }); }
  const { index } = stateAt(chunk, position);
  chunk.indices[index] = paletteIndex;
  chunk.blockEntities.push(...entities.map(entity => ({ ...entity, x: position.x, y: position.y, z: position.z })));
}

/** Move an occupied block selection as one revision, preserving block entities and section anchors. */
export function moveSectionBlocks(db, { sectionId, blocks, dy }, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 100_000 || !Number.isSafeInteger(dy) || dy === 0 || Math.abs(dy) > 1_000_000) throw new Error('Choose a nonempty block selection and a whole-block vertical offset.');
  if (!db.prepare('SELECT 1 FROM sections WHERE id=?').get(sectionId)) throw new Error('Choose an existing owning section.');
  const unique = new Map();
  for (const pos of blocks) {
    if (![pos?.x, pos?.y, pos?.z].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000)) throw new Error('Block coordinates must be whole numbers within the supported range.');
    unique.set(cellKey(pos), { x: pos.x, y: pos.y, z: pos.z });
  }
  const before = [...unique.values()].map(pos => {
    const block = readSectionBlock(db, sectionId, pos.x, pos.y, pos.z);
    if (!block) throw new Error(`Selected block at ${cellKey(pos)} no longer exists.`);
    return block;
  });
  const after = before.map(block => ({ ...block, y: block.y + dy }));
  if (after.some(block => !Number.isSafeInteger(block.y) || Math.abs(block.y) > 1_000_000)) throw new Error('Moved blocks exceed supported coordinates.');
  const sources = new Set(before.map(cellKey));
  for (const target of after) {
    const current = readSectionBlock(db, sectionId, target.x, target.y, target.z);
    if (current && !sources.has(cellKey(target))) throw new Error(`Move collision at ${cellKey(target)}.`);
  }
  applyBlockMove(db, sectionId, before, after, expectedRevision);
  return { sectionId, before, after, revision: expectedRevision + 1 };
}

/** Restore a recorded selection move in one transaction for undo or redo. */
export function restoreBlockMove(db, command, direction, expectedRevision) {
  if (direction !== 'undo' && direction !== 'redo') throw new Error('Choose undo or redo.');
  const from = direction === 'undo' ? command.after : command.before;
  const to = direction === 'undo' ? command.before : command.after;
  if (!Array.isArray(from) || !Array.isArray(to) || from.length !== to.length) throw new Error('Invalid block move history.');
  for (const block of from) {
    const current = readSectionBlock(db, command.sectionId, block.x, block.y, block.z);
    if (!current || current.id !== block.id || JSON.stringify(current.properties) !== JSON.stringify(block.properties)) throw new Error('Moved blocks changed since this history action.');
  }
  const sources = new Set(from.map(cellKey));
  for (const block of to) {
    const current = readSectionBlock(db, command.sectionId, block.x, block.y, block.z);
    if (current && !sources.has(cellKey(block))) throw new Error(`Move collision at ${cellKey(block)}.`);
  }
  applyBlockMove(db, command.sectionId, from, to, expectedRevision);
  return { sectionId: command.sectionId, revision: expectedRevision + 1 };
}

function applyBlockMove(db, sectionId, from, to, expectedRevision) {
  const chunks = new Map();
  const entities = new Map();
  for (const block of from) {
    const chunk = mutableChunk(db, sectionId, block, chunks), { index } = stateAt(chunk, block);
    entities.set(cellKey(block), chunk.blockEntities.filter(entity => entity.x === block.x && entity.y === block.y && entity.z === block.z));
    chunk.blockEntities = chunk.blockEntities.filter(entity => entity.x !== block.x || entity.y !== block.y || entity.z !== block.z);
    chunk.indices[index] = 0;
  }
  for (let i = 0; i < to.length; i++) {
    const block = to[i], chunk = mutableChunk(db, sectionId, block, chunks);
    placeInChunk(chunk, block, from[i], entities.get(cellKey(from[i])) ?? []);
  }
  const tx = db.transaction(() => {
    for (const [key, chunk] of chunks) {
      const [cx, cy, cz] = key.split(',').map(Number);
      db.prepare(`INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)
        ON CONFLICT(section_id,chunk_x,chunk_y,chunk_z) DO UPDATE SET format_version=1,blob=excluded.blob`)
        .run(sectionId, cx, cy, cz, gzipSync(Buffer.from(JSON.stringify(chunk))));
    }
    const bounds = JSON.parse(db.prepare('SELECT bounds_json FROM sections WHERE id=?').get(sectionId).bounds_json);
    for (const block of to) { bounds.x = Math.max(bounds.x, block.x + 1); bounds.y = Math.max(bounds.y, block.y + 1); bounds.z = Math.max(bounds.z, block.z + 1); }
    db.prepare('UPDATE sections SET bounds_json=? WHERE id=?').run(JSON.stringify(bounds), sectionId);
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
}

export function restoreBlock(db, command, direction, expectedRevision) {
  const target = direction === 'undo' ? command.before : command.after;
  return saveBlock(db, { sectionId: command.sectionId, x: command.x, y: command.y, z: command.z, state: target && { id: target.id, properties: target.properties }, blockEntities: target?.blockEntities ?? [] }, expectedRevision);
}

function readSectionLayout(db, sectionId) {
  const row = db.prepare('SELECT id,floor_id AS floorId,placement_x AS placementX,placement_z AS placementZ,label_x AS labelX,label_z AS labelZ FROM sections WHERE id=?').get(sectionId);
  if (!row) throw new Error('Choose an existing owning section.');
  return row;
}

/** Convert a section-local anchor (marker, label or future connection endpoint) to the saved floor frame. */
export function sectionLocalToFloor(section, point, origin = { x: 0, z: 0 }) {
  return { x: point.x + section.placementX - origin.x, y: point.y, z: point.z + section.placementZ - origin.z };
}

/** Convert a saved floor-frame anchor back to section-local coordinates. */
export function floorToSectionLocal(section, point, origin = { x: 0, z: 0 }) {
  return { x: point.x - section.placementX + origin.x, y: point.y, z: point.z - section.placementZ + origin.z };
}

function inspectSectionLayout(db, sectionId, placementX, placementZ) {
  const current = readSectionLayout(db, sectionId);
  const offsets = [placementX, placementZ];
  if (!offsets.every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000)) throw new Error('Section placement offsets must be whole block coordinates within the supported range.');
  const blocks = readSectionBlocks(db, sectionId);
  const others = db.prepare('SELECT id,placement_x AS placementX,placement_z AS placementZ FROM sections WHERE floor_id=? AND id<>?').all(current.floorId, sectionId);
  const otherByCell = new Map();
  for (const other of others) for (const block of readSectionBlocks(db, other.id)) {
    const key = `${other.placementX + block.x},${block.y},${other.placementZ + block.z}`;
    const state = `${block.id}|${JSON.stringify(block.properties ?? {})}`;
    if (!otherByCell.has(key)) otherByCell.set(key, new Set());
    otherByCell.get(key).add(state);
  }
  const conflicts = [];
  for (const block of blocks) {
    const key = `${placementX + block.x},${block.y},${placementZ + block.z}`;
    const state = `${block.id}|${JSON.stringify(block.properties ?? {})}`;
    const occupied = otherByCell.get(key);
    if (occupied && [...occupied].some(otherState => otherState !== state)) conflicts.push({ x: placementX + block.x, y: block.y, z: placementZ + block.z });
  }
  return { current, conflicts };
}

export function sectionLayoutConflicts(db, { sectionId, placementX, placementZ }) {
  return inspectSectionLayout(db, sectionId, placementX, placementZ).conflicts;
}

function validateSectionLayout(db, sectionId, placementX, placementZ) {
  const { current, conflicts } = inspectSectionLayout(db, sectionId, placementX, placementZ);
  if (conflicts.length) throw new Error(`Section placement collision at ${conflicts.slice(0, 8).map(cell => `${cell.x},${cell.y},${cell.z}`).join('; ')}.`);
  return current;
}

/** Move a whole section in the floor frame while preserving section-local geometry and anchors. */
export function setSectionLayout(db, { sectionId, placementX, placementZ, labelX, labelZ }, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  if (![labelX ?? 0, labelZ ?? 0].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000)) throw new Error('Section label coordinates must be finite local block coordinates.');
  const current = validateSectionLayout(db, sectionId, placementX, placementZ);
  const nextLabelX = labelX ?? current.labelX, nextLabelZ = labelZ ?? current.labelZ;
  if (current.placementX === placementX && current.placementZ === placementZ && current.labelX === nextLabelX && current.labelZ === nextLabelZ) throw new Error('Section layout is unchanged.');
  const tx = db.transaction(() => {
    const result = db.prepare('UPDATE sections SET placement_x=?,placement_z=?,label_x=?,label_z=? WHERE id=?').run(placementX, placementZ, nextLabelX, nextLabelZ, sectionId);
    if (result.changes !== 1) throw new Error('Section does not exist.');
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { sectionId, before: current, after: { ...current, placementX, placementZ, labelX: nextLabelX, labelZ: nextLabelZ }, revision: expectedRevision + 1 };
}

export function restoreSectionLayout(db, command, direction, expectedRevision) {
  if (direction !== 'undo' && direction !== 'redo') throw new Error('Choose undo or redo.');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const target = direction === 'undo' ? command.before : command.after;
  if (!target) throw new Error('Invalid section layout history.');
  const current = validateSectionLayout(db, command.sectionId, target.placementX, target.placementZ);
  const tx = db.transaction(() => {
    db.prepare('UPDATE sections SET placement_x=?,placement_z=?,label_x=?,label_z=? WHERE id=?').run(target.placementX, target.placementZ, target.labelX, target.labelZ, command.sectionId);
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { sectionId: command.sectionId, before: current, after: target, revision: expectedRevision + 1 };
}

/** Persist one decoded schematic as an independent section in a shared schematic coordinate frame. */
export function importSchematicSection(db, schematic, { floorId = null, floorName = 'Floor 0', sectionName = 'Imported section' } = {}) {
  if (!Array.isArray(schematic?.regions) || !schematic.regions.length) throw new Error('Litematic contains no regions to import');
  if (typeof sectionName !== 'string' || !sectionName.trim() || sectionName.length > 120) throw new Error('Section name must contain 1–120 characters');
  if (typeof floorName !== 'string' || !floorName.trim() || floorName.length > 120) throw new Error('Floor name must contain 1–120 characters');
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const region of schematic.regions) for (const axis of ['x', 'y', 'z']) {
    const lo = region.min?.[axis], size = region.dimensions?.[axis];
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(size) || size < 1) throw new Error(`Invalid bounds in region ${region.name}`);
    min[axis] = Math.min(min[axis], lo); max[axis] = Math.max(max[axis], lo + size);
  }
  const dimensions = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  const volume = dimensions.x * dimensions.y * dimensions.z;
  if (!Number.isSafeInteger(volume) || volume > 16_000_000) throw new Error('Combined schematic dimensions exceed the 16 million block import limit');
  const occupied = new Map(), blocks = [], entities = [];
  for (const region of schematic.regions) {
    for (const block of region.blocks ?? []) {
      const placed = { ...block, x: block.x + region.min.x - min.x, y: block.y + region.min.y - min.y, z: block.z + region.min.z - min.z };
      const key = `${placed.x},${placed.y},${placed.z}`;
      const old = occupied.get(key);
      if (old) {
        if (old.id !== placed.id || JSON.stringify(old.properties ?? {}) !== JSON.stringify(placed.properties ?? {})) {
          throw new Error(`Conflicting region placement at schematic cell ${key}: region ${old.region} has ${old.id}, region ${region.name} has ${placed.id}`);
        }
      } else { occupied.set(key, { ...placed, region: region.name }); blocks.push(placed); }
    }
    for (const entity of region.blockEntities ?? []) {
      const copy = { ...entity };
      // Tile entities use the region-local frame exposed by decodeLitematic, like decoded blocks.
      for (const axis of ['x', 'y', 'z']) if (Number.isSafeInteger(copy[axis])) copy[axis] += region.min[axis] - min[axis];
      entities.push(copy);
    }
  }
  if (!blocks.length) throw new Error('Litematic contains no occupied blocks to import');
  const sectionId = randomUUID();
  const creatingFloor = !floorId;
  const targetFloorId = floorId ?? randomUUID();
  if (floorId && !db.prepare('SELECT 1 FROM floors WHERE id=?').get(floorId)) throw new Error('Selected floor does not exist');
  const chunks = encodeSectionChunks(blocks, entities);
  const tx = db.transaction(() => {
    if (creatingFloor) {
      const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1)+1 AS next FROM floors').get().next;
      db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run(targetFloorId, floorName.trim(), order);
    }
    db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run(
      sectionId, targetFloorId, sectionName.trim(), JSON.stringify(dimensions), 0, 0,
      JSON.stringify({ litematicVersion: schematic.version, subVersion: schematic.subVersion, dataVersion: schematic.dataVersion, regionNames: schematic.regions.map(region => region.name) })
    );
    const insert = db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,?,?)');
    for (const chunk of chunks) insert.run(sectionId, chunk.cx, chunk.cy, chunk.cz, 1, chunk.compressed);
    db.prepare("INSERT OR REPLACE INTO project_meta(key,value) VALUES('schema_version','1'),('coordinate_contract','section-local x,y,z; chunks 16^3; index=(y*16+z)*16+x')").run();
    advanceProjectRevision(db);
  });
  tx();
  return { floorId: targetFloorId, sectionId, createdFloor: creatingFloor, dimensions, blockCount: blocks.length, chunkCount: chunks.length };
}
