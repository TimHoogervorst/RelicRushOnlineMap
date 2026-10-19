import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { openProject, encodeSectionChunks, snapshotProject, transformSection } from '../src/project-store.js';
const viewer = await readFile('public/viewer.js', 'utf8');
let render = viewer.slice(viewer.indexOf('function markerScreenZ('), viewer.indexOf("let selectedExitId ="));
test('markers align and drag back to block centers at every rotation and section offset', async () => {
for (const rotation of [0, 90, 180, 270]) {
 for (const offset of [0, -20]) {
  const db = openProject(':memory:');
  db.prepare('INSERT INTO floors(id,name,sort_order) VALUES(?,?,?)').run('f', 'Floor', 0);
  db.prepare('INSERT INTO sections(id,floor_id,name,bounds_json,placement_x,placement_z,provenance_json) VALUES(?,?,?,?,?,?,?)').run('s', 'f', 'Room', JSON.stringify({ x: 4, y: 1, z: 8 }), 0, 0, '{}');
  const blocks = [{ x: 0, y: 0, z: 0, id: 'minecraft:stone', properties: {} }, { x: 3, y: 0, z: 7, id: 'minecraft:dirt', properties: {} }];
  for (const c of encodeSectionChunks(blocks)) db.prepare('INSERT INTO section_chunks(section_id,chunk_x,chunk_y,chunk_z,format_version,blob) VALUES(?,?,?,?,1,?)').run('s', c.cx, c.cy, c.cz, c.compressed);
  db.prepare("UPDATE project_meta SET value='1' WHERE key='revision'").run();
  db.prepare('UPDATE sections SET placement_x=?,placement_z=? WHERE id=?').run(offset, offset, 's');
  db.prepare('INSERT INTO markers(id,section_id,type,name,description,x,z) VALUES(?,?,?,?,?,?,?)').run('existing', 's', 'other', 'Before rotation', '', .5, .5);
  if (rotation) transformSection(db, { sectionId: 's', rotation }, 1);
  let floor = snapshotProject(db).floors[0];
  const target = floor.blocks.find(block => block.id === 'minecraft:stone');
  db.prepare('INSERT INTO markers(id,section_id,type,name,description,x,z) VALUES(?,?,?,?,?,?,?)').run('m', 's', 'other', 'Target', '', target.localX + .5, target.localZ + .5);
  floor = snapshotProject(db).floors[0];
  const elements = new Map();
  const element = () => ({ style: { setProperty() {} }, dataset: {}, classList: { toggle() {} }, children: [], handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, setPointerCapture() {}, setAttribute() {}, append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; }, value: '' });
  const context = vm.createContext({ floorManifest: { ...floor, bounds: { depth: floor.dimensions.z }, renderer: { pixelSize: 8 } },
    document: { createElement: element, querySelector(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
    Option: function() {}, markerType: () => ({ color: 'white' }), markerTypes: () => [], inventoryIcon: () => '', markerTitle: () => '',
    editorOpen: true, highlightedMarker: null, renderCustomMarkerTypeEditor() {}, pruneMarkerVisibility() {},
    markerDrag: null, zoom: 2, frame: { getBoundingClientRect: () => ({ left: 100, top: 50 }) }, populateMarkerForm() {}, persistMarker: async () => {},
  });
  vm.runInContext(render + '\nrenderMarkers();', context);
  for (const marker of elements.get('#marker-layer').children) {
  const expectedX = (target.x + .5) * 8;
  // The rasterizer draws block z at image row depth-z-1; its center is depth-z-.5.
  const expectedY = (floor.dimensions.z - target.z - .5) * 8;
  const actualX = parseFloat(marker.style.left), actualY = parseFloat(marker.style.top);
  const pass = actualX === expectedX && actualY === expectedY;
  assert.ok(pass, `rotation=${rotation}, offset=${offset}, marker=${marker.dataset.markerId}: expected (${expectedX}, ${expectedY}), got (${actualX}, ${actualY})`);
  marker.handlers.pointerdown({ pointerId: 1, stopPropagation() {}, preventDefault() {} });
  marker.handlers.pointermove({ pointerId: 1, clientX: 100 + expectedX * 2, clientY: 50 + expectedY * 2 });
  await marker.handlers.pointerup({ pointerId: 1 });
  assert.equal(Number(elements.get('#marker-x').value), target.localX);
  assert.equal(Number(elements.get('#marker-z').value), target.localZ);
  }
  db.close();
 }
}
});

test('marker form displays block numbers and saves centers without moving existing anchors', async () => {
  const elements = new Map();
  const context = vm.createContext({
    document: { querySelector(id) { if (!elements.has(id)) elements.set(id, { value: '', checked: false }); return elements.get(id); } },
    floorManifest: { sections: [{ id: 's' }], markers: [] }, initialMarkerSection: null, initialMarkerDisplay: null,
    refreshStairControls() {}, projectRevision: 1, setSaveStatus() {},
    fetch: async (_, options) => { context.request = JSON.parse(options.body); return { ok: true, json: async () => ({ saved: false, warning: 'fixture' }) }; },
  });
  const populate = viewer.slice(viewer.indexOf('function populateMarkerForm('), viewer.indexOf('async function refreshStairControls('));
  const persist = viewer.slice(viewer.indexOf('async function persistMarker('), viewer.indexOf("document.querySelector('#marker-form').addEventListener"));
  vm.runInContext(populate + persist, context);
  vm.runInContext("populateMarkerForm({id: 'm', sectionId: 's', localX: 93.5, localZ: 62.5, x: 93.5, z: 62.5})", context);
  assert.equal(elements.get('#marker-x').value, 93);
  assert.equal(elements.get('#marker-z').value, 62);
  await vm.runInContext('persistMarker()', context);
  assert.equal(context.request.marker.x, 93.5);
  assert.equal(context.request.marker.z, 62.5);
  vm.runInContext("populateMarkerForm({id: 'm', sectionId: 's', localX: 93, localZ: 62, x: 93, z: 62})", context);
  await vm.runInContext('persistMarker()', context);
  assert.equal(context.request.marker.x, 93);
  assert.equal(context.request.marker.z, 62);
});
