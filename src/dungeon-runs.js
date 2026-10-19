import { randomUUID } from 'node:crypto';
import { localToWorld } from './tracking-coordinates.js';

export function initializeRuns(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_startpoint (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_endpoint (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dungeon_runs (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON dungeon_runs(status) WHERE status='active';
    CREATE INDEX IF NOT EXISTS runs_history ON dungeon_runs(started_at DESC,id);
    CREATE TABLE IF NOT EXISTS run_participants (run_id TEXT REFERENCES dungeon_runs(id) ON DELETE CASCADE, uuid TEXT, name TEXT NOT NULL, PRIMARY KEY(run_id,uuid));
    CREATE INDEX IF NOT EXISTS run_player ON run_participants(uuid);
    CREATE TABLE IF NOT EXISTS run_samples (run_id TEXT REFERENCES dungeon_runs(id) ON DELETE CASCADE, uuid TEXT, time INTEGER, value TEXT NOT NULL, PRIMARY KEY(run_id,uuid,time));
    CREATE TABLE IF NOT EXISTS run_encounters (run_id TEXT REFERENCES dungeon_runs(id) ON DELETE CASCADE, marker_id TEXT, time INTEGER, value TEXT NOT NULL, PRIMARY KEY(run_id,marker_id));
    CREATE INDEX IF NOT EXISTS recent_run_encounters ON run_encounters(time);
  `);
}

export function readEndpoint(db) {
  const endpoint = JSON.parse(db.prepare('SELECT value FROM run_endpoint WHERE id=1').get()?.value ?? 'null');
  // Upgrade the configured endpoint for new runs without rewriting saved run snapshots.
  return endpoint ? { ...endpoint, shape: 'sphere', diameter: endpoint.diameter ?? 10 } : null;
}

export function readStartpoint(db) {
  return JSON.parse(db.prepare('SELECT value FROM run_startpoint WHERE id=1').get()?.value ?? 'null');
}
export function saveStartpoint(db, input, manifest) { return saveRunPoint(db, input, manifest, 'run_startpoint'); }
export function saveEndpoint(db, input, manifest) { return saveRunPoint(db, input, manifest, 'run_endpoint'); }

function saveRunPoint(db, input, manifest, table) {
  if (input === null) { db.prepare(`DELETE FROM ${table}`).run(); return null; }
  const section = manifest.floors.flatMap(f => f.sections).find(s => s.id === input?.sectionId);
  if (!section?.calibration || section.calibration.invalidReason) throw new Error('Choose a published, calibrated section.');
  if (!['x', 'y', 'z'].every(a => Number.isFinite(input?.local?.[a]) && Math.abs(input.local[a]) <= 30000000)) throw new Error('Endpoint coordinates must be finite block coordinates.');
  const diameter = input.diameter ?? 10;
  if (!Number.isFinite(diameter) || diameter < 0.5 || diameter > 256 || !Number.isInteger(diameter * 4)) throw new Error('Sphere diameter must be 0.5 to 256 blocks in quarter-block increments.');
  const endpoint = { sectionId: section.id, local: input.local, shape: 'sphere', diameter, world: section.calibration.world, position: localToWorld(input.local, section.calibration, section.trackingOrientation) };
  db.prepare(`INSERT INTO ${table} VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(JSON.stringify(endpoint));
  return endpoint;
}

export function qualifies(position, endpoint) {
  if (!endpoint || !position || position.world !== endpoint.world) return false;
  const dx = position.x - endpoint.position.x, dy = position.y - endpoint.position.y, dz = position.z - endpoint.position.z;
  if (endpoint.shape === 'sphere') return Math.hypot(dx, dy, dz) <= endpoint.diameter / 2;
  // Runs already in progress retain their original endpoint geometry.
  return Math.abs(dx) <= 5 && Math.abs(dz) <= 5 && Math.abs(dy) <= 2;
}

const readState = row => row ? JSON.parse(row.state) : null;
export function activeRun(db) { return readState(db.prepare("SELECT state FROM dungeon_runs WHERE status='active'").get()); }
function persist(db, run) {
  db.prepare('INSERT INTO dungeon_runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,state=excluded.state').run(run.id, run.startedAt, run.status, JSON.stringify(run));
}
export function interruptRuns(db, now = Date.now()) {
  const run = activeRun(db);
  if (run) { run.status = 'interrupted'; run.finalizedAt = now; persist(db, run); }
}

// Each call is a transaction over a fresh observation, or an uncertainty tick.
// State is durable so crashes cannot silently discard an in-progress recording.
export function recordObservation(db, snapshot, manifest, now = Date.now()) {
  return db.transaction(() => {
    let run = activeRun(db);
    const fresh = !snapshot.stale && snapshot.updatedAt !== null;
    const players = snapshot.observations ?? snapshot.diagnostics ?? snapshot.players ?? [];
    if (run && fresh) {
      const restarted = run.participants.some(p => !p.finished && p.absentSince !== null && players.some(player => player.uuid === p.uuid && player.status === 'mapped' &&
        (snapshot.updatedAt - p.absentSince >= 300000 || (player.sectionId === run.startpoint?.sectionId && qualifies(player, run.startpoint)))));
      const newArrival = run.participants.some(p => !p.finished && p.absentSince !== null) &&
        !players.some(player => player.status === 'mapped' && run.participants.some(p => !p.finished && p.uuid === player.uuid)) &&
        players.some(player => player.status === 'mapped' && !run.participants.some(p => p.uuid === player.uuid));
      if (restarted || newArrival) {
        run.status = 'interrupted'; run.finalizedAt = now; run.endReason = 'new-session'; persist(db, run); run = null;
      }
    }
    if (!run && fresh && players.some(p => p.status === 'mapped')) {
      run = { id: randomUUID(), startedAt: snapshot.updatedAt, endedAt: snapshot.updatedAt, status: 'active', endpoint: readEndpoint(db), startpoint: readStartpoint(db), participants: [], lastObservation: null };
      persist(db, run);
    }
    if (!run) return null;
    if (!fresh) {
      for (const p of run.participants.filter(p => !p.finished)) { p.uncertainSince ??= now; p.gap = true; }
    } else if (run.lastObservation !== snapshot.updatedAt) {
      const time = snapshot.updatedAt;
      run.lastObservation = time;
      for (const player of players.filter(p => p.status === 'mapped')) {
        if (run.participants.length >= 2 || run.participants.some(p => p.uuid === player.uuid)) continue;
        run.participants.push({ uuid: player.uuid, name: player.name, joinedAt: time, lastAt: time, last: null, absentSince: null, uncertainSince: null, finished: false, gap: true });
        db.prepare('INSERT INTO run_participants VALUES(?,?,?)').run(run.id, player.uuid, player.name);
      }
      for (const participant of run.participants.filter(p => !p.finished)) {
        const player = players.find(p => p.uuid === participant.uuid);
        if (player?.status === 'ambiguous') {
          participant.absentSince = null; participant.uncertainSince ??= time; participant.gap = true;
          continue;
        }
        participant.uncertainSince = null;
        if (player?.status === 'mapped') {
          const sample = { time, sectionId: player.sectionId, floorId: player.floorId, local: player.local, world: player.world, x: player.x, y: player.y, z: player.z, gap: participant.gap || time - participant.lastAt > 6000 };
          if (participant.absentSince !== null && participant.last) sample.invisibility = {
            from: participant.lastAt, to: time, durationMs: time - participant.lastAt,
            missingSince: participant.absentSince,
          };
          db.prepare('INSERT OR IGNORE INTO run_samples VALUES(?,?,?,?)').run(run.id, player.uuid, time, JSON.stringify(sample));
          participant.last = sample; participant.lastAt = time; participant.absentSince = null; participant.gap = false;
          run.endedAt = Math.max(run.endedAt, time);
          const floor = manifest.floors.find(f => f.id === player.floorId);
          for (const marker of floor?.markers ?? []) {
            if (marker.sectionId !== player.sectionId || Math.hypot(marker.localX - player.local.x, marker.localZ - player.local.z) > 4) continue;
            const event = { markerId: marker.id, sectionId: marker.sectionId, local: { x: marker.localX, z: marker.localZ }, name: marker.name, time, uuid: player.uuid };
            db.prepare('INSERT OR IGNORE INTO run_encounters VALUES(?,?,?,?)').run(run.id, marker.id, time, JSON.stringify(event));
          }
        } else if (player?.status === 'outside') {
          participant.finished = true; participant.finishReason = 'outside'; participant.gap = true;
        } else {
          participant.gap = true;
          participant.absentSince ??= time;
        }
      }
    }
    if (fresh) for (const participant of run.participants) {
      if (!participant.finished && participant.absentSince !== null && now - participant.absentSince >= 300000) {
        participant.finished = true; participant.finishReason = 'missing-timeout';
      }
    }
    if (run.participants.some(p => !p.finished && p.uncertainSince !== null && now - p.uncertainSince >= 60000)) run.status = 'interrupted';
    else if (run.participants.length && run.participants.every(p => p.finished)) run.status = run.participants.some(p => p.finishReason !== 'missing-timeout' && qualifies(p.last, run.endpoint)) ? 'win' : run.participants.some(p => p.finishReason === 'missing-timeout') ? 'interrupted' : 'loss';
    if (run.status !== 'active') run.finalizedAt = now;
    persist(db, run);
    return run;
  })();
}

export function summarizeRun(run) {
  return { id: run.id, startedAt: run.startedAt, endedAt: run.endedAt, status: run.status, durationMs: run.endedAt - run.startedAt,
    participants: run.participants.map(p => ({ uuid: p.uuid, name: p.name, joinedAt: p.joinedAt, lastAt: p.lastAt, finished: p.finished, missingSince: run.status === 'active' && !p.finished ? p.absentSince : null, durationMs: p.lastAt - p.joinedAt })) };
}

export function listRuns(db, { name = '', from, to, before, beforeId = '', limit = 5 } = {}) {
  if (typeof name !== 'string' || name.length > 64 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || [from, to, before].some(v => v !== undefined && (!Number.isSafeInteger(v) || v < 0)) || (from !== undefined && to !== undefined && from >= to)) throw new Error('Invalid history filters.');
  const rows = db.prepare(`SELECT r.state FROM dungeon_runs r WHERE r.status<>'active'
    AND r.started_at>=? AND r.started_at<?
    AND (r.started_at<? OR (r.started_at=? AND r.id<?))
    AND EXISTS(SELECT 1 FROM run_participants p WHERE p.run_id=r.id AND instr(lower(p.name),lower(?))>0)
    ORDER BY r.started_at DESC,r.id DESC LIMIT ?`).all(from ?? 0, to ?? Number.MAX_SAFE_INTEGER, before ?? Number.MAX_SAFE_INTEGER, before ?? Number.MAX_SAFE_INTEGER, beforeId, name, limit + 1);
  const hasMore = rows.length > limit, runs = rows.slice(0, limit).map(row => summarizeRun(readState(row)));
  const last = runs.at(-1);
  return { runs, next: hasMore ? { before: last.startedAt, beforeId: last.id } : null };
}

export function runDetail(db, id) {
  const run = readState(db.prepare('SELECT state FROM dungeon_runs WHERE id=?').get(id));
  if (!run) return null;
  return { ...summarizeRun(run), endpoint: run.endpoint, startpoint: run.startpoint ?? null,
    samples: db.prepare('SELECT uuid,value FROM run_samples WHERE run_id=? ORDER BY time').all(id).map(row => ({ uuid: row.uuid, ...JSON.parse(row.value) })),
    encounters: db.prepare('SELECT value FROM run_encounters WHERE run_id=? ORDER BY time').all(id).map(row => JSON.parse(row.value)) };
}

export function deleteRun(db, id) {
  const row = db.prepare('SELECT status FROM dungeon_runs WHERE id=?').get(id);
  if (!row) throw new Error('Recording not found.');
  if (row.status === 'active') throw new Error('Active recordings cannot be deleted.');
  db.prepare('DELETE FROM dungeon_runs WHERE id=?').run(id);
}
