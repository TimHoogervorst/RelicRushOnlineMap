import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const viewer = await readFile('public/viewer.js', 'utf8');
const follow = viewer.slice(viewer.indexOf('async function followConnection('), viewer.indexOf('// Stored marker coordinates'));

test('connections navigate both ways across floors and center using destination placement', async () => {
  const elements = new Map();
  const floors = [
    { id: 'low', sections: [{ id: 'a', placementX: 20, placementZ: 30 }] },
    { id: 'high', sections: [{ id: 'b', placementX: 100, placementZ: 200 }] },
  ];
  const context = vm.createContext({
    publicMap: { floors }, floorManifest: floors[0], pendingCenterMarker: null,
    document: { querySelector(id) { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
    refreshPublicManifest: async () => {},
    loadFloor: async id => { context.loaded = id; context.floorManifest = floors.find(floor => floor.id === id); },
    centerMarker: point => { context.centered = point; }, message: {},
    connection: { sectionAId: 'a', sectionBId: 'b', xA: 1.5, zA: 2.5, xB: 3.5, zB: 4.5 },
  });
  vm.runInContext(follow, context);
  await vm.runInContext("followConnection(connection, 'B')", context);
  assert.equal(context.loaded, 'high');
  assert.equal(elements.get('#floor').value, 'high');
  assert.equal(elements.get('#layout-section').value, 'b');
  assert.deepEqual(JSON.parse(JSON.stringify(context.pendingCenterMarker)), { x: 103.5, z: 204.5 });
  await vm.runInContext("followConnection(connection, 'A')", context);
  assert.equal(context.loaded, 'low');
  assert.deepEqual(JSON.parse(JSON.stringify(context.pendingCenterMarker)), { x: 21.5, z: 32.5 });
  context.loaded = null;
  await vm.runInContext("followConnection(connection, 'A')", context);
  assert.equal(context.loaded, null, 'same-floor navigation does not reload the image');
  assert.equal(context.centered.x, 21.5);
});
