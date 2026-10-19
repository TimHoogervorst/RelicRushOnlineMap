import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionPlacement, currentSectionDirection, sectionDirections } from '../public/section-placement.js';
import { openProject, encodeSectionChunks, readSectionBlocks, snapshotProject, setSectionLayout, restoreSectionLayout, importSchematicSection, projectRevision } from '../src/project-store.js';

test('eight directions surround the middle with a gap and survive coordinate normalization', () => {
  const sections = [{ id: 'm', name: 'Middle', placementX: 10, placementZ: 20, bounds: { x: 20, z: 10 } }, { id: 's', placementX: 100, placementZ: 100, bounds: { x: 6, z: 4 } }];
  assert.deepEqual(sectionPlacement(sections, 's', 'left'), { placementX: 0, placementZ: 23 });
  assert.deepEqual(sectionPlacement(sections, 's', 'right'), { placementX: 34, placementZ: 23 });
  assert.deepEqual(sectionPlacement(sections, 's', 'top'), { placementX: 17, placementZ: 34 });
  assert.deepEqual(sectionPlacement(sections, 's', 'bottom'), { placementX: 17, placementZ: 12 });
  for (const direction of sectionDirections) {
    const moved = { ...sections[1], ...sectionPlacement(sections, 's', direction) };
    assert.equal(currentSectionDirection([sections[0], moved], 's'), direction);
  }
  assert.equal(currentSectionDirection(sections, 'm'), 'middle');
  assert.equal(currentSectionDirection(sections, 's'), '');
  assert.throws(() => sectionPlacement(sections, 's', 'invalid'), /Choose a position/);
});

test('expanded local bounds and occupied positions are respected', () => {
  const middle = { id: 'm', name: 'Middle', placementX: 5, placementZ: 5, bounds: { x: 5, z: 5 }, localBounds: { minX: -2, minZ: -1, maxX: 8, maxZ: 6 } };
  const section = { id: 's', name: 'Cave', placementX: 50, placementZ: 50, bounds: { x: 4, z: 4 }, localBounds: { minX: -3, minZ: 0, maxX: 4, maxZ: 4 } };
  const placement = sectionPlacement([middle, section], 's', 'right');
  assert.equal(placement.placementX + section.localBounds.minX - (middle.placementX + middle.localBounds.maxX), 4);
  const occupied = { ...section, ...placement, id: 'occupied', name: 'Other cave' };
  assert.throws(() => sectionPlacement([middle, section, occupied], 's', 'right'), /overlaps Other cave/);
});

test('directional placement persists and undoes without changing local blocks', () => {
  const db = openProject(':memory:');
  try {
    db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('f','Floor',0);
    for (const [id, order] of [['m',0],['s',1]]) {
      db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json,sort_order) VALUES(?,?,?,?,?,?,?,?)').run(id,'f',id,JSON.stringify({x:4,y:1,z:4}),order*20,0,'{}',order);
      for (const c of encodeSectionChunks([{x:1,y:0,z:2,id:'minecraft:stone',properties:{}}])) db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)').run(id,c.cx,c.cy,c.cz,c.compressed);
    }
    db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run();
    const before=readSectionBlocks(db,'s'), floor=snapshotProject(db).floors[0];
    const command=setSectionLayout(db,{sectionId:'s',...sectionPlacement(floor.sections,'s','left',floor.coordinateOrigin)},1);
    assert.equal(currentSectionDirection(snapshotProject(db).floors[0].sections,'s'),'left');
    assert.deepEqual(readSectionBlocks(db,'s'),before);
    assert.equal(db.prepare("SELECT placement_x FROM sections WHERE id='s'").get().placement_x,-8);
    restoreSectionLayout(db,command,'undo',2);
    assert.equal(db.prepare("SELECT placement_x FROM sections WHERE id='s'").get().placement_x,20);
  } finally {db.close();}
});

test('imports append around the original middle and reject occupied positions atomically', () => {
  const db=openProject(':memory:');
  const schematic={version:7,subVersion:1,dataVersion:5023,regions:[{name:'Room',min:{x:0,y:0,z:0},dimensions:{x:4,y:1,z:4},blocks:[{x:1,y:0,z:2,id:'minecraft:stone',properties:{}}]}]};
  try {
    const first=importSchematicSection(db,schematic,{position:'middle'});
    for (const direction of sectionDirections) {
      const added=importSchematicSection(db,schematic,{floorId:first.floorId,position:direction});
      const floor=snapshotProject(db).floors[0];
      assert.equal(floor.sections[0].id,first.sectionId);
      assert.equal(currentSectionDirection(floor.sections,added.sectionId),direction);
      assert.deepEqual(readSectionBlocks(db,added.sectionId),readSectionBlocks(db,first.sectionId));
    }
    const revision=projectRevision(db);
    for(const position of ['middle','left','invalid']) assert.throws(()=>importSchematicSection(db,schematic,{floorId:first.floorId,position}));
    assert.equal(projectRevision(db),revision);
    assert.equal(snapshotProject(db).floors[0].sections.length,9);
  } finally {db.close();}
});
