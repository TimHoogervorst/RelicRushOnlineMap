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
    const minX = Math.min(0, ...sections.map(section => section.placementX));
    const minZ = Math.min(0, ...sections.map(section => section.placementZ));
    const maxX = Math.max(0, ...sections.map(section => section.placementX + section.bounds.x));
    const maxZ = Math.max(0, ...sections.map(section => section.placementZ + section.bounds.z));
    const maxY = Math.max(1, ...sections.map(section => section.bounds.y));
    const blocks = sections.flatMap(section => readSectionBlocks(db, section.id).map(block => ({ ...block, x: block.x + section.placementX - minX, z: block.z + section.placementZ - minZ })));
    for (const section of sections) { section.placementX -= minX; section.placementZ -= minZ; }
    const markers = db.prepare(`SELECT m.id,m.section_id AS sectionId,m.type,m.name,m.description,m.x,m.z,m.stair_destination_id AS stairDestinationId,s.placement_x AS sectionX,s.placement_z AS sectionZ FROM markers m JOIN sections s ON s.id=m.section_id WHERE s.floor_id=? ORDER BY m.id`).all(floor.id).map(marker => ({
      id: marker.id, sectionId: marker.sectionId, type: marker.type, name: marker.name, description: marker.description,
      x: marker.x + marker.sectionX - minX, z: marker.z + marker.sectionZ - minZ,
      localX: marker.x, localZ: marker.z, stairDestinationId: marker.stairDestinationId
    }));
    return { ...floor, dimensions: { x: Math.max(1, maxX - minX), y: maxY, z: Math.max(1, maxZ - minZ) }, blocks, sections, markers };
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
