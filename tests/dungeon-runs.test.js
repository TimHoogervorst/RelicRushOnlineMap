import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { openProject, projectRevision } from '../src/project-store.js';
import { recordObservation, runDetail, listRuns, deleteRun, activeRun, interruptRuns, saveEndpoint, readEndpoint, qualifies } from '../src/dungeon-runs.js';
import { createRunRecorder } from '../src/run-recorder.js';
import { createApp } from '../src/server.js';
import { createProjectBackup, restoreProjectBackup } from '../src/backup-service.js';
import { replayPosition, routeSegments, durationLabel, indexRecording, routeAnnotations } from '../public/run-playback.js';

const calibration = { world: 'world', local: { x: 0, y: 0, z: 0 }, actual: { x: 0, y: 0, z: 0 } };
const manifest = { floors: [{ id: 'f', sections: [{ id: 's', calibration, trackingOrientation: [1, 0, 0, 1] }], markers: [{ id: 'm', name: 'Relic', sectionId: 's', localX: 0, localZ: 0 }] }] };
const player = (uuid = 'a'.repeat(32), x = 0) => ({ uuid, name: uuid[0] === 'a' ? 'Alice' : 'Bob', status: 'mapped', world: 'world', sectionId: 's', floorId: 'f', x, y: 1, z: 0, local: { x, y: 1, z: 0 } });
const observe = (db, time, players, stale = false) => recordObservation(db, { updatedAt: time, observations: players, stale }, manifest, time);
function finish(db, time) { observe(db, time, []); return observe(db, time + 16000, []); }
function endpoint(db, x = 0) { return saveEndpoint(db, { sectionId: 's', local: { x, y: 1, z: 0 } }, manifest); }

test('co-op shares a win from either final point, snapshots endpoint and excludes departure grace from duration', () => {
  const db = openProject(':memory:');
  try {
    endpoint(db); const a = player(), b = player('b'.repeat(32), 20);
    const first = observe(db, 1000, [a]); observe(db, 3000, [a, b]);
    endpoint(db, 100);
    observe(db, 5000, [a, b]); const completed = finish(db, 7000);
    assert.equal(completed.status, 'win');
    const detail = runDetail(db, first.id);
    assert.equal(detail.durationMs, 4000); assert.equal(detail.participants[1].durationMs, 2000);
    assert.equal(detail.samples.length, 5); assert.equal(detail.encounters.length, 1);
    assert.equal(projectRevision(db), 0);
    assert.equal(listRuns(db, { name: 'BO' }).runs[0].id, first.id);
    observe(db, 25000, [a]); assert.equal(finish(db, 27000).status, 'loss');
  } finally { db.close(); }
});

test('only final positions qualify and endpoint boundaries include vertical and world checks', () => {
  const db = openProject(':memory:');
  try {
    const ep = endpoint(db), a = player();
    assert.equal(ep.diameter, 10);
    for (const change of [{ x: 5 }, { z: -5 }, { y: 6 }, { x: 3, y: 5 }]) assert.equal(qualifies({ ...a, ...change }, ep), true);
    for (const change of [{ x: 5.01 }, { y: 6.01 }, { x: 5, z: 5 }, { world: 'other' }]) assert.equal(qualifies({ ...a, ...change }, ep), false);
    observe(db, 1000, [a]); observe(db, 3000, [player(a.uuid, 30)]);
    assert.equal(finish(db, 5000).status, 'loss');
    saveEndpoint(db, null, manifest); observe(db, 23000, [a]); assert.equal(finish(db, 25000).status, 'loss');
    assert.throws(() => saveEndpoint(db, { sectionId: 'missing', local: a.local }, manifest), /calibrated/);
    assert.throws(() => saveEndpoint(db, { sectionId: 's', local: { ...a.local, y: Infinity } }, manifest), /finite/);
  } finally { db.close(); }
});

test('sphere diameter persists, validates edits, upgrades legacy settings and stays frozen per run', () => {
  const db = openProject(':memory:');
  try {
    const original = endpoint(db), a = { ...player(), y: 8 };
    const first = observe(db, 1000, [a]);
    const larger = saveEndpoint(db, { sectionId: 's', local: original.local, diameter: 20 }, manifest);
    assert.equal(readEndpoint(db).diameter, 20);
    assert.equal(qualifies(a, larger), true);
    assert.equal(runDetail(db, first.id).endpoint.diameter, 10);
    assert.equal(finish(db, 3000).status, 'loss');
    observe(db, 21000, [a]); assert.equal(finish(db, 23000).status, 'win');
    for (const diameter of [0, -1, 257, 1.1, Infinity, '20']) assert.throws(() => saveEndpoint(db, { sectionId: 's', local: original.local, diameter }, manifest), /diameter/);
    assert.equal(readEndpoint(db).diameter, 20, 'invalid edits preserve saved settings');
    const { shape, diameter, ...legacy } = original;
    db.prepare('UPDATE run_endpoint SET value=?').run(JSON.stringify(legacy));
    assert.equal(readEndpoint(db).shape, 'sphere'); assert.equal(readEndpoint(db).diameter, 10);
    assert.equal(qualifies({ ...player(), y: 5 }, legacy), false, 'legacy run snapshot retains its old box');
    assert.equal(qualifies({ ...player(), y: 5 }, readEndpoint(db)), true, 'new run uses the sphere');
  } finally { db.close(); }
});

