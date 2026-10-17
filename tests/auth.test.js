import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-auth-'));
  const app = createApp({ dataDir, password: 'secret', initializeWorker: false, renderer: { async render({ output }) { await writeFile(output, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1])); return { width: 1, height: 1, bounds: { width: 1, depth: 1 } }; } }, ...options });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  return { origin, dataDir };
}

function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(value);
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); filename.copy(central, 46);
    centrals.push(central); offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

test('login issues an expiring HttpOnly SameSite cookie and protects editor resources', async t => {
  const { origin } = await fixture(t);
  const denied = await fetch(`${origin}/api/editor/project`);
  assert.equal(denied.status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /rr_editor_session=[A-Za-z0-9_-]{43}/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Max-Age=/i);
  const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie: cookie.split(';')[0] } });
  assert.deepEqual(await session.json(), { authenticated: true });
  const logout = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { cookie: cookie.split(';')[0], origin } });
  assert.equal(logout.status, 204);
  assert.equal((await fetch(`${origin}/api/editor/project`, { headers: { cookie: cookie.split(';')[0] } })).status, 401);
});

test('session expiration and Secure cookie configuration are enforced', async t => {
  const { origin } = await fixture(t, { sessionDurationMs: 1000, secureCookies: true });
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  assert.match(login.headers.get('set-cookie'), /Secure/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await new Promise(resolve => setTimeout(resolve, 1020));
  assert.deepEqual(await fetch(`${origin}/api/auth/session`, { headers: { cookie } }).then(response => response.json()), { authenticated: false });
});

test('login throttles repeated failures and does not accept cross-origin mutations', async t => {
  const { origin } = await fixture(t, { loginLimit: 2 });
  for (let i = 0; i < 2; i++) await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'wrong' }) });
  const limited = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  assert.equal(limited.status, 429);
  const rejected = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' }, body: JSON.stringify({ password: 'secret' }) });
  assert.equal(rejected.status, 403);
});

test('asset upload requires authentication and origin validation', async t => {
  const { origin } = await fixture(t);
  assert.equal((await fetch(`${origin}/api/assets/upload`, { method: 'POST', body: 'not a jar' })).status, 401);
  for (const url of ['/api/project/state', '/api/backups/latest', '/api/generation/start', '/api/setup/status']) {
    assert.equal((await fetch(`${origin}${url}`)).status, 401, `${url} must stay private`);
  }
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = await fetch(`${origin}/api/editor/save`, { method: 'POST', headers: { cookie, origin: 'https://attacker.invalid' } });
  assert.equal(csrf.status, 403);
  const hiddenData = await fetch(`${origin}/api/backups/latest`, { headers: { cookie: `${cookie.slice(0, cookie.indexOf('='))}=invalid` } });
  assert.equal(hiddenData.status, 401);
});

test('authenticated owner imports a Litematic once and source upload is removed', async t => {
  const { origin, dataDir } = await fixture(t);
  assert.equal((await fetch(`${origin}/api/project/import`, { method: 'POST', body: 'bad' })).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const bytes = await readFile(new URL('../schematics/Start 0F.litematic', import.meta.url));
  const response = await fetch(`${origin}/api/project/import`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/octet-stream', 'x-project-revision': '0', 'x-source-name': 'Start 0F.litematic', 'x-section-name': 'Cave', 'x-floor-name': 'Floor 3' }, body: bytes });
  const payload = await response.json();
  assert.equal(response.status, 201, payload.error);
  const imported = payload;
  assert.equal(imported.blockCount, 3484);
  assert.equal(imported.createdFloor, true);
  assert.equal(imported.saved.revision, 1);
  const stale = await fetch(`${origin}/api/project/import`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/octet-stream', 'x-project-revision': '0' }, body: bytes });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /another editor tab/i);
  const status = await fetch(`${origin}/api/generation/status`, { headers: { cookie } }).then(result => result.json());
  assert.equal(status.projectRevision, 1);
  assert.equal(status.currentRevision, 1);
  const staleSave = await fetch(`${origin}/api/generation/save`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0 }) });
  assert.equal(staleSave.status, 409);
  const manifestResponse = await fetch(`${origin}/api/map/manifest`, { cache: 'no-store' });
  assert.match(manifestResponse.headers.get('cache-control'), /no-cache/);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.projectRevision, 1);
  const image = await fetch(`${origin}/api/map/image?revision=1&floor=${encodeURIComponent(imported.floorId)}`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('cache-control'), /immutable/);
  assert.equal((await image.arrayBuffer()).byteLength, 24);
  const floors = await fetch(`${origin}/api/project/floors`, { headers: { cookie } }).then(result => result.json());
  assert.equal(floors.floors[0].name, 'Floor 3');
  assert.equal((await readdir(dataDir)).some(name => name.startsWith('schematic-upload-')), false);
});

test('owner can upload version-checked assets and failed setup preserves configured metadata', async t => {
  const { origin } = await fixture(t);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const valid = zip([
    ['version.json', JSON.stringify({ id: '26.3', world_version: 5023 })],
    ['assets/minecraft/blockstates/stone.json', '{}'],
    ['assets/minecraft/models/block/stone.json', '{}'],
    ['assets/minecraft/textures/block/stone.png', 'png']
  ]);
  const upload = await fetch(`${origin}/api/assets/upload`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/octet-stream' }, body: valid });
  assert.equal(upload.status, 200);
  assert.equal((await upload.json()).assets.minecraftVersion, '26.3');
  let invalid;
  for (let attempt = 0; attempt < 10; attempt++) {
    invalid = await fetch(`${origin}/api/assets/upload`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/octet-stream' }, body: zip([['version.json', JSON.stringify({ id: 'wrong', world_version: 0 })]]) });
    if (invalid.status !== 409) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(invalid.status, 400);
  const project = await fetch(`${origin}/api/editor/project`, { headers: { cookie } }).then(response => response.json());
  assert.equal(project.assets.minecraftVersion, '26.3');
});

test('concurrent asset setup returns busy instead of overlapping extraction', async t => {
  let signalStarted, finishExtraction;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const extraction = new Promise(resolve => { finishExtraction = resolve; });
  const { origin } = await fixture(t, { assetExtractor: async () => { signalStarted(); await extraction; return { minecraftVersion: '26.3' }; } });
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'secret' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin, 'content-type': 'application/octet-stream' };
  const firstUpload = fetch(`${origin}/api/assets/upload`, { method: 'POST', headers, body: 'first archive' });
  await started;
  const busy = await fetch(`${origin}/api/assets/upload`, { method: 'POST', headers, body: 'second archive' });
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /already running/);
  finishExtraction();
  assert.equal((await firstUpload).status, 200);
});
