import Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { decodeLitematic } from './litematic.js';
import { sectionPlacement, sectionDirections } from '../public/section-placement.js';
import { DEFAULT_TRACKING_ORIENTATION, upgradeCalibration } from './tracking-coordinates.js';

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
    CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, floor_id TEXT NOT NULL REFERENCES floors(id), name TEXT NOT NULL, bounds_json TEXT NOT NULL, placement_x INTEGER NOT NULL DEFAULT 0, placement_z INTEGER NOT NULL DEFAULT 0, label_x REAL NOT NULL DEFAULT 0, label_z REAL NOT NULL DEFAULT 0, provenance_json TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS section_render_settings (section_id TEXT PRIMARY KEY REFERENCES sections(id) ON DELETE CASCADE, settings_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS section_chunks (section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE, chunk_x INTEGER NOT NULL, chunk_y INTEGER NOT NULL, chunk_z INTEGER NOT NULL, format_version INTEGER NOT NULL, blob BLOB NOT NULL, PRIMARY KEY(section_id, chunk_x, chunk_y, chunk_z));
    CREATE TABLE IF NOT EXISTS markers (id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', x REAL NOT NULL, z REAL NOT NULL, stair_destination_id TEXT REFERENCES markers(id), icon TEXT);
    CREATE TABLE IF NOT EXISTS custom_marker_types (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, icon TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS section_connections (id TEXT PRIMARY KEY, section_a_id TEXT NOT NULL REFERENCES sections(id), x_a REAL NOT NULL, z_a REAL NOT NULL, section_b_id TEXT NOT NULL REFERENCES sections(id), x_b REAL NOT NULL, z_b REAL NOT NULL, label TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT 'minecraft:oak_stairs', CHECK(section_a_id <> section_b_id));
    DROP TRIGGER IF EXISTS section_connection_same_floor_insert;
    DROP TRIGGER IF EXISTS section_connection_same_floor_update;
    DROP TRIGGER IF EXISTS section_connection_floor_reassignment;
  `);
  const sectionColumns = new Set(db.pragma('table_info(sections)').map(column => column.name));
  if (!sectionColumns.has('tracker_points_json')) db.exec("ALTER TABLE sections ADD COLUMN tracker_points_json TEXT NOT NULL DEFAULT '[]'");
  if (!sectionColumns.has('calibration_json')) db.exec('ALTER TABLE sections ADD COLUMN calibration_json TEXT');
  if (!sectionColumns.has('tracking_orientation_json')) db.exec('ALTER TABLE sections ADD COLUMN tracking_orientation_json TEXT');
  if (!sectionColumns.has('label_x')) db.exec('ALTER TABLE sections ADD COLUMN label_x REAL NOT NULL DEFAULT 0');
  if (!sectionColumns.has('label_z')) db.exec('ALTER TABLE sections ADD COLUMN label_z REAL NOT NULL DEFAULT 0');
  if (!sectionColumns.has('sort_order')) db.exec('ALTER TABLE sections ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  const markerColumns = new Set(db.pragma('table_info(markers)').map(column => column.name));
  if (!markerColumns.has('icon')) db.exec('ALTER TABLE markers ADD COLUMN icon TEXT');
  const connectionColumns = new Set(db.pragma('table_info(section_connections)').map(column => column.name));
  if (!connectionColumns.has('icon')) db.exec("ALTER TABLE section_connections ADD COLUMN icon TEXT NOT NULL DEFAULT 'minecraft:oak_stairs'");
  db.exec(`CREATE TABLE IF NOT EXISTS section_exits (
    id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    x REAL NOT NULL, z REAL NOT NULL, name TEXT NOT NULL,
    connection_id TEXT REFERENCES section_connections(id) ON DELETE SET NULL,
    side TEXT CHECK(side IN ('A','B')), UNIQUE(connection_id,side)
  )`);
  ensureConnectionExits(db);
  db.prepare("INSERT OR IGNORE INTO project_meta(key,value) VALUES('revision','0')").run();
  if (!db.prepare("SELECT value FROM project_meta WHERE key='tracking_coordinates_v2'").get()) {
    db.transaction(() => {
      let changed = false;
      for (const section of db.prepare('SELECT id,calibration_json FROM sections WHERE calibration_json IS NOT NULL').all()) {
        const old = JSON.parse(section.calibration_json);
        const next = upgradeCalibration(old, readSectionBlocks(db, section.id));
        if (next !== old) {
          db.prepare('UPDATE sections SET calibration_json=? WHERE id=?').run(JSON.stringify(next), section.id);
          changed = true;
        }
      }
      if (changed) advanceProjectRevision(db, projectRevision(db));
      db.prepare("INSERT INTO project_meta(key,value) VALUES('tracking_coordinates_v2','1')").run();
    })();
  }
  return db;
}

export function projectRevision(db) {
  const value = db.prepare("SELECT value FROM project_meta WHERE key='revision'").get()?.value;
  return Number.isSafeInteger(Number(value)) ? Number(value) : 0;
}

// Convert existing connection endpoints without changing their saved positions.
function ensureConnectionExits(db) {
  for (const c of db.prepare('SELECT * FROM section_connections').all()) {
    for (const side of ['A', 'B']) {
      const key = side.toLowerCase();
      if (!db.prepare('SELECT 1 FROM section_exits WHERE connection_id=? AND side=?').get(c.id, side)) {
        const name = c.label ? `${c.label} ${side}` : `Exit ${side}`;
        db.prepare('INSERT INTO section_exits(id,section_id,x,z,name,connection_id,side) VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), c[`section_${key}_id`], c[`x_${key}`], c[`z_${key}`], name, c.id, side);
      }
    }
  }
}

export function saveExit(db, input, expectedRevision, id = null) {
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const name = floorName(input?.name);
  return db.transaction(() => {
    if (id) {
      if (!db.prepare('UPDATE section_exits SET name=? WHERE id=?').run(name, id).changes) throw new Error('Exit does not exist.');
    } else {
      const section = db.prepare('SELECT bounds_json FROM sections WHERE id=?').get(input.sectionId);
      if (!section) throw new Error('Section does not exist.');
      const bounds = JSON.parse(section.bounds_json);
      if (![input.x, input.z].every(Number.isFinite) || input.x < 0 || input.z < 0 || input.x > bounds.x || input.z > bounds.z) throw new Error('Exit must be inside its section.');
      id = randomUUID();
      db.prepare('INSERT INTO section_exits(id,section_id,x,z,name) VALUES(?,?,?,?,?)').run(id, input.sectionId, input.x, input.z, name);
    }
    advanceProjectRevision(db, expectedRevision);
    return { id, revision: expectedRevision + 1 };
  })();
}

export function linkExits(db, firstId, secondId, expectedRevision) {
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  return db.transaction(() => {
    const a = db.prepare('SELECT * FROM section_exits WHERE id=?').get(firstId);
    const b = db.prepare('SELECT * FROM section_exits WHERE id=?').get(secondId);
    if (!a || !b || a.id === b.id) throw new Error('Choose two different exits.');
    if (a.connection_id || b.connection_id) throw new Error('Unlink the existing destination before linking these exits.');
    if (a.section_id === b.section_id) throw new Error('Choose exits in different sections.');
    const id = randomUUID();
    db.prepare('INSERT INTO section_connections(id,section_a_id,x_a,z_a,section_b_id,x_b,z_b) VALUES(?,?,?,?,?,?,?)')
      .run(id, a.section_id, a.x, a.z, b.section_id, b.x, b.z);
    db.prepare("UPDATE section_exits SET connection_id=?,side='A' WHERE id=?").run(id, a.id);
    db.prepare("UPDATE section_exits SET connection_id=?,side='B' WHERE id=?").run(id, b.id);
    advanceProjectRevision(db, expectedRevision);
    return { id, revision: expectedRevision + 1 };
  })();
}

export function removeExit(db, id, expectedRevision, unlinkOnly = false) {
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  return db.transaction(() => {
    const exit = db.prepare('SELECT * FROM section_exits WHERE id=?').get(id);
    if (!exit) throw new Error('Exit does not exist.');
    if (exit.connection_id) db.prepare('DELETE FROM section_connections WHERE id=?').run(exit.connection_id);
    if (!unlinkOnly) db.prepare('DELETE FROM section_exits WHERE id=?').run(id);
    advanceProjectRevision(db, expectedRevision);
    return { revision: expectedRevision + 1 };
  })();
}

const LIFECYCLE_TABLES = ['floors','sections','markers','section_connections','section_exits','section_chunks','section_render_settings'];

/** Capture lifecycle-managed rows so a session command can reverse a compound delete or reassignment. */
export function captureProjectLifecycleState(db) {
  return Object.fromEntries(LIFECYCLE_TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
}

/** Restore one lifecycle snapshot atomically while advancing the shared project revision. */
export function restoreProjectLifecycleState(db, state, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  if (!state || LIFECYCLE_TABLES.some(table => !Array.isArray(state[table]))) throw new Error('Lifecycle history is invalid.');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM section_connections').run();
    db.prepare('DELETE FROM markers').run();
    db.prepare('DELETE FROM section_render_settings').run();
    db.prepare('DELETE FROM section_chunks').run();
    db.prepare('DELETE FROM sections').run();
    db.prepare('DELETE FROM floors').run();
    const insertRows = table => {
      for (const row of state[table]) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
      }
    };
    insertRows('floors'); insertRows('sections'); insertRows('section_chunks'); insertRows('section_render_settings');
    for (const marker of state.markers) {
      const { stair_destination_id: _destination, ...row } = marker;
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO markers(${columns.join(',')},stair_destination_id) VALUES(${columns.map(() => '?').join(',')},NULL)`).run(...columns.map(column => row[column]));
    }
    for (const marker of state.markers) if (marker.stair_destination_id) db.prepare('UPDATE markers SET stair_destination_id=? WHERE id=?').run(marker.stair_destination_id, marker.id);
    insertRows('section_connections'); insertRows('section_exits');
    advanceProjectRevision(db, expectedRevision);
  });
  tx(); return { revision: expectedRevision + 1 };
}

