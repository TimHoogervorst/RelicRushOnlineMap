import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { encodeSectionChunks, openProject, readSectionBlocks, snapshotProject } from '../src/project-store.js';
import { createProjectBackup, restoreProjectBackup, validateProjectBackup } from '../src/backup-service.js';

async function temp(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-backup-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function seed(dataDir, id) { const db = openProject(path.join(dataDir, 'project.sqlite')); db.prepare("INSERT INTO floors(id,name,sort_order) VALUES(?,?,0)").run(id, `Floor ${id}`); db.close(); }

test('portable backup restores a complete database and files into a fresh data volume', async t => {
  const source = path.join(await temp(t), 'source'), target = path.join(await temp(t), 'target'); await mkdir(path.join(source, 'assets', 'resource-pack'), { recursive: true }); await mkdir(path.join(source, 'assets', 'minecraft'), { recursive: true });
  const dbSeed = openProject(path.join(source, 'project.sqlite'));
  dbSeed.prepare("INSERT INTO floors(id,name,sort_order) VALUES('floor-a','Original',0),('floor-b','Floor B',1)").run();
  const addSection = dbSeed.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,provenance_json,sort_order) VALUES(?,?,?,?,?,?)');
  addSection.run('section-a', 'floor-a', 'A', '{"width":2,"height":1,"depth":2}', '{}', 0); addSection.run('section-c', 'floor-a', 'C', '{"width":2,"height":1,"depth":2}', '{}', 1); addSection.run('section-b', 'floor-b', 'B', '{"width":2,"height":1,"depth":2}', '{}', 0);
  dbSeed.prepare('UPDATE sections SET placement_x=123,placement_z=-45,label_x=0.25,label_z=1.5 WHERE id=?').run('section-a');
  const chunk = encodeSectionChunks([{ x: 1, y: 0, z: 1, id: 'minecraft:stone', properties: {} }])[0]; dbSeed.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)').run('section-a', chunk.cx, chunk.cy, chunk.cz, chunk.compressed);
  dbSeed.prepare("INSERT INTO custom_marker_types(id,name,color,icon) VALUES('custom','Custom','#aa22cc','other')").run();
  const marker = dbSeed.prepare('INSERT INTO markers(id,section_id,type,name,description,x,z) VALUES(?,?,?,?,?,?,?)'); marker.run('stair-a','section-a','stairs','Upper','',0.5,0.5); marker.run('stair-b','section-b','stairs','Lower','',1.5,1.5); marker.run('custom-marker','section-c','custom','Custom point','details',0.5,1.5);
  dbSeed.prepare("UPDATE markers SET stair_destination_id=CASE id WHEN 'stair-a' THEN 'stair-b' ELSE 'stair-a' END WHERE id IN ('stair-a','stair-b')").run();
  dbSeed.prepare("INSERT INTO section_connections(id,section_a_id,x_a,z_a,section_b_id,x_b,z_b,label) VALUES('door','section-a',1,1,'section-c',0,0,'Door')").run();
  dbSeed.prepare("INSERT INTO section_render_settings(section_id,settings_json) VALUES('section-a','{\"pixelSize\":12}')").run(); dbSeed.close();
  await writeFile(path.join(source, 'assets', 'minecraft', 'asset-source.json'), '{"version":"26.3"}'); await writeFile(path.join(source, 'assets', 'resource-pack', 'pack.mcmeta'), '{"pack":{}}');
  const archive = await createProjectBackup({ dataDir: source }); const checked = validateProjectBackup(archive); assert.ok(checked.files.has('assets/minecraft/asset-source.json'));
  await assert.rejects(restoreProjectBackup({ dataDir: target, bytes: archive, confirm: 'no' }), /confirmation/i);
  await restoreProjectBackup({ dataDir: target, bytes: archive, confirm: 'RESTORE PROJECT' });
  const db = openProject(path.join(target, 'project.sqlite')); const project = snapshotProject(db); assert.equal(project.floors[0].id, 'floor-a'); assert.equal(project.floors[0].sections.length, 2); assert.equal(readSectionBlocks(db, 'section-a')[0].id, 'minecraft:stone');
  assert.deepEqual(db.prepare('SELECT placement_x,placement_z,label_x,label_z FROM sections WHERE id=?').get('section-a'), { placement_x: 123, placement_z: -45, label_x: 0.25, label_z: 1.5 });
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM custom_marker_types').get().total, 1); assert.equal(db.prepare('SELECT COUNT(*) AS total FROM section_connections').get().total, 1); assert.equal(db.prepare('SELECT COUNT(*) AS total FROM markers WHERE stair_destination_id IS NOT NULL').get().total, 2); assert.equal(db.prepare('SELECT settings_json FROM section_render_settings WHERE section_id=?').get('section-a').settings_json, '{"pixelSize":12}'); db.close();
  assert.equal(await readFile(path.join(target, 'assets', 'resource-pack', 'pack.mcmeta'), 'utf8'), '{"pack":{}}');
});

test('corrupt archive validation fails before touching current database or public files', async t => {
  const dataDir = path.join(await temp(t), 'volume'); await mkdir(dataDir, { recursive: true }); seed(dataDir, 'live'); await mkdir(path.join(dataDir, 'releases'), { recursive: true }); await writeFile(path.join(dataDir, 'releases', 'public.txt'), 'still live');
  const archive = await createProjectBackup({ dataDir }); const damaged = Buffer.from(archive); damaged[40] ^= 0x20;
  await assert.rejects(restoreProjectBackup({ dataDir, bytes: damaged, confirm: 'RESTORE PROJECT' }));
  const db = openProject(path.join(dataDir, 'project.sqlite')); assert.equal(snapshotProject(db).floors[0].id, 'live'); db.close();
  assert.equal(await readFile(path.join(dataDir, 'releases', 'public.txt'), 'utf8'), 'still live');
});

test('recovery keeps only the newest five snapshots', async t => {
  const dataDir = path.join(await temp(t), 'volume'); await mkdir(dataDir, { recursive: true }); seed(dataDir, 'live');
  for (let index = 0; index < 6; index++) await createProjectBackup({ dataDir, recovery: true });
  const entries = await (await import('node:fs/promises')).readdir(path.join(dataDir, 'backups', 'recovery'));
  assert.equal(entries.filter(name => name.endsWith('.zip')).length, 5);
});