test('re-entry cancels absence; finalized players and third arrivals cannot join an occupied run', () => {
  const db = openProject(':memory:');
  try {
    const a = player(), b = player('b'.repeat(32), 20), c = player('c'.repeat(32));
    observe(db, 1000, [a, b, c]); observe(db, 3000, [b]); observe(db, 16000, [a, b]);
    assert.equal(activeRun(db).participants.length, 2); assert.equal(activeRun(db).participants[0].finished, false);
    observe(db, 18000, [b]); observe(db, 34000, [b]);
    assert.equal(activeRun(db).participants[0].finished, true);
    observe(db, 36000, [a, b, c]);
    assert.equal(activeRun(db).participants[0].lastAt, 16000);
    assert.equal(activeRun(db).participants.length, 2);
  } finally { db.close(); }
});

test('outages reset absence and ambiguity interrupts after 60 seconds without fabricating deaths', () => {
  const db = openProject(':memory:');
  try {
    const a = player(); observe(db, 1000, [a]); observe(db, 3000, []); observe(db, 15000, [], true);
    observe(db, 19000, []); assert.equal(activeRun(db).participants[0].absentSince, 19000);
    observe(db, 33000, []); assert.ok(activeRun(db)); observe(db, 35000, []); assert.equal(activeRun(db), null);
    const run = observe(db, 37000, [a]); observe(db, 39000, [{ ...a, status: 'ambiguous' }]);
    observe(db, 98000, [{ ...a, status: 'ambiguous' }]); assert.ok(activeRun(db));
    observe(db, 99000, [{ ...a, status: 'ambiguous' }]); assert.equal(runDetail(db, run.id).status, 'interrupted');
  } finally { db.close(); }
});

test('first encounters are once per run, duplicate observations add no samples, and recovery marks a gap', () => {
  const db = openProject(':memory:');
  try {
    const a = player(), run = observe(db, 1000, [a]); observe(db, 1000, [a]);
    observe(db, 3000, [player(a.uuid, 20)]); observe(db, 5000, [a]); observe(db, 6000, [], true); observe(db, 7000, [a]);
    const detail = runDetail(db, run.id);
    assert.equal(detail.samples.length, 4); assert.equal(detail.encounters.length, 1); assert.equal(detail.samples.at(-1).gap, true);
    interruptRuns(db, 8000); assert.equal(runDetail(db, run.id).status, 'interrupted');
    const next = observe(db, 9000, [a]); assert.equal(runDetail(db, next.id).encounters.length, 1);
  } finally { db.close(); }
});

