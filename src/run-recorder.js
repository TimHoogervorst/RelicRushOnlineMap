import { openProject } from './project-store.js';
import { interruptRuns, recordObservation, activeRun } from './dungeon-runs.js';

export function createRunRecorder({ database, tracker, manifest, paused = () => false, now = Date.now, onError = console.error }) {
  let timer, pending, recovered = false, lastObservation = null, epoch = 0;
  async function tick() {
    if (pending || paused()) return;
    const version = epoch;
    pending = (async () => {
      let map, snapshot;
      try { map = await manifest(); snapshot = await tracker.snapshot(map, false, true); }
      catch { map = { floors: [] }; snapshot = { stale: true, updatedAt: null }; }
      if (paused() || version !== epoch) return;
      const db = openProject(database);
      try {
        if (!recovered) { interruptRuns(db, now()); recovered = true; }
        if (!snapshot.stale && snapshot.updatedAt === lastObservation && !activeRun(db)) return;
        const run = recordObservation(db, snapshot, map, now());
        tracker.setRecordingActive?.(run?.status === 'active');
        if (!snapshot.stale) lastObservation = snapshot.updatedAt;
      } finally { db.close(); }
    })();
    try { await pending; } catch (error) { onError('Run recording failed:', error); }
    finally { pending = null; }
  }
  return {
    tick,
    start() { if (!timer) { void tick(); timer = setInterval(() => void tick(), 1000); timer.unref(); } },
    async stop() { clearInterval(timer); timer = null; epoch++; await pending; tracker.setRecordingActive?.(false); },
    reset() { tracker.setRecordingActive?.(false); epoch++; recovered = false; lastObservation = null; }
  };
}