const floorName = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Name must contain 1–120 plain-text characters.');
  return value.trim();
};

/** Revisioned floor/section lifecycle operations preserve IDs and apply dependent changes atomically. */
export function renameFloor(db, id, name, expectedRevision) {
  name = floorName(name);
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    if (!db.prepare('UPDATE floors SET name=? WHERE id=?').run(name, id).changes) throw new Error('Floor does not exist.');
    advanceProjectRevision(db, expectedRevision);
  }); tx(); return { id, name, revision: expectedRevision + 1 };
}

export function reorderFloor(db, id, sortOrder, expectedRevision) {
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error('Floor order must be a non-negative whole number.');
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    const rows = db.prepare('SELECT id FROM floors ORDER BY sort_order,id').all();
    const from = rows.findIndex(row => row.id === id); if (from < 0) throw new Error('Floor does not exist.');
    const [row] = rows.splice(from, 1); rows.splice(Math.min(sortOrder, rows.length), 0, row);
    const update = db.prepare('UPDATE floors SET sort_order=? WHERE id=?'); rows.forEach((item, index) => update.run(index, item.id));
    advanceProjectRevision(db, expectedRevision);
  }); tx(); return { revision: expectedRevision + 1 };
}

export function renameSection(db, id, name, expectedRevision) {
  name = floorName(name);
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => { if (!db.prepare('UPDATE sections SET name=? WHERE id=?').run(name, id).changes) throw new Error('Section does not exist.'); advanceProjectRevision(db, expectedRevision); });
  tx(); return { id, name, revision: expectedRevision + 1 };
}

export function reorderSection(db, id, sortOrder, expectedRevision) {
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error('Section order must be a non-negative whole number.');
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    const section = db.prepare('SELECT floor_id FROM sections WHERE id=?').get(id); if (!section) throw new Error('Section does not exist.');
    const rows = db.prepare('SELECT id FROM sections WHERE floor_id=? ORDER BY sort_order,id').all(section.floor_id);
    const from = rows.findIndex(row => row.id === id), [row] = rows.splice(from, 1); rows.splice(Math.min(sortOrder, rows.length), 0, row);
    const update = db.prepare('UPDATE sections SET sort_order=? WHERE id=?'); rows.forEach((item, index) => update.run(index, item.id));
    advanceProjectRevision(db, expectedRevision);
  }); tx(); return { revision: expectedRevision + 1 };
}

export function moveSectionToFloor(db, id, floorId, expectedRevision) {
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    const section = db.prepare('SELECT floor_id AS floorId FROM sections WHERE id=?').get(id);
    if (!section) throw new Error('Section does not exist.');
    if (!db.prepare('SELECT 1 FROM floors WHERE id=?').get(floorId)) throw new Error('Destination floor does not exist.');
    if (section.floorId === floorId) throw new Error('Choose a different destination floor.');
    if (db.prepare('SELECT 1 FROM section_connections WHERE section_a_id=? OR section_b_id=?').get(id, id)) throw new Error('Remove or relink section connections before moving this section to another floor.');
    const stair = db.prepare(`SELECT m.id FROM markers m JOIN markers p ON p.id=m.stair_destination_id JOIN sections s ON s.id=p.section_id WHERE m.section_id=? AND s.floor_id=?`).get(id, floorId);
    if (stair) throw new Error('Unlink stairs before moving this section; their endpoints must remain on different floors.');
    db.prepare('UPDATE sections SET floor_id=? WHERE id=?').run(floorId, id);
    advanceProjectRevision(db, expectedRevision);
  }); tx(); return { id, floorId, revision: expectedRevision + 1 };
}

export function sectionDependents(db, id) {
  return {
    markers: db.prepare('SELECT id,name,type,stair_destination_id AS stairDestinationId FROM markers WHERE section_id=? ORDER BY id').all(id),
    connections: db.prepare('SELECT id,label,section_a_id AS sectionAId,section_b_id AS sectionBId FROM section_connections WHERE section_a_id=? OR section_b_id=? ORDER BY id').all(id, id),
    stairPartners: db.prepare('SELECT DISTINCT p.id,p.name,p.section_id AS sectionId FROM markers m JOIN markers p ON p.id=m.stair_destination_id WHERE m.section_id=? ORDER BY p.id').all(id)
  };
}

export function deleteSectionLifecycle(db, id, resolution, expectedRevision) {
  if (id === 'section-start-0f') throw new Error('The built-in starting section cannot be deleted.');
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const dependents = sectionDependents(db, id);
  if (!db.prepare('SELECT 1 FROM sections WHERE id=?').get(id)) throw new Error('Section does not exist.');
  if (!resolution || !['delete','reassign'].includes(resolution.markers) || !Array.isArray(resolution.deleteConnections) || resolution.deleteConnections.length !== dependents.connections.length || dependents.connections.some(row => !resolution.deleteConnections.includes(row.id))) {
    const error = new Error('Resolve dependent markers and explicitly confirm deletion of every section connection.'); error.dependents = dependents; throw error;
  }
  let target = null;
  if (resolution.markers === 'reassign') {
    target = db.prepare('SELECT id,floor_id AS floorId FROM sections WHERE id=?').get(resolution.sectionId);
    if (!target || target.id === id || target.floorId !== db.prepare('SELECT floor_id FROM sections WHERE id=?').get(id).floor_id) throw new Error('Choose a different section on the same floor to receive the markers.');
    if (dependents.markers.some(marker => marker.stairDestinationId) && resolution.stairLinks !== 'unlink') throw new Error('Confirm unlinking stair connections before reassigning dependent markers.');
  }
  const tx = db.transaction(() => {
    if (resolution.markers === 'delete') {
      for (const partner of dependents.stairPartners) db.prepare('UPDATE markers SET stair_destination_id=NULL WHERE id=?').run(partner.id);
      db.prepare('UPDATE markers SET stair_destination_id=NULL WHERE stair_destination_id IN (SELECT id FROM markers WHERE section_id=?)').run(id);
      db.prepare('DELETE FROM markers WHERE section_id=?').run(id);
    } else {
      if (resolution.stairLinks === 'unlink') {
        db.prepare('UPDATE markers SET stair_destination_id=NULL WHERE section_id=? OR stair_destination_id IN (SELECT id FROM markers WHERE section_id=?)').run(id, id);
      }
      db.prepare('UPDATE markers SET section_id=? WHERE section_id=?').run(target.id, id);
    }
    db.prepare('DELETE FROM section_connections WHERE section_a_id=? OR section_b_id=?').run(id, id);
    if (!db.prepare('DELETE FROM sections WHERE id=?').run(id).changes) throw new Error('Section does not exist.');
    advanceProjectRevision(db, expectedRevision);
  }); tx(); return { revision: expectedRevision + 1, deletedSectionId: id };
}

