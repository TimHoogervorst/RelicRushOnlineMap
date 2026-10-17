import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { openProject, projectRevision, renameFloor, reorderFloor, renameSection, reorderSection, moveSectionToFloor, saveMarker, linkStairs, saveSectionConnection, sectionDependents, deleteSectionLifecycle, deleteFloorLifecycle, captureProjectLifecycleState, restoreProjectLifecycleState, readMarker } from '../src/project-store.js';

function seed() {
  const db = openProject(':memory:');
  for (const [id,name,order] of [['floor-0','Floor 0',0],['f1','Floor 1',1],['f2','Floor 2',2]]) db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run(id,name,order);
  for (const [id,floor,x] of [['section-start-0f','floor-0',0],['a','f1',0],['b','f1',20],['c','f2',0]]) db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json,sort_order) VALUES(?,?,?,?,?,?,?,?)').run(id,floor,id,JSON.stringify({x:8,y:4,z:8}),x,0,'{}',0);
  return db;
}

test('floor and section rename/reorder preserve stable IDs and use revision checks', () => {
  const db = seed();
  try {
    renameFloor(db,'f1','Upper',0); reorderFloor(db,'f1',0,1); renameSection(db,'a','North Wing',2); reorderSection(db,'b',0,3);
    assert.equal(db.prepare('SELECT id,name,sort_order FROM floors WHERE id=?').get('f1').name,'Upper');
    assert.equal(db.prepare('SELECT id,name FROM sections WHERE id=?').get('a').name,'North Wing');
    assert.equal(db.prepare('SELECT id FROM sections WHERE floor_id=? ORDER BY sort_order').all('f1')[0].id,'b');
    assert.throws(() => renameFloor(db,'f1','stale',3),/another editor tab/i);
  } finally { db.close(); }
});

test('section move preserves IDs but rejects dotted links and stairs that become same-floor', () => {
  const db = seed();
  try {
    saveSectionConnection(db,{sectionAId:'a',xA:1,zA:1,sectionBId:'b',xB:1,zB:1},0);
    assert.throws(() => moveSectionToFloor(db,'a','f2',1),/connections/i);
    db.prepare('DELETE FROM section_connections').run();
    const m1 = saveMarker(db,{sectionId:'a',type:'stairs',name:'A',x:1,z:1},1);
    const m2 = saveMarker(db,{sectionId:'c',type:'stairs',name:'C',x:1,z:1},2);
    linkStairs(db,m1.id,m2.id,3);
    assert.throws(() => moveSectionToFloor(db,'a','f2',4),/unlink stairs/i);
    assert.equal(db.prepare('SELECT floor_id FROM sections WHERE id=?').get('a').floor_id,'f1');
    assert.equal(projectRevision(db),4);
  } finally { db.close(); }
});

test('section deletion requires explicit dependency resolution and rolls back invalid ownership conversion', () => {
  const db = seed();
  try {
    const marker = saveMarker(db,{sectionId:'a',type:'other',name:'M',x:1,z:1},0);
    const conn = saveSectionConnection(db,{sectionAId:'a',xA:1,zA:1,sectionBId:'b',xB:2,zB:2},1);
    assert.throws(() => deleteSectionLifecycle(db,'a',null,2), error => error.dependents.markers[0].id === marker.id && error.dependents.connections[0].id === conn.id);
    assert.throws(() => deleteSectionLifecycle(db,'a',{markers:'reassign',sectionId:'c',deleteConnections:[conn.id]},2),/same floor/i);
    assert.equal(db.prepare('SELECT section_id FROM markers WHERE id=?').get(marker.id).section_id,'a');
    deleteSectionLifecycle(db,'a',{markers:'reassign',sectionId:'b',deleteConnections:[conn.id]},2);
    assert.equal(db.prepare('SELECT section_id FROM markers WHERE id=?').get(marker.id).section_id,'b');
    assert.equal(db.prepare('SELECT 1 FROM section_connections WHERE id=?').get(conn.id),undefined);
  } finally { db.close(); }
});

test('lifecycle undo restores deleted markers, reciprocal stairs, and dotted connections atomically', () => {
  const db = seed();
  try {
    const stair = saveMarker(db,{sectionId:'a',type:'stairs',name:'A stair',x:1,z:1},0);
    const partner = saveMarker(db,{sectionId:'c',type:'stairs',name:'C stair',x:2,z:2},1);
    linkStairs(db,stair.id,partner.id,2);
    const connection = saveSectionConnection(db,{sectionAId:'a',xA:1,zA:1,sectionBId:'b',xB:2,zB:2},3);
    const before = captureProjectLifecycleState(db);
    deleteSectionLifecycle(db,'a',{markers:'delete',deleteConnections:[connection.id]},4);
    assert.equal(readMarker(db,stair.id),null);
    assert.equal(readMarker(db,partner.id).stairDestinationId,null);
    assert.equal(db.prepare('SELECT 1 FROM section_connections WHERE id=?').get(connection.id),undefined);
    restoreProjectLifecycleState(db,before,5);
    assert.equal(readMarker(db,stair.id).stairDestinationId,partner.id);
    assert.equal(readMarker(db,partner.id).stairDestinationId,stair.id);
    assert.equal(db.prepare('SELECT 1 FROM section_connections WHERE id=?').get(connection.id) !== undefined,true);
    assert.equal(projectRevision(db),6);
  } finally { db.close(); }
});