test('history pagination combines filters and cascading deletion keeps other runs', () => {
  const db = openProject(':memory:');
  try {
    for (let i = 0; i < 18; i++) { observe(db, i * 20000 + 1000, [player()]); finish(db, i * 20000 + 2000); }
    const first = listRuns(db, { name: 'ALI', from: 20000, to: 340000 });
    assert.equal(first.runs.length, 5);
    const next = listRuns(db, { name: 'ALI', from: 20000, to: 340000, ...first.next, limit: 10 });
    assert.equal(next.runs.length, 10); assert.equal(new Set([...first.runs, ...next.runs].map(r => r.id)).size, 15);
    deleteRun(db, first.runs[0].id); assert.equal(runDetail(db, first.runs[0].id), null);
    for (const table of ['run_samples', 'run_encounters', 'run_participants']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE run_id=?`).get(first.runs[0].id).n, 0);
    const active = observe(db, 400000, [player()]); assert.throws(() => deleteRun(db, active.id), /Active/);
    assert.throws(() => listRuns(db, { limit: 10000 }), /Invalid/);
  } finally { db.close(); }
});

test('replay joins sections and tracking gaps in floor coordinates, and labels floor departures', () => {
  const map = { floors: [
    { id: 'f', name: 'Lower floor', sections: [{ id: 's', name: 'Cave', placementX: 10, placementZ: 0 }, { id: 'next', name: 'Hall', placementX: 100, placementZ: 20 }] },
    { id: 'upper', name: 'Upper floor', sections: [{ id: 'u', name: 'Tower', placementX: 0, placementZ: 0 }] }
  ] };
  const sample = (time, x, sectionId, gap = false) => ({ uuid: 'a', time, local: { x, z: 0 }, sectionId, gap });
  const recording = { participants: [{ uuid: 'a' }], samples: [sample(1000, 0, 's'), sample(3000, 10, 's'), sample(15000, 0, 'next', true), sample(17000, 5, 'u')] };
  const samples = indexRecording(recording, map).get('a');
  assert.equal(replayPosition(samples, 2000).display.x, 15);
  assert.deepEqual(replayPosition(samples, 9000).display, { x: 60, z: 10 }, 'connect local origins using floor placements, including long gaps');
  assert.equal(replayPosition(samples, 500), null);
  assert.equal(replayPosition(samples, 16000).transition.floorName, 'Upper floor');
  assert.equal(replayPosition(samples, 16000).floorId, 'f');
  assert.equal(replayPosition(samples, 17000).floorId, 'upper');
  assert.deepEqual(routeSegments(samples, new Set(['s', 'next'])).map(s => s.length), [3]);
  const annotations = routeAnnotations(samples, 'loss');
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].sample.sectionId, 'next');
  assert.equal(annotations[0].destination.sectionName, 'Tower');
  assert.equal(annotations[1].kind, 'loss'); assert.equal(annotations[1].sample.time, 17000);
  assert.equal(routeAnnotations(samples, 'win').length, 1);
  assert.equal(routeAnnotations(samples, 'interrupted').length, 1);
  assert.equal(durationLabel(300000), '5:00');
});

test('replay never connects across a deleted section or a visit to another floor', () => {
  const samples = [
    { time: 0, sectionId: 'a', floorId: 'f', local: { x: 0, z: 0 } },
    { time: 2000, sectionId: 'b', floorId: 'upper', local: { x: 0, z: 0 } },
    { time: 4000, sectionId: 'a', floorId: 'f', local: { x: 10, z: 0 } },
    { time: 6000, sectionId: 'deleted', unavailable: true },
    { time: 8000, sectionId: 'a', floorId: 'f', local: { x: 20, z: 0 } }
  ];
  assert.deepEqual(routeSegments(samples, new Set(['a'])).map(s => s.length), [1, 1, 1]);
  assert.equal(replayPosition(samples, 7000), null);
  assert.equal(routeAnnotations(samples, 'loss').filter(a => a.kind === 'exit').length, 2);
});

test('recorder polls without browser requests and restart/restore recovery preserves prior recordings', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rr-recorder-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const database = path.join(dir, 'project.sqlite'); let time = 1000, calls = 0;
  const tracker = { async snapshot() { calls++; return { updatedAt: time, observations: [player()], stale: false }; } };
  const options = { database, tracker, manifest: async () => manifest, now: () => time, onError: (_, e) => { throw e; } };
  const recorder = createRunRecorder(options); await recorder.tick();
  let db = openProject(database), original = activeRun(db).id; db.close();
  await recorder.tick(); assert.equal(calls, 2);
  db = openProject(database); assert.equal(runDetail(db, original).samples.length, 1); db.close();
  time = 3000; const restarted = createRunRecorder(options); await restarted.tick();
  db = openProject(database); assert.equal(runDetail(db, original).status, 'interrupted'); assert.notEqual(activeRun(db).id, original); db.close();
  await recorder.stop(); await restarted.stop();
});

test('public history API, authenticated deletion, head lookup, and full backup restore', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rr-run-api-'));
  let db = openProject(path.join(dataDir, 'project.sqlite')); endpoint(db); const run = observe(db, 1000, [player()]); finish(db, 3000); db.close();
  const app = createApp({ dataDir, initializeWorker: false, password: 'secret', playerFetcher: async () => new Response('', { status: 404 }) });
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await app.locals.runRecorder.stop(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await fetch(`${origin}/api/runs`).then(r => r.json())).runs[0].id, run.id);
  assert.equal((await fetch(`${origin}/api/runs/${run.id}`).then(r => r.json())).samples.length, 1);
  assert.equal((await fetch(`${origin}/api/players/${player().uuid}/head`)).status, 200);
  assert.equal((await fetch(`${origin}/api/project/runs/${run.id}`, { method: 'DELETE' })).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) });
  const headers = { origin, cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal((await fetch(`${origin}/api/project/runs/${run.id}`, { method: 'DELETE', headers: { ...headers, origin: 'https://other.example' } })).status, 403);
  const backup = await createProjectBackup({ dataDir });
  assert.equal((await fetch(`${origin}/api/project/runs/${run.id}`, { method: 'DELETE', headers })).status, 204);
  assert.equal((await fetch(`${origin}/api/runs/${run.id}`)).status, 404);
  await restoreProjectBackup({ dataDir, bytes: backup, confirm: 'RESTORE PROJECT' });
  db = openProject(path.join(dataDir, 'project.sqlite'));
  try { assert.equal(runDetail(db, run.id).status, 'win'); assert.ok(readEndpoint(db)); }
  finally { db.close(); }
});