export function deleteFloorLifecycle(db, id, resolution, expectedRevision) {
  if (id === 'floor-0') throw new Error('The built-in Floor 0 cannot be deleted.');
  if (expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const floor = db.prepare('SELECT id FROM floors WHERE id=?').get(id); if (!floor) throw new Error('Floor does not exist.');
  const sections = db.prepare('SELECT id FROM sections WHERE floor_id=? ORDER BY id').all(id).map(row => row.id);
  const destination = resolution?.destinationFloorId;
  if (sections.length && !destination) { const error = new Error('Choose a destination floor or explicitly resolve each section before deleting this floor.'); error.dependents = { sections }; throw error; }
  if (destination && (!db.prepare('SELECT 1 FROM floors WHERE id=?').get(destination) || destination === id)) throw new Error('Choose another existing floor.');
  // Moving all sections as one operation validates the resulting connection and stair topology.
  const tx = db.transaction(() => {
    if (destination) {
      const set = new Set(sections);
      for (const sectionId of sections) {
        const links = db.prepare('SELECT section_a_id AS a,section_b_id AS b FROM section_connections WHERE section_a_id=? OR section_b_id=?').all(sectionId, sectionId);
        if (links.some(link => !set.has(link.a) || !set.has(link.b))) throw new Error('Remove or relink section connections before reassigning this floor.');
        const stair = db.prepare(`SELECT m.id FROM markers m JOIN markers p ON p.id=m.stair_destination_id JOIN sections s ON s.id=p.section_id WHERE m.section_id=? AND s.floor_id=?`).get(sectionId, destination);
        if (stair) throw new Error('Unlink stairs before reassigning this floor; both endpoints would be on one floor.');
      }
      for (const sectionId of sections) db.prepare('UPDATE sections SET floor_id=? WHERE id=?').run(destination, sectionId);

    }
    if (db.prepare('SELECT 1 FROM sections WHERE floor_id=?').get(id)) throw new Error('Resolve all sections before deleting this floor.');
    const order = db.prepare('SELECT sort_order FROM floors WHERE id=?').get(id).sort_order;
    db.prepare('DELETE FROM floors WHERE id=?').run(id); db.prepare('UPDATE floors SET sort_order=sort_order-1 WHERE sort_order>?').run(order);
    advanceProjectRevision(db, expectedRevision);
  }); tx(); return { revision: expectedRevision + 1, deletedFloorId: id, reassignedSections: sections.length };
}

export function advanceProjectRevision(db, expectedRevision = projectRevision(db)) {
  const result = db.prepare("UPDATE project_meta SET value=? WHERE key='revision' AND value=?")
    .run(String(expectedRevision + 1), String(expectedRevision));
  if (result.changes !== 1) throw new Error('Project changed in another editor tab. Reload and retry your edit.');
  return expectedRevision + 1;
}

const BUILT_IN_MARKER_TYPES = new Set(['chest', 'relic', 'shop', 'stairs', 'other']);
export const BUILT_IN_MARKER_TYPE_DATA = [
  { id: 'chest', name: 'Chests', color: '#d89032', icon: 'minecraft:chest', builtIn: true },
  { id: 'relic', name: 'Relics', color: '#a478d0', icon: 'minecraft:diamond', builtIn: true },
  { id: 'shop', name: 'Shops', color: '#55ae70', icon: 'minecraft:emerald', builtIn: true },
  { id: 'stairs', name: 'Stairs', color: '#57a9d6', icon: 'minecraft:oak_stairs', builtIn: true },
  { id: 'other', name: 'Other', color: '#aab3ba', icon: 'minecraft:compass', builtIn: true }
];

export function listMarkerTypes(db) {
  return [...BUILT_IN_MARKER_TYPE_DATA, ...db.prepare('SELECT id,name,color,icon FROM custom_marker_types ORDER BY name COLLATE NOCASE,id').all().map(type => ({ ...type, builtIn: false }))];
}

function validateCustomMarkerType(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Marker type data is required.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(input.name)) throw new Error('Type name must contain 1–40 plain-text characters.');
  if (typeof input.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input.color)) throw new Error('Choose a six-digit hex color.');
  if (typeof input.icon !== 'string' || (!/^minecraft:[a-z0-9_./-]+$/.test(input.icon) && !LEGACY_MARKER_ICONS.has(input.icon))) throw new Error('Choose a Minecraft inventory item icon.');
  if (input.icon.startsWith('minecraft:')) validateItemIcon(input.icon);
  return { name: input.name.trim(), color: input.color.toLowerCase(), icon: input.icon };
}

function readCustomMarkerType(db, id) {
  return db.prepare('SELECT id,name,color,icon FROM custom_marker_types WHERE id=?').get(id) ?? null;
}

