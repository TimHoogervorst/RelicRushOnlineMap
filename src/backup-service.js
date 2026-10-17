import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readdir, rm, stat, writeFile, readFile, rename } from 'node:fs/promises';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createArchive, makeManifest, readArchive, validateManifest } from './backup-archive.js';

const MAX_FILE = 512 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const EXCLUDED = /(^|\/)(?:\.building-[^/]+|[^/]*\.tmp|asset-upload-[^/]+|resource-pack-upload-[^/]+)$/;
function relativeSafe(root, file) { const relative = path.relative(root, file).split(path.sep).join('/'); if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Unsafe file path while preparing project backup.'); return relative; }

async function collectFiles(directory, prefix, output, budget) {
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name), relative = `${prefix}/${entry.name}`;
    if (EXCLUDED.test(relative)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Project contains a symbolic link that cannot be backed up: ${relative}`);
    if (entry.isDirectory()) await collectFiles(full, relative, output, budget);
    else if (entry.isFile()) { const info = await stat(full); budget.total += info.size; if (info.size > MAX_FILE || budget.total > MAX_TOTAL) throw new Error('Project files exceed the backup decoded size limit.'); output.set(relative, await readFile(full)); }
  }
}

export async function createProjectBackup({ dataDir, recovery = false }) {
  await mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'project.sqlite'), dbTemp = path.join(dataDir, `.backup-${randomUUID()}.sqlite`);
  const files = new Map();
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { await db.backup(dbTemp); } finally { db.close(); }
    files.set('project.sqlite', await readFile(dbTemp));
    const budget = { total: files.get('project.sqlite').length };
    await collectFiles(path.join(dataDir, 'assets'), 'assets', files, budget);
    await collectFiles(path.join(dataDir, 'releases'), 'releases', files, budget);
    const manifest = makeManifest(files); files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    const archive = createArchive(files);
    if (recovery) await saveRecoverySnapshot(dataDir, archive);
    return archive;
  } finally { await rm(dbTemp, { force: true }).catch(() => {}); }
}

async function saveRecoverySnapshot(dataDir, archive) {
  const directory = path.join(dataDir, 'backups', 'recovery'); await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.zip`);
  await writeFile(file, archive, { flag: 'wx', mode: 0o600 });
  const files = (await readdir(directory, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.zip')).map(item => item.name).sort().reverse();
  for (const old of files.slice(5)) await rm(path.join(directory, old), { force: true });
}

function validateDatabase(bytes) {
  const file = path.join(os.tmpdir(), `rr-validate-${randomUUID()}.sqlite`);
  try {
    writeFileSync(file, bytes, { mode: 0o600 });
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup database failed SQLite integrity validation.');
      if (db.pragma('foreign_key_check').length) throw new Error('Backup database contains dangling project references.');
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      for (const table of ['project_meta', 'floors', 'sections', 'section_chunks', 'markers', 'custom_marker_types', 'section_connections', 'section_render_settings']) if (!tables.has(table)) throw new Error(`Backup database is missing required table ${table}.`);
      const schema = Number(db.prepare("SELECT value FROM project_meta WHERE key='schema_version'").get()?.value ?? 1);
      if (schema !== 1) throw new Error(`Backup database schema version ${schema} is unsupported.`);
    } finally { db.close(); }
  } finally { rmSync(file, { force: true }); }
}

function validateReferences(files) {
  const pointerBytes = files.get('releases/current.json');
  if (!pointerBytes) return;
  let pointer; try { pointer = JSON.parse(pointerBytes.toString('utf8')); } catch { throw new Error('Backup release pointer is invalid.'); }
  if (!Number.isSafeInteger(pointer.revision) || pointer.revision < 0 || pointer.directory !== `revision-${pointer.revision}`) throw new Error('Backup release pointer references an unsafe revision.');
  const manifestPath = `releases/${pointer.directory}/manifest.json`, manifestBytes = files.get(manifestPath);
  if (!manifestBytes) throw new Error('Backup release pointer references a missing map revision.');
  let manifest; try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('Backup map manifest is invalid.'); }
  if (manifest.projectRevision !== pointer.revision || !Array.isArray(manifest.floors)) throw new Error('Backup map revision does not match its release pointer.');
  for (const floor of manifest.floors) {
    if (typeof floor.image !== 'string' || path.basename(floor.image) !== floor.image || !files.has(`releases/${pointer.directory}/${floor.image}`)) throw new Error('Backup map manifest references a missing or unsafe image.');
    if (floor.heightGrid) {
      const relative = floor.heightGrid.path;
      if (typeof relative !== 'string' || path.basename(relative) !== relative || !Number.isSafeInteger(floor.heightGrid.projectRevision) || !Number.isSafeInteger(floor.heightGrid.width) || !Number.isSafeInteger(floor.heightGrid.depth)) throw new Error('Backup map manifest references an unsafe height grid.');
      const bytes = files.get(`releases/${pointer.directory}/${relative}`);
      if (!bytes) throw new Error('Backup map manifest references a missing height grid.');
      let grid; try { grid = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Backup height grid is invalid.'); }
      if (grid.format !== 'rr-map-surface-height-grid' || grid.version !== 1 || grid.floorId !== floor.id || grid.projectRevision !== floor.heightGrid.projectRevision || !Array.isArray(grid.values) || grid.values.length !== floor.heightGrid.depth || grid.values.some(row => !Array.isArray(row) || row.length !== floor.heightGrid.width)) throw new Error('Backup height grid does not match its manifest reference.');
    }
  }
}

export function validateProjectBackup(bytes) {
  const files = readArchive(bytes); const manifest = validateManifest(files); validateDatabase(files.get('project.sqlite')); validateReferences(files); return { files, manifest };
}

async function writeFiles(directory, files, prefix) {
  for (const [name, data] of files) if (name.startsWith(`${prefix}/`)) {
    const relative = name.slice(prefix.length + 1).split('/'); if (relative.some(part => !part || part === '.' || part === '..')) throw new Error('Archive path traversal rejected.');
    const target = path.join(directory, ...relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data, { flag: 'wx', mode: 0o600 });
  }
}

export async function restoreProjectBackup({ dataDir, bytes, confirm }) {
  if (confirm !== 'RESTORE PROJECT') throw new Error('Explicit restore confirmation is required.');
  const { files } = validateProjectBackup(bytes);
  await mkdir(dataDir, { recursive: true });
  const stage = path.join(dataDir, `.restore-stage-${randomUUID()}`), rollback = path.join(dataDir, `.restore-rollback-${randomUUID()}`);
  let keepRollback = false;
  await mkdir(stage, { recursive: true }); await mkdir(rollback, { recursive: true });
  try {
    await writeFile(path.join(stage, 'project.sqlite'), files.get('project.sqlite'), { flag: 'wx', mode: 0o600 });
    await writeFiles(path.join(stage, 'assets'), files, 'assets'); await writeFiles(path.join(stage, 'releases'), files, 'releases');
    if (existsSync(path.join(dataDir, 'project.sqlite'))) await createProjectBackup({ dataDir, recovery: true });
    const live = ['project.sqlite', 'project.sqlite-wal', 'project.sqlite-shm', 'assets', 'releases'];
    const moved = [];
    try {
      for (const name of live) {
        const source = path.join(dataDir, name); try { await rename(source, path.join(rollback, name)); moved.push(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const name of ['project.sqlite', 'assets', 'releases']) {
        const source = path.join(stage, name); try { await rename(source, path.join(dataDir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await rm(rollback, { recursive: true, force: true });
      return { restored: true, files: files.size };
    } catch (error) {
      for (const name of ['project.sqlite', 'assets', 'releases']) await rm(path.join(dataDir, name), { recursive: true, force: true });
      const rollbackErrors = [];
      for (const name of moved) { try { await rename(path.join(rollback, name), path.join(dataDir, name)); } catch (restoreError) { rollbackErrors.push(`${name}: ${restoreError.message}`); } }
      if (rollbackErrors.length) { keepRollback = true; throw new Error(`Restore failed (${error.message}); prior files remain in ${rollback} because rollback could not finish: ${rollbackErrors.join('; ')}`); }
      throw new Error(`Restore failed and the prior project was rolled back: ${error.message}`);
    }
  } finally { await rm(stage, { recursive: true, force: true }); if (!keepRollback) await rm(rollback, { recursive: true, force: true }); }
}
