import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual viewer handlers with a minimal DOM and API boundary.
const viewer = await readFile(new URL('../public/viewer.js', import.meta.url), 'utf8');
const source = viewer.slice(viewer.indexOf('function setBlockMoveStatus('), viewer.indexOf("viewport.addEventListener('dragover'"));
function harness(reply) {
  const elements = new Map(), requests = [], handlers = new Map();
  const context = vm.createContext({
    document: { querySelector(id) {
      if (!elements.has(id)) elements.set(id, { value: id === '#floor' ? 'f1' : '', textContent: '', addEventListener: (_, fn) => handlers.set(id, fn) });
      return elements.get(id);
    } },
    fetch: async (_, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      return reply(body);
    },
    renderSelection() {}, setSaveStatus() {}, updateSlicePreview() {},
    loadFloor: async () => {}, refreshSaveStatus: async () => {},
  });
  vm.runInContext(`let blockMoveBusy = false, selectedBlocks = [{x: 2, y: 3, z: 4}], pendingMoveDelta = 0,
    inspectedSection = {id: 's1', name: 'Cave'}, projectRevision = 1, inspectedCoords = null, inspectedBlock = null,
    visibleHeight = 10, sliceMaximum = 10, floorManifest = {sections: [inspectedSection]};\n${source}`, context);
  return { context, requests, elements, handlers, run: expression => vm.runInContext(expression, context) };
}
function accepted(body, saved = true) {
  return { ok: true, status: saved ? 200 : 202, json: async () => ({ revision: body.expectedRevision + 1, sectionId: body.sectionId, after: body.blocks.map(block => ({ ...block, y: block.y + body.dy })), saved, warning: 'Render failed' }) };
}

test('move controls retain updated coordinates for repeated up/down moves', async () => {
  const ui = harness(body => accepted(body));
  assert.ok(ui.handlers.has('#terrain-block-up'));
  assert.ok(ui.handlers.has('#terrain-block-down'));
  await ui.run('moveSelectedBlocks(1)');
  await ui.run('moveSelectedBlocks(1)');
  await ui.run('moveSelectedBlocks(-1)');
  assert.deepEqual(ui.requests.map(request => request.blocks[0].y), [3, 4, 5]);
  assert.deepEqual(ui.requests.map(request => request.expectedRevision), [1, 2, 3]);
  assert.equal(ui.run('selectedBlocks[0].y'), 4);
  assert.equal(ui.run('inspectedCoords.y'), 4);
});

test('rejected moves retain selection and release the busy state', async () => {
  const ui = harness(() => ({ ok: false, status: 409, json: async () => ({ error: 'Destination collision' }) }));
  await ui.run('moveSelectedBlocks(-1)');
  assert.equal(ui.run('selectedBlocks[0].y'), 3);
  assert.equal(ui.run('blockMoveBusy'), false);
  assert.match(ui.elements.get('#terrain-selection-status').textContent, /collision/);
});

test('concurrent clicks cannot duplicate moves; failed rendering retains committed coordinates', async () => {
  let resolve;
  const ui = harness(body => new Promise(done => { resolve = () => done(accepted(body, false)); }));
  const moving = ui.run('moveSelectedBlocks(1)');
  await ui.run('moveSelectedBlocks(1)');
  assert.equal(ui.requests.length, 1);
  resolve(); await moving;
  assert.equal(ui.run('selectedBlocks[0].y'), 4);
  assert.equal(ui.run('projectRevision'), 2);
  assert.match(ui.elements.get('#terrain-selection-status').textContent, /Use Save to retry/);
});
