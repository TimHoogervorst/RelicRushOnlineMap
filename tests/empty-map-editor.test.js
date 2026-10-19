import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const viewer = await readFile(new URL('../public/viewer.js', import.meta.url), 'utf8');
const sessionSource = viewer.slice(viewer.indexOf('async function refreshSession() {'), viewer.indexOf('\nconst backupSizeLabel'));
const editSource = viewer.slice(viewer.indexOf("document.querySelector('#edit-mode').addEventListener"), viewer.indexOf("document.querySelector('#sidebar-close').addEventListener"));
function harness(fetcher) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, value: '', details: { open: false }, closest() { return this.details; }, replaceChildren() {}, add() {}, addEventListener(type, handler) { this[type] = handler; } });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { querySelector: get }, fetch: fetcher,
    Option: function (text, value) { this.text = text; this.value = value; },
    renderSidebar() { get('#editor-panel').hidden = !context.editorOpen || !context.sidebarOpen; },
    updateImportPosition() {}, loadBlockPalette: async () => {}, refreshSaveStatus: async () => {},
    refreshRecoverySnapshots: async () => { get('#backup-size').refreshed = true; },
    updateSlicePreview() {}, renderSelection() {}, loginPanel: get('#login-panel'), setupPanel: get('#setup-panel'),
    editorOpen: false, sidebarOpen: false, floorManifest: null, visibleHeight: 256,
  });
  vm.runInContext(sessionSource + editSource, context);
  return { get, context, open: () => get('#edit-mode').click() };
}
const reply = (data, ok = true) => ({ ok, json: async () => data });

test('empty map opens editor and restore even when optional project requests fail', async () => {
  const ui = harness(async url => url === '/api/auth/session' ? reply({ authenticated: true }) : reply({ error: 'No project available' }, false));
  await ui.open();
  assert.equal(ui.get('#editor-panel').hidden, false);
  assert.equal(ui.get('#setup-panel').hidden, false);
  assert.equal(ui.get('#login-panel').hidden, true);
  assert.equal(ui.get('#backup-restore').details.open, true);
  assert.equal(ui.get('#import-schematic').details.open, true);
  assert.equal(ui.get('#backup-size').refreshed, true);
});

test('editor is visible while setup requests are pending, and an empty floor list is supported', async () => {
  let resolveProject;
  const ui = harness(async url => {
    if (url === '/api/auth/session') return reply({ authenticated: true });
    if (url === '/api/editor/project') return new Promise(resolve => { resolveProject = resolve; });
    return reply({ revision: 0, floors: [], sections: [] });
  });
  const opening = ui.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.get('#editor-panel').hidden, false);
  assert.equal(ui.get('#setup-panel').hidden, false);
  assert.equal(ui.get('#backup-restore').details.open, true);
  resolveProject(reply({ assetsConfigured: false }));
  await opening;
  assert.equal(ui.context.projectRevision, 0);
});

test('opening edit from a closed sidebar exposes login without a map', async () => {
  const ui = harness(async () => reply({ authenticated: false }));
  await ui.open();
  assert.equal(ui.get('#editor-panel').hidden, false);
  assert.equal(ui.get('#login-panel').hidden, false);
  assert.equal(ui.get('#setup-panel').hidden, true);
});