/** Create, update or delete a custom marker type; deletion and marker reassignment share one transaction. */
export function saveCustomMarkerType(db, { id = null, type, replacementType = null }, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  if (id !== null && (typeof id !== 'string' || !/^custom_[0-9a-f-]{36}$/.test(id))) throw new Error('Custom marker type does not exist.');
  const before = id ? readCustomMarkerType(db, id) : null;
  if (id && !before) throw new Error('Custom marker type does not exist.');
  const after = type === null ? null : { ...(id ? { id } : {}), ...validateCustomMarkerType(type) };
  let actualId = id;
  let affectedBefore = [];
  if (id && after === null) {
    const count = db.prepare('SELECT COUNT(*) count FROM markers WHERE type=?').get(id).count;
    if (count && typeof replacementType !== 'string') throw new Error('Choose a replacement type for markers in this group.');
    if (replacementType !== null && replacementType !== id && !BUILT_IN_MARKER_TYPES.has(replacementType) && !readCustomMarkerType(db, replacementType)) throw new Error('Choose an existing replacement marker type.');
    if (replacementType === id) throw new Error('Choose a different replacement marker type.');
    affectedBefore = db.prepare('SELECT id,type,stair_destination_id AS stairDestinationId FROM markers WHERE type=?').all(id);
  } else if (replacementType !== null) throw new Error('A replacement is only used when deleting a type.');
  const tx = db.transaction(() => {
    let saved = after;
    if (id && after === null) {
      if (affectedBefore.length) {
        db.prepare('UPDATE markers SET type=?,stair_destination_id=NULL WHERE type=?').run(replacementType, id);
        // Remove reciprocal links to any moved marker; custom groups ordinarily cannot be stairs, but legacy data may contain them.
        for (const marker of affectedBefore) if (marker.stairDestinationId) db.prepare('UPDATE markers SET stair_destination_id=NULL WHERE id=?').run(marker.stairDestinationId);
      }
      db.prepare('DELETE FROM custom_marker_types WHERE id=?').run(id);
      saved = null;
    } else if (id) {
      db.prepare('UPDATE custom_marker_types SET name=?,color=?,icon=? WHERE id=?').run(after.name, after.color, after.icon, id);
    } else {
      const newId = `custom_${randomUUID()}`;
      actualId = newId;
      saved = { ...after, id: newId };
      db.prepare('INSERT INTO custom_marker_types(id,name,color,icon) VALUES(?,?,?,?)').run(newId, saved.name, saved.color, saved.icon);
    }
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  const savedType = id ? (after ? { ...after, id } : null) : { ...after, id: actualId };
  const affectedAfter = id && after === null ? affectedBefore.map(marker => ({ ...marker, type: replacementType, stairDestinationId: null })) : [];
  return { type: savedType, revision: expectedRevision + 1, command: { id: actualId, before, after: savedType, affectedBefore, affectedAfter } };
}

/** Apply a type command snapshot for per-session undo/redo. */
export function restoreCustomMarkerTypeCommand(db, command, target, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    const existing = readCustomMarkerType(db, command.id);
    if (target.type) {
      const { name, color, icon } = validateCustomMarkerType(target.type);
      if (existing) db.prepare('UPDATE custom_marker_types SET name=?,color=?,icon=? WHERE id=?').run(name, color, icon, command.id);
      else db.prepare('INSERT INTO custom_marker_types(id,name,color,icon) VALUES(?,?,?,?)').run(command.id, name, color, icon);
    } else {
      const references = db.prepare('SELECT id FROM markers WHERE type=?').all(command.id).map(marker => marker.id);
      const reassigned = new Set((target.markers ?? []).filter(marker => marker.type !== command.id).map(marker => marker.id));
      if (existing && references.some(markerId => !reassigned.has(markerId))) throw new Error('Reassign or delete markers before undoing this type creation.');
      db.prepare('DELETE FROM custom_marker_types WHERE id=?').run(command.id);
    }
    for (const marker of target.markers ?? []) db.prepare('UPDATE markers SET type=?,stair_destination_id=? WHERE id=?').run(marker.type, marker.stairDestinationId ?? null, marker.id);
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { revision: expectedRevision + 1 };
}
const LEGACY_MARKER_ICONS = new Set(['chest','relic','shop','other']);
function validateItemIcon(icon) {
  if (icon === undefined || icon === null || icon === '' || LEGACY_MARKER_ICONS.has(icon)) return icon || null;
  if (typeof icon !== 'string' || !/^minecraft:[a-z0-9_./-]+$/.test(icon) || icon.split(':')[1].split('/').some(part => part === '..' || part === '.')) throw new Error('Choose a Minecraft inventory item icon.');
  return icon;
}

function validateMarker(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Marker data is required.');
  if (typeof input.type !== 'string' || (!BUILT_IN_MARKER_TYPES.has(input.type) && !/^custom_[0-9a-f-]{36}$/.test(input.type))) throw new Error('Choose a supported marker type.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new Error('Marker name must contain 1–80 characters.');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) throw new Error('Marker description must be 500 characters or fewer.');
  validateItemIcon(input.icon);
  if (![input.x, input.z].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000)) throw new Error('Marker coordinates must be finite block coordinates.');
}

/** Save a marker mutation atomically with the caller's expected project revision. */
export function saveMarker(db, input, expectedRevision, id = null, { preserveDisplayedPosition = false, confirmUnlink = false } = {}) {
  validateMarker(input);
  if (!BUILT_IN_MARKER_TYPES.has(input.type) && !readCustomMarkerType(db, input.type)) throw new Error('Choose an existing marker type.');
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
      const current = db.prepare('SELECT m.type,m.stair_destination_id,s.floor_id FROM markers m JOIN sections s ON s.id=m.section_id WHERE m.id=?').get(id);
      if (!current) throw new Error('Marker does not exist.');
      if (current.stair_destination_id && target.floor_id !== current.floor_id) throw new Error('A linked stair cannot change floors. Unlink it first.');
      if (current.stair_destination_id && input.type !== 'stairs' && !confirmUnlink) throw new Error('Confirm removing this stair connection before changing its type.');
      if (current.stair_destination_id && input.type !== 'stairs') {
        db.prepare('UPDATE markers SET stair_destination_id=NULL WHERE id IN (?,?)').run(id, current.stair_destination_id);
      }
      const result = db.prepare('UPDATE markers SET section_id=?,type=?,name=?,description=?,x=?,z=?,icon=? WHERE id=?').run(input.sectionId, input.type, input.name.trim(), input.description ?? '', x, z, validateItemIcon(input.icon), id);
      if (result.changes !== 1) throw new Error('Marker does not exist.');
    } else {
      id = randomUUID();
      db.prepare('INSERT INTO markers(id,section_id,type,name,description,x,z,icon) VALUES(?,?,?,?,?,?,?,?)').run(id, input.sectionId, input.type, input.name.trim(), input.description ?? '', x, z, validateItemIcon(input.icon));
    }
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { id, sectionId: input.sectionId, type: input.type, name: input.name.trim(), description: input.description ?? '', x, z, icon: validateItemIcon(input.icon), revision: expectedRevision + 1 };
}

export function deleteMarker(db, id, expectedRevision, { confirmUnlink = false } = {}) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    const marker = db.prepare('SELECT stair_destination_id FROM markers WHERE id=?').get(id);
    if (!marker) throw new Error('Marker does not exist.');
    if (marker.stair_destination_id && !confirmUnlink) throw new Error('Confirm removing this stair connection before deleting the marker.');
    if (marker.stair_destination_id) db.prepare('UPDATE markers SET stair_destination_id=NULL WHERE id=?').run(marker.stair_destination_id);
    const result = db.prepare('DELETE FROM markers WHERE id=?').run(id);
    if (result.changes !== 1) throw new Error('Marker does not exist.');
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { revision: expectedRevision + 1 };
}

/** Create a reciprocal cross-floor stair link with a single revisioned transaction. */
export function linkStairs(db, firstId, secondId, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  if (typeof firstId !== 'string' || typeof secondId !== 'string' || firstId === secondId) throw new Error('Choose two distinct stairs.');
  const tx = db.transaction(() => {
    const find = db.prepare('SELECT m.id,m.type,m.stair_destination_id,s.floor_id FROM markers m JOIN sections s ON s.id=m.section_id WHERE m.id=?');
    const first = find.get(firstId), second = find.get(secondId);
    if (!first || !second) throw new Error('Both stair markers must exist.');
    if (first.type !== 'stairs' || second.type !== 'stairs') throw new Error('Only stairs can be linked.');
    if (first.floor_id === second.floor_id) throw new Error('Stairs must be on different floors.');
    if ((first.stair_destination_id && first.stair_destination_id !== secondId) || (second.stair_destination_id && second.stair_destination_id !== firstId)) throw new Error('Each stair can belong to only one connection. Unlink its current destination first.');
    db.prepare('UPDATE markers SET stair_destination_id=? WHERE id=?').run(secondId, firstId);
    db.prepare('UPDATE markers SET stair_destination_id=? WHERE id=?').run(firstId, secondId);
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { firstId, secondId, revision: expectedRevision + 1 };
}

export function unlinkStair(db, id, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    const marker = db.prepare('SELECT stair_destination_id FROM markers WHERE id=? AND type=\'stairs\'').get(id);
    if (!marker) throw new Error('Stair marker does not exist.');
    if (marker.stair_destination_id) db.prepare('UPDATE markers SET stair_destination_id=NULL WHERE id IN (?,?)').run(id, marker.stair_destination_id);
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { revision: expectedRevision + 1 };
}

export function readMarker(db, id) {
  const row = db.prepare('SELECT id,section_id AS sectionId,type,name,description,x,z,icon,stair_destination_id AS stairDestinationId FROM markers WHERE id=?').get(id);
  return row ?? null;
}

/** Apply a marker command's before/after value as one revisioned project mutation. */
export function restoreMarker(db, id, marker, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    const current = db.prepare('SELECT stair_destination_id FROM markers WHERE id=?').get(id);
    if (current?.stair_destination_id) db.prepare('UPDATE markers SET stair_destination_id=NULL WHERE id=?').run(current.stair_destination_id);
    if (marker === null) {
      db.prepare('UPDATE markers SET stair_destination_id=NULL WHERE id=?').run(id);
      db.prepare('DELETE FROM markers WHERE id=?').run(id);
    }
    else {
      validateMarker(marker);
      if (!BUILT_IN_MARKER_TYPES.has(marker.type) && !readCustomMarkerType(db, marker.type)) throw new Error('The marker type no longer exists.');
      const owner = db.prepare('SELECT floor_id FROM sections WHERE id=?').get(marker.sectionId);
      if (!owner) throw new Error('The marker section no longer exists.');
      if (marker.stairDestinationId) {
        if (marker.type !== 'stairs') throw new Error('Only stairs can have a destination.');
        const partner = db.prepare('SELECT m.type,m.stair_destination_id,s.floor_id FROM markers m JOIN sections s ON s.id=m.section_id WHERE m.id=?').get(marker.stairDestinationId);
        if (!partner || partner.type !== 'stairs' || partner.floor_id === owner.floor_id || (partner.stair_destination_id && partner.stair_destination_id !== id)) throw new Error('The stair destination is no longer available.');
      }
      db.prepare(`INSERT INTO markers(id,section_id,type,name,description,x,z,stair_destination_id,icon) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET section_id=excluded.section_id,type=excluded.type,name=excluded.name,description=excluded.description,x=excluded.x,z=excluded.z,stair_destination_id=excluded.stair_destination_id,icon=excluded.icon`)
        .run(id, marker.sectionId, marker.type, marker.name, marker.description ?? '', marker.x, marker.z, marker.stairDestinationId ?? null, validateItemIcon(marker.icon));
      if (marker.stairDestinationId) db.prepare('UPDATE markers SET stair_destination_id=? WHERE id=?').run(id, marker.stairDestinationId);
    }
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { revision: expectedRevision + 1 };
}

function validateConnection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Connection data is required.');
  if (typeof input.sectionAId !== 'string' || typeof input.sectionBId !== 'string' || input.sectionAId === input.sectionBId) throw new Error('Choose two different sections.');
  if (![input.xA, input.zA, input.xB, input.zB].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000)) throw new Error('Connection anchors must be finite local coordinates.');
  if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 120 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.label))) throw new Error('Connection label must be 120 plain-text characters or fewer.');
  validateItemIcon(input.icon);
}