test('floor deletion protects built-in floor and atomically reassigns only compatible sections', () => {
  const db = seed();
  try {
    assert.throws(() => deleteFloorLifecycle(db,'floor-0',{destinationFloorId:'f1'},0),/built-in/i);
    assert.throws(() => deleteFloorLifecycle(db,'f1',null,0), error => error.dependents.sections.includes('a'));
    deleteFloorLifecycle(db,'f1',{destinationFloorId:'floor-0'},0);
    assert.equal(db.prepare('SELECT 1 FROM floors WHERE id=?').get('f1'),undefined);
    assert.equal(db.prepare('SELECT floor_id FROM sections WHERE id=?').get('a').floor_id,'floor-0');
  } finally { db.close(); }
});

test('floor reassignment preserves internal section connections and rolls back stairs that would become same-floor', () => {
  const db = seed();
  try {
    saveSectionConnection(db,{sectionAId:'a',xA:1,zA:1,sectionBId:'b',xB:1,zB:1},0);
    deleteFloorLifecycle(db,'f1',{destinationFloorId:'f2'},1);
    assert.equal(db.prepare('SELECT floor_id FROM sections WHERE id=?').get('a').floor_id,'f2');
    assert.equal(db.prepare('SELECT count(*) count FROM section_connections').get().count,1);
    db.close();

    const other = seed();
    try {
      const first = saveMarker(other,{sectionId:'a',type:'stairs',name:'A',x:1,z:1},0);
      const second = saveMarker(other,{sectionId:'c',type:'stairs',name:'C',x:1,z:1},1);
      linkStairs(other,first.id,second.id,2);
      assert.throws(() => deleteFloorLifecycle(other,'f1',{destinationFloorId:'f2'},3),/unlink stairs/i);
      assert.equal(other.prepare('SELECT 1 FROM floors WHERE id=?').get('f1') !== undefined,true);
      assert.equal(other.prepare('SELECT floor_id FROM sections WHERE id=?').get('a').floor_id,'f1');
    } finally { other.close(); }
  } finally { try { db.close(); } catch {} }
});

test('unresolved legacy references are retained in project diagnostics', async () => {
  const db = seed();
  try {
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO markers(id,section_id,type,name,description,x,z) VALUES(?,?,?,?,?,?,?)').run('legacy-marker','missing-section','other','Legacy','',1,1);
    const { snapshotProject } = await import('../src/project-store.js');
    assert.deepEqual(snapshotProject(db).unresolvedRecords.markers,[{id:'legacy-marker',sectionId:'missing-section'}]);
  } finally { db.close(); }
});

test('lifecycle API requires editor auth and metadata rename refreshes visitor output', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(),'rr-lifecycle-'));
  const db = openProject(path.join(dataDir,'project.sqlite'));
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('floor-0','Old name',0);
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,provenance_json) VALUES(?,?,?,?,?)').run('section-start-0f','floor-0','Start',JSON.stringify({x:1,y:1,z:1}),'{}');
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,provenance_json) VALUES(?,?,?,?,?)').run('section-extra','floor-0','Extra',JSON.stringify({x:1,y:1,z:1}),'{}');
  db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run();
  db.close();
  const renderer = { async render({output}) { await writeFile(output,Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1])); return {width:1,height:1,bounds:{width:1,depth:1},renderer:{pixelSize:1}}; } };
  const server = createServer(createApp({dataDir,password:'secret',initializeWorker:false,renderer}));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir,{recursive:true,force:true}); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/api/project/lifecycle/undo`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({expectedRevision:1})})).status,401);
  const route = `${origin}/api/project/floors/floor-0`;
  assert.equal((await fetch(route,{method:'PUT',headers:{'content-type':'application/json',origin},body:JSON.stringify({name:'Visitor title',expectedRevision:0})})).status,401);
  const login = await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({password:'secret'})});
  const headers = {cookie:login.headers.get('set-cookie').split(';')[0],origin,'content-type':'application/json'};
  const baseline = await fetch(`${origin}/api/generation/save`,{method:'POST',headers,body:JSON.stringify({expectedRevision:1})});
  assert.equal(baseline.status,200,(await baseline.clone().json()).error);
  const response = await fetch(route,{method:'PUT',headers,body:JSON.stringify({name:'Visitor title',expectedRevision:1})});
  assert.equal(response.status,200,(await response.clone().json()).error);
  const manifest = await fetch(`${origin}/api/map/manifest`).then(item => item.json());
  assert.equal(manifest.floors[0].name,'Visitor title');
  const undo = await fetch(`${origin}/api/project/lifecycle/undo`,{method:'POST',headers,body:JSON.stringify({expectedRevision:2})});
  assert.equal(undo.status,200,(await undo.clone().json()).error);
  assert.equal((await fetch(`${origin}/api/map/manifest`).then(item => item.json())).floors[0].name,'Old name');
  const redo = await fetch(`${origin}/api/project/lifecycle/redo`,{method:'POST',headers,body:JSON.stringify({expectedRevision:3})});
  assert.equal(redo.status,200,(await redo.clone().json()).error);
  assert.equal((await fetch(`${origin}/api/map/manifest`).then(item => item.json())).floors[0].name,'Visitor title');
  const deleted = await fetch(`${origin}/api/project/sections/section-extra`,{method:'DELETE',headers,body:JSON.stringify({expectedRevision:4,resolution:{markers:'delete',deleteConnections:[]}})});
  assert.equal(deleted.status,200,(await deleted.clone().json()).error);
  const restored = await fetch(`${origin}/api/project/lifecycle/undo`,{method:'POST',headers,body:JSON.stringify({expectedRevision:5})});
  assert.equal(restored.status,200,(await restored.clone().json()).error);
  const editorProject = await fetch(`${origin}/api/project/floors`,{headers}).then(item => item.json());
  assert.equal(editorProject.sections.some(section => section.id === 'section-extra'),true,'undo restores deleted section ownership');
});