function validateConnectionSections(db, input) {
  const sections = [input.sectionAId, input.sectionBId].map(id => db.prepare('SELECT id,floor_id,bounds_json FROM sections WHERE id=?').get(id));
  if (sections.some(section => !section)) throw new Error('Choose existing owning sections.');
  for (const [index, section] of sections.entries()) {
    const x = index === 0 ? input.xA : input.xB, z = index === 0 ? input.zA : input.zB;
    const bounds = JSON.parse(section.bounds_json);
    if (x < 0 || z < 0 || x > bounds.x || z > bounds.z) throw new Error('Connection anchor must be inside its owning section bounds.');
  }
}

export function readSectionConnection(db, id) {
  return db.prepare(`SELECT id,section_a_id AS sectionAId,x_a AS xA,z_a AS zA,section_b_id AS sectionBId,x_b AS xB,z_b AS zB,label,icon,(SELECT id FROM section_exits WHERE connection_id=section_connections.id AND side='A') AS exitAId,(SELECT id FROM section_exits WHERE connection_id=section_connections.id AND side='B') AS exitBId FROM section_connections WHERE id=?`).get(id) ?? null;
}

/** Save a navigable connection using section-local anchors and a project revision. */
export function saveSectionConnection(db, input, expectedRevision, id = null) {
  validateConnection(input);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  validateConnectionSections(db, input);
  const label = (input.label ?? '').trim();
  const tx = db.transaction(() => {
    if (id) {
      const result = db.prepare('UPDATE section_connections SET section_a_id=?,x_a=?,z_a=?,section_b_id=?,x_b=?,z_b=?,label=?,icon=? WHERE id=?').run(input.sectionAId, input.xA, input.zA, input.sectionBId, input.xB, input.zB, label, validateItemIcon(input.icon) ?? 'minecraft:oak_stairs', id);
      if (!result.changes) throw new Error('Section connection does not exist.');
    } else {
      id = randomUUID();
      db.prepare('INSERT INTO section_connections(id,section_a_id,x_a,z_a,section_b_id,x_b,z_b,label,icon) VALUES(?,?,?,?,?,?,?,?,?)').run(id, input.sectionAId, input.xA, input.zA, input.sectionBId, input.xB, input.zB, label, validateItemIcon(input.icon) ?? 'minecraft:oak_stairs');
    }
    ensureConnectionExits(db);
    db.prepare("UPDATE section_exits SET section_id=?,x=?,z=? WHERE connection_id=? AND side='A'").run(input.sectionAId,input.xA,input.zA,id);
    db.prepare("UPDATE section_exits SET section_id=?,x=?,z=? WHERE connection_id=? AND side='B'").run(input.sectionBId,input.xB,input.zB,id);
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { ...readSectionConnection(db, id), revision: expectedRevision + 1 };
}

export function deleteSectionConnection(db, id, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    if (!db.prepare('DELETE FROM section_connections WHERE id=?').run(id).changes) throw new Error('Section connection does not exist.');
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { revision: expectedRevision + 1 };
}

export function restoreSectionConnection(db, id, connection, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const tx = db.transaction(() => {
    if (connection === null) db.prepare('DELETE FROM section_connections WHERE id=?').run(id);
    else {
      validateConnection(connection);
      validateConnectionSections(db, connection);
      db.prepare(`INSERT INTO section_connections(id,section_a_id,x_a,z_a,section_b_id,x_b,z_b,label,icon) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET section_a_id=excluded.section_a_id,x_a=excluded.x_a,z_a=excluded.z_a,section_b_id=excluded.section_b_id,x_b=excluded.x_b,z_b=excluded.z_b,label=excluded.label,icon=excluded.icon`)
        .run(id, connection.sectionAId, connection.xA, connection.zA, connection.sectionBId, connection.xB, connection.zB, connection.label ?? '', validateItemIcon(connection.icon) ?? 'minecraft:oak_stairs');
      for (const side of ['A', 'B']) if (connection[`exit${side}Id`]) {
        db.prepare('UPDATE section_exits SET connection_id=?,side=?,section_id=?,x=?,z=? WHERE id=?')
          .run(id, side, connection[`section${side}Id`], connection[`x${side}`], connection[`z${side}`], connection[`exit${side}Id`]);
      }
      ensureConnectionExits(db);
    }
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { revision: expectedRevision + 1 };
}

export function snapshotProject(db) {
  const revision = projectRevision(db);
  const renderOptionsRow = db.prepare("SELECT value FROM project_meta WHERE key='render_options'").get();
  const renderOptions = renderOptionsRow ? JSON.parse(renderOptionsRow.value) : { pixelSize: 16, heightShadePerBlock: 0.018, heightShadeMinY: null, heightShadeMaxY: null, heightShadeMultiplier: 1, surfaceShadeMultiplier: 0 };
  const markerTypes = listMarkerTypes(db);
  const floors = db.prepare('SELECT id,name,sort_order AS sortOrder FROM floors ORDER BY sort_order,id').all();
  const unresolvedRecords = {
    sections: db.prepare('SELECT s.id,s.floor_id AS floorId FROM sections s LEFT JOIN floors f ON f.id=s.floor_id WHERE f.id IS NULL').all(),
    markers: db.prepare('SELECT m.id,m.section_id AS sectionId FROM markers m LEFT JOIN sections s ON s.id=m.section_id WHERE s.id IS NULL').all(),
    stairs: db.prepare(`SELECT m.id,m.stair_destination_id AS destinationId FROM markers m LEFT JOIN markers p ON p.id=m.stair_destination_id LEFT JOIN sections s ON s.id=p.section_id WHERE m.stair_destination_id IS NOT NULL AND (p.id IS NULL OR p.type<>'stairs' OR s.id IS NULL)`).all(),
    connections: db.prepare(`SELECT c.id,c.section_a_id AS sectionAId,c.section_b_id AS sectionBId FROM section_connections c LEFT JOIN sections a ON a.id=c.section_a_id LEFT JOIN sections b ON b.id=c.section_b_id WHERE a.id IS NULL OR b.id IS NULL`).all()
  };
  return { revision, trackingSettings: JSON.parse(db.prepare("SELECT value FROM project_meta WHERE key='tracking_settings'").get()?.value ?? '{"horizontal":3,"vertical":1}'), unresolvedRecords, floors: floors.map(floor => {
    const sections = db.prepare(`SELECT s.id,s.name,s.bounds_json,s.placement_x,s.placement_z,s.label_x,s.label_z,s.sort_order,s.calibration_json,s.tracking_orientation_json,s.tracker_points_json,r.settings_json
      FROM sections s LEFT JOIN section_render_settings r ON r.section_id=s.id WHERE s.floor_id=? ORDER BY s.sort_order,s.id`).all(floor.id).map(row => ({
      id: row.id, name: row.name, sortOrder: row.sort_order, bounds: JSON.parse(row.bounds_json), placementX: row.placement_x, placementZ: row.placement_z, labelX: row.label_x, labelZ: row.label_z,
      trackerPoints: JSON.parse(row.tracker_points_json),
      calibration: row.calibration_json ? JSON.parse(row.calibration_json) : null,
      trackingOrientation: row.tracking_orientation_json ? JSON.parse(row.tracking_orientation_json) : [...DEFAULT_TRACKING_ORIENTATION],
      renderSettings: { ...(row.settings_json ? JSON.parse(row.settings_json) : defaultSectionRenderSettings()), ...renderOptions }
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
    const blocks = sections.flatMap(section => sectionBlocks.get(section.id).map(block => ({ ...block, sectionId: section.id, localX: block.x, localY: block.y, localZ: block.z, x: block.x + section.placementX - minX, z: block.z + section.placementZ - minZ })));
    for (const section of sections) { section.placementX -= minX; section.placementZ -= minZ; }
    const markers = db.prepare(`SELECT m.id,m.section_id AS sectionId,m.type,m.name,m.description,m.x,m.z,m.icon,m.stair_destination_id AS stairDestinationId,s.placement_x AS sectionX,s.placement_z AS sectionZ FROM markers m JOIN sections s ON s.id=m.section_id WHERE s.floor_id=? ORDER BY m.id`).all(floor.id).map(marker => ({
      id: marker.id, sectionId: marker.sectionId, type: marker.type, name: marker.name, description: marker.description, icon: marker.icon,
      x: sectionLocalToFloor({ placementX: marker.sectionX, placementZ: marker.sectionZ }, { x: marker.x, z: marker.z }, { x: minX, z: minZ }).x,
      z: sectionLocalToFloor({ placementX: marker.sectionX, placementZ: marker.sectionZ }, { x: marker.x, z: marker.z }, { x: minX, z: minZ }).z,
      localX: marker.x, localZ: marker.z, stairDestinationId: marker.stairDestinationId
    }));
    const connections = db.prepare(`SELECT c.id,c.section_a_id AS sectionAId,c.x_a AS xA,c.z_a AS zA,c.section_b_id AS sectionBId,c.x_b AS xB,c.z_b AS zB,c.label,c.icon,s1.floor_id AS floorAId,s2.floor_id AS floorBId,s1.placement_x AS ax,s1.placement_z AS az,s2.placement_x AS bx,s2.placement_z AS bz FROM section_connections c JOIN sections s1 ON s1.id=c.section_a_id JOIN sections s2 ON s2.id=c.section_b_id WHERE s1.floor_id=? OR s2.floor_id=? ORDER BY c.id`).all(floor.id, floor.id).map(connection => ({
      id: connection.id, floorAId: connection.floorAId, floorBId: connection.floorBId, sectionAId: connection.sectionAId, xA: connection.xA, zA: connection.zA, sectionBId: connection.sectionBId, xB: connection.xB, zB: connection.zB, label: connection.label, icon: connection.icon,
      displayA: connection.floorAId === floor.id ? { x: connection.ax + connection.xA - minX, z: connection.az + connection.zA - minZ } : null,
      displayB: connection.floorBId === floor.id ? { x: connection.bx + connection.xB - minX, z: connection.bz + connection.zB - minZ } : null
    }));
    const exits = db.prepare(`SELECT e.id,e.section_id AS sectionId,e.x AS localX,e.z AS localZ,e.name,e.connection_id AS connectionId,e.side,
      s.placement_x + e.x AS x,s.placement_z + e.z AS z,p.id AS destinationId,p.name AS destinationName,
      p.section_id AS destinationSectionId,ds.floor_id AS destinationFloorId
      FROM section_exits e JOIN sections s ON s.id=e.section_id
      LEFT JOIN section_exits p ON p.connection_id=e.connection_id AND p.id<>e.id
      LEFT JOIN sections ds ON ds.id=p.section_id WHERE s.floor_id=? ORDER BY e.name,e.id`).all(floor.id)
      .map(exit => ({ ...exit, x: exit.x - minX, z: exit.z - minZ }));
    return { ...floor, renderOptions, coordinateOrigin: { x: minX, z: minZ }, dimensions: { x: Math.max(1, maxX - minX), y: maxY, z: Math.max(1, maxZ - minZ) }, blocks, sections, markers, connections, exits, markerTypes };
  }) };
}

export function defaultSectionRenderSettings() {
  return { cutaways: [], excludedBlocks: [], pixelSize: 16, heightShadePerBlock: 0.018, heightShadeMinY: null, heightShadeMaxY: null, heightShadeMultiplier: 1, surfaceShadeMultiplier: 0 };
}

function validateSectionRenderSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Render settings are required.');
  const cutaways = input.cutaways ?? [], excludedBlocks = input.excludedBlocks ?? [];
  const pixelSize = input.pixelSize ?? 16, heightShadePerBlock = input.heightShadePerBlock ?? 0.018;
  const heightShadeMinY = input.heightShadeMinY ?? null, heightShadeMaxY = input.heightShadeMaxY ?? null;
  const heightShadeMultiplier = input.heightShadeMultiplier ?? 1;
  const surfaceShadeMultiplier = input.surfaceShadeMultiplier ?? 0;
  if (typeof surfaceShadeMultiplier !== 'number' || !Number.isFinite(surfaceShadeMultiplier) || surfaceShadeMultiplier < 0 || surfaceShadeMultiplier > 10) throw new Error('Surface shading multiplier must be from 0 to 10.');
  if (!Number.isInteger(pixelSize) || pixelSize < 4 || pixelSize > 32) throw new Error('Pixel scale must be from 4 to 32 pixels per block.');
  if (typeof heightShadePerBlock !== 'number' || !Number.isFinite(heightShadePerBlock) || heightShadePerBlock < 0 || heightShadePerBlock > 0.05) throw new Error('Height shading must be from 0 to 0.05 per block.');
  if (heightShadeMinY !== null && (!Number.isSafeInteger(heightShadeMinY) || Math.abs(heightShadeMinY) > 1_000_000)) throw new Error('Minimum shading Y must be a whole block coordinate.');
  if (heightShadeMaxY !== null && (!Number.isSafeInteger(heightShadeMaxY) || Math.abs(heightShadeMaxY) > 1_000_000)) throw new Error('Maximum shading Y must be a whole block coordinate.');
  if (heightShadeMinY !== null && heightShadeMaxY !== null && heightShadeMinY >= heightShadeMaxY) throw new Error('Maximum shading Y must be higher than minimum shading Y.');
  if (typeof heightShadeMultiplier !== 'number' || !Number.isFinite(heightShadeMultiplier) || heightShadeMultiplier < 0 || heightShadeMultiplier > 10) throw new Error('Height shading multiplier must be from 0 to 10.');
  if (!Array.isArray(cutaways) || cutaways.length > 100) throw new Error('A section can have at most 100 cutaway boxes.');
  for (const box of cutaways) {
    if (!box || !['x','y','z','width','height','depth'].every(key => Number.isSafeInteger(box[key]))) throw new Error('Cutaway boxes must use integer section coordinates and dimensions.');
    if (box.x < -1000000 || box.y < -1000000 || box.z < -1000000 || box.width < 1 || box.height < 1 || box.depth < 1 || box.width > 1000000 || box.height > 1000000 || box.depth > 1000000) throw new Error('Cutaway boxes must have positive bounded dimensions.');
  }
  if (!Array.isArray(excludedBlocks) || excludedBlocks.length > 1000 || excludedBlocks.some(name => typeof name !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(name))) throw new Error('Excluded blocks must be namespaced Minecraft block IDs.');
  return { cutaways: cutaways.map(({ x,y,z,width,height,depth }) => ({ x,y,z,width,height,depth })), excludedBlocks: [...new Set(excludedBlocks)].sort(), pixelSize, heightShadePerBlock, heightShadeMinY, heightShadeMaxY, heightShadeMultiplier, surfaceShadeMultiplier };
}

export function saveSectionRenderSettings(db, sectionId, input, expectedRevision) {
  const settings = validateSectionRenderSettings(input);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const current = db.prepare('SELECT settings_json FROM section_render_settings WHERE section_id=?').get(sectionId);
  if (!db.prepare('SELECT 1 FROM sections WHERE id=?').get(sectionId)) throw new Error('Section does not exist.');
  const renderOptionsRow = db.prepare("SELECT value FROM project_meta WHERE key='render_options'").get();
  const before = { ...defaultSectionRenderSettings(), ...(current ? JSON.parse(current.settings_json) : {}), ...(renderOptionsRow ? JSON.parse(renderOptionsRow.value) : {}) };
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO section_render_settings(section_id,settings_json) VALUES(?,?) ON CONFLICT(section_id) DO UPDATE SET settings_json=excluded.settings_json`).run(sectionId, JSON.stringify({ cutaways: settings.cutaways, excludedBlocks: settings.excludedBlocks }));
    db.prepare("INSERT INTO project_meta(key,value) VALUES('render_options',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ pixelSize: settings.pixelSize, heightShadePerBlock: settings.heightShadePerBlock, heightShadeMinY: settings.heightShadeMinY, heightShadeMaxY: settings.heightShadeMaxY, heightShadeMultiplier: settings.heightShadeMultiplier, surfaceShadeMultiplier: settings.surfaceShadeMultiplier }));
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { sectionId, before, after: settings, revision: expectedRevision + 1 };
}

export function restoreSectionRenderSettings(db, command, direction, expectedRevision) {
  if (!['undo','redo'].includes(direction)) throw new Error('Invalid render settings history direction.');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  const target = direction === 'undo' ? command.before : command.after;
  if (!db.prepare('SELECT 1 FROM sections WHERE id=?').get(command.sectionId)) throw new Error('Section does not exist.');
  const current = db.prepare('SELECT settings_json FROM section_render_settings WHERE section_id=?').get(command.sectionId);
  const tx = db.transaction(() => {
    const validated = validateSectionRenderSettings(target);
    db.prepare(`INSERT INTO section_render_settings(section_id,settings_json) VALUES(?,?) ON CONFLICT(section_id) DO UPDATE SET settings_json=excluded.settings_json`).run(command.sectionId, JSON.stringify({ cutaways: validated.cutaways, excludedBlocks: validated.excludedBlocks }));
    db.prepare("INSERT INTO project_meta(key,value) VALUES('render_options',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ pixelSize: validated.pixelSize, heightShadePerBlock: validated.heightShadePerBlock, heightShadeMinY: validated.heightShadeMinY, heightShadeMaxY: validated.heightShadeMaxY, heightShadeMultiplier: validated.heightShadeMultiplier, surfaceShadeMultiplier: validated.surfaceShadeMultiplier }));
    advanceProjectRevision(db, expectedRevision);
  });
  tx();
  return { sectionId: command.sectionId, before: current ? JSON.parse(current.settings_json) : defaultSectionRenderSettings(), after: target, revision: expectedRevision + 1 };
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
    db.prepare("INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json,tracking_orientation_json) VALUES(?,?,?,?,?,?,?,'[1,0,0,1]')").run(
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

function sectionTransformState(db, sectionId) {
  const section = db.prepare('SELECT id,bounds_json,label_x,label_z,tracker_points_json FROM sections WHERE id=?').get(sectionId);
  if (!section) throw new Error('Section does not exist.');
  return {
    section,
    chunks: db.prepare('SELECT chunk_x,chunk_y,chunk_z,format_version,blob FROM section_chunks WHERE section_id=?').all(sectionId),
    markers: db.prepare('SELECT id,x,z FROM markers WHERE section_id=?').all(sectionId),
    exits: db.prepare('SELECT id,x,z FROM section_exits WHERE section_id=?').all(sectionId),
    connections: db.prepare('SELECT id,section_a_id,x_a,z_a,section_b_id,x_b,z_b FROM section_connections WHERE section_a_id=? OR section_b_id=?').all(sectionId, sectionId)
  };
}

function transformedPoint(x, z, width, depth, operation, cell = false, inverse = false) {
  const { rotation, flipHorizontal, flipVertical } = operation;
  const maxX = amount => amount - (cell ? 1 : 0), maxZ = amount => amount - (cell ? 1 : 0);
  let nextWidth = width, nextDepth = depth, nextX = x, nextZ = z;
  const rotate = degrees => {
    if (degrees === 90) { [nextX, nextZ] = [maxZ(nextDepth) - nextZ, nextX]; [nextWidth, nextDepth] = [nextDepth, nextWidth]; }
    else if (degrees === 180) { nextX = maxX(nextWidth) - nextX; nextZ = maxZ(nextDepth) - nextZ; }
    else if (degrees === 270) { [nextX, nextZ] = [nextZ, maxX(nextWidth) - nextX]; [nextWidth, nextDepth] = [nextDepth, nextWidth]; }
  };
  const flip = () => {
    if (flipHorizontal) nextX = maxX(nextWidth) - nextX;
    if (flipVertical) nextZ = maxZ(nextDepth) - nextZ;
  };
  if (inverse) { rotate((360 - rotation) % 360); flip(); }
  else { flip(); rotate(rotation); }
  return { x: nextX, z: nextZ };
}

function transformedDirection(direction, operation, inverse = false) {
  const vectors = { north: [0,-1], east: [1,0], south: [0,1], west: [-1,0] };
  if (!vectors[direction]) return direction;
  let [x,z] = vectors[direction];
  const reflect = () => { if (operation.flipHorizontal) x = -x; if (operation.flipVertical) z = -z; };
  const rotate = degrees => { for (let i = 0; i < degrees / 90; i++) [x,z] = [-z,x]; };
  if (inverse) { rotate((360 - operation.rotation) % 360); reflect(); }
  else { reflect(); rotate(operation.rotation); }
  return Object.entries(vectors).find(([, vector]) => vector[0] === x && vector[1] === z)?.[0] ?? direction;
}

function transformBlockProperties(properties, operation, inverse = false) {
  const result = { ...(properties ?? {}) };
  const transform = direction => transformedDirection(direction, operation, inverse);
  for (const key of Object.keys(result)) {
    if (['facing','horizontal_facing','direction'].includes(key)) result[key] = transform(result[key]);
    else if (key === 'axis' && operation.rotation % 180 !== 0 && (result[key] === 'x' || result[key] === 'z')) result[key] = result[key] === 'x' ? 'z' : 'x';
    else if (key === 'rotation' && /^\d+$/.test(String(result[key]))) {
      const angle = Number(result[key]) % 16, radians = angle * Math.PI / 8;
      let x = -Math.sin(radians), z = Math.cos(radians);
      const reflect = () => { if (operation.flipHorizontal) x = -x; if (operation.flipVertical) z = -z; };
      const rotate = degrees => { for (let i = 0; i < degrees / 90; i++) [x,z] = [-z,x]; };
      if (inverse) { rotate((360 - operation.rotation) % 360); reflect(); } else { reflect(); rotate(operation.rotation); }
      result[key] = String((Math.round(Math.atan2(-x,z) * 8 / Math.PI) + 16) % 16);
    } else if (['shape','orientation'].includes(key)) {
      result[key] = String(result[key]).split('_').map(token => transform(token)).join('_');
      if ((operation.flipHorizontal !== operation.flipVertical) && /(^|_)(left|right)($|_)/.test(result[key])) result[key] = result[key].replace(/left|right/g, token => token === 'left' ? 'right' : 'left');
    } else if (['hinge','type'].includes(key) && operation.flipHorizontal !== operation.flipVertical && (result[key] === 'left' || result[key] === 'right')) result[key] = result[key] === 'left' ? 'right' : 'left';
  }
  const directionValues = Object.fromEntries(['north','east','south','west'].filter(direction => Object.hasOwn(result,direction)).map(direction => [direction,result[direction]]));
  for (const direction of Object.keys(directionValues)) delete result[direction];
  for (const [direction,value] of Object.entries(directionValues)) result[transform(direction)] = value;
  return result;
}

function applySectionTransform(db, sectionId, operation, inverse = false) {
  const state = sectionTransformState(db, sectionId), bounds = JSON.parse(state.section.bounds_json);
  const { rotation, flipHorizontal, flipVertical } = operation;
  if (rotation === 0 && !flipHorizontal && !flipVertical) throw new Error('Choose a rotation or flip for this section.');
  const point = (x,z,cell=false) => transformedPoint(x,z,bounds.x,bounds.z,operation,cell,inverse);
  const blocks = readSectionBlocks(db, sectionId).map(block => ({ ...block, ...point(block.x,block.z,true), properties: transformBlockProperties(block.properties,operation,inverse) }));
  const entities = state.chunks.flatMap(chunk => decodeChunkBlob(chunk.blob).blockEntities ?? []).map(entity => ({ ...entity, ...point(entity.x,entity.z,true) }));
  const exits = state.exits.map(exit => ({ ...exit, ...point(exit.x,exit.z) }));
  const markers = state.markers.map(marker => ({ ...marker, ...point(marker.x,marker.z) }));
  const label = point(state.section.label_x,state.section.label_z);
  const trackerPoints = JSON.parse(state.section.tracker_points_json).map(p => ({ ...p, local: { ...p.local, ...point(p.local.x, p.local.z) } }));
  db.prepare('UPDATE sections SET tracker_points_json=? WHERE id=?').run(JSON.stringify(trackerPoints), sectionId);
  const tracking = db.prepare('SELECT calibration_json,tracking_orientation_json FROM sections WHERE id=?').get(sectionId);
  const orientation = tracking.tracking_orientation_json ? JSON.parse(tracking.tracking_orientation_json) : DEFAULT_TRACKING_ORIENTATION;
  const origin = point(0, 0), xAxis = point(1, 0), zAxis = point(0, 1);
  const a = xAxis.x - origin.x, b = zAxis.x - origin.x, c = xAxis.z - origin.z, d = zAxis.z - origin.z;
  const [oa, ob, oc, od] = orientation;
  const nextOrientation = [a * oa + b * oc, a * ob + b * od, c * oa + d * oc, c * ob + d * od];
  let calibration = tracking.calibration_json ? JSON.parse(tracking.calibration_json) : null;
  if (calibration) calibration = { ...calibration, local: { ...calibration.local, ...point(calibration.local.x, calibration.local.z, true) } };
  db.prepare('UPDATE sections SET tracking_orientation_json=?,calibration_json=? WHERE id=?').run(JSON.stringify(nextOrientation), calibration ? JSON.stringify(calibration) : null, sectionId);
  const connections = state.connections.map(connection => {
    const next = { ...connection };
    if (connection.section_a_id === sectionId) Object.assign(next, Object.fromEntries(Object.entries(point(connection.x_a,connection.z_a)).map(([axis,value]) => [`${axis}_a`,value])));
    if (connection.section_b_id === sectionId) Object.assign(next, Object.fromEntries(Object.entries(point(connection.x_b,connection.z_b)).map(([axis,value]) => [`${axis}_b`,value])));
    return next;
  });
  if (rotation % 180 !== 0) [bounds.x,bounds.z] = [bounds.z,bounds.x];
  const chunks = encodeSectionChunks(blocks, entities);
  db.prepare('DELETE FROM section_chunks WHERE section_id=?').run(sectionId);
  const insertChunk = db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)');
  for (const chunk of chunks) insertChunk.run(sectionId,chunk.cx,chunk.cy,chunk.cz,chunk.compressed);
  db.prepare('UPDATE sections SET bounds_json=?,label_x=?,label_z=? WHERE id=?').run(JSON.stringify(bounds),label.x,label.z,sectionId);
  const updateMarker = db.prepare('UPDATE markers SET x=?,z=? WHERE id=?');
  for (const marker of markers) updateMarker.run(marker.x,marker.z,marker.id);
  for (const exit of exits) db.prepare('UPDATE section_exits SET x=?,z=? WHERE id=?').run(exit.x, exit.z, exit.id);
  const updateConnection = db.prepare('UPDATE section_connections SET x_a=?,z_a=?,x_b=?,z_b=? WHERE id=?');
  for (const connection of connections) updateConnection.run(connection.x_a,connection.z_a,connection.x_b,connection.z_b,connection.id);
  validateSectionLayout(db, sectionId, db.prepare('SELECT placement_x FROM sections WHERE id=?').get(sectionId).placement_x, db.prepare('SELECT placement_z FROM sections WHERE id=?').get(sectionId).placement_z);
  return state;
}

/** Rotate or mirror all block geometry and attached anchors inside one section. */
export function transformSection(db, { sectionId, rotation = 0, flipHorizontal = false, flipVertical = false }, expectedRevision, inverse = false) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== projectRevision(db)) throw new Error('This project changed in another editor tab. Reload and retry your edit.');
  if (![0,90,180,270].includes(rotation) || typeof flipHorizontal !== 'boolean' || typeof flipVertical !== 'boolean') throw new Error('Choose a quarter-turn rotation and horizontal or vertical flips.');
  const tx = db.transaction(() => {
    const before = applySectionTransform(db, sectionId, { rotation, flipHorizontal, flipVertical }, inverse);
    advanceProjectRevision(db, expectedRevision);
    return before;
  });
  const before = tx();
  return { sectionId, rotation, flipHorizontal, flipVertical, inverse, revision: expectedRevision + 1 };
}

export function restoreSectionTransform(db, command, direction, expectedRevision) {
  if (direction !== 'undo' && direction !== 'redo') throw new Error('Choose undo or redo.');
  return transformSection(db, command, expectedRevision, direction === 'undo');
}

/** Persist one decoded schematic as an independent section in a shared schematic coordinate frame. */
export function importSchematicSection(db, schematic, { floorId = null, floorName = 'Floor 0', sectionName = 'Imported section', position = null } = {}) {
  if (position !== null && position !== 'middle' && !sectionDirections.includes(position)) throw new Error('Choose a valid import position.');
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
  const existingFloor = floorId ? snapshotProject(db).floors.find(floor => floor.id === floorId) : null;
  const existingSections = existingFloor?.sections ?? [];
  let placement = { placementX: 0, placementZ: 0 };
  if (existingSections.length) {
    if (position === 'middle') throw new Error('This floor already has a middle section. Choose a surrounding position.');
    const candidate = { id: sectionId, name: sectionName, bounds: dimensions, placementX: 0, placementZ: 0 };
    placement = sectionPlacement([...existingSections, candidate], sectionId, position ?? 'right', existingFloor.coordinateOrigin);
  } else if (position && position !== 'middle') throw new Error('The first section on a floor must be Middle.');
  const chunks = encodeSectionChunks(blocks, entities);
  const tx = db.transaction(() => {
    if (creatingFloor) {
      const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1)+1 AS next FROM floors').get().next;
      db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run(targetFloorId, floorName.trim(), order);
    }
    db.prepare("INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json,tracking_orientation_json) VALUES(?,?,?,?,?,?,?,'[1,0,0,1]')").run(
      sectionId, targetFloorId, sectionName.trim(), JSON.stringify(dimensions), placement.placementX, placement.placementZ,
      JSON.stringify({ litematicVersion: schematic.version, subVersion: schematic.subVersion, dataVersion: schematic.dataVersion, regionNames: schematic.regions.map(region => region.name) })
    );
    // Append after the current middle; UUID ordering must never choose a new middle.
    const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM sections WHERE floor_id=? AND id<>?').get(targetFloorId, sectionId).next;
    db.prepare('UPDATE sections SET sort_order=? WHERE id=?').run(nextOrder, sectionId);
    const insert = db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,?,?)');
    for (const chunk of chunks) insert.run(sectionId, chunk.cx, chunk.cy, chunk.cz, 1, chunk.compressed);
    db.prepare("INSERT OR REPLACE INTO project_meta(key,value) VALUES('schema_version','1'),('coordinate_contract','section-local x,y,z; chunks 16^3; index=(y*16+z)*16+x')").run();
    advanceProjectRevision(db);
  });
  tx();
  return { floorId: targetFloorId, sectionId, createdFloor: creatingFloor, dimensions, blockCount: blocks.length, chunkCount: chunks.length };
}
