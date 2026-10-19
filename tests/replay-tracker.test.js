import test from 'node:test';
import assert from 'node:assert/strict';
import { replayTrackerSample } from '../public/run-playback.js';

const sample = (uuid, time, x, extra = {}) => ({ uuid, time, world: 'world', x, y: 64, z: 10, sectionId: 's', floorId: 'f', local: { x: x - 100, y: 0, z: 1 }, ...extra });
const recording = { participants: [{ uuid: 'a', name: 'Alice' }, { uuid: 'b', name: 'Bob' }], samples: [sample('a', 1000, 100), sample('b', 1000, 200), sample('a', 2000, 110), sample('a', 10000, 120, { invisibility: { durationMs: 8000 } })] };

test('replay capture selects the followed player and exact recorded world position, not interpolation', () => {
  const before = structuredClone(recording);
  const captured = replayTrackerSample(recording, 'a', 1500);
  assert.equal(captured.time, 1000); assert.equal(captured.x, 100); assert.equal(captured.name, 'Alice');
  assert.equal(replayTrackerSample(recording, 'a', 2000).x, 110);
  assert.equal(replayTrackerSample(recording, 'b', 1000).x, 200);
  assert.deepEqual(recording, before);
});

test('replay capture rejects invisibility, absent players, out-of-range times and legacy missing coordinates', () => {
  for (const time of [0, 2001, 9000, 10001, NaN]) assert.equal(replayTrackerSample(recording, 'a', time), null);
  assert.equal(replayTrackerSample(recording, 'a', 10000).x, 120);
  assert.equal(replayTrackerSample(recording, '', 1000), null);
  assert.equal(replayTrackerSample(recording, 'missing', 1000), null);
  assert.equal(replayTrackerSample(null, 'a', 1000), null);
  assert.equal(replayTrackerSample({ ...recording, samples: [sample('a', 1000, undefined)] }, 'a', 1000), null);
});
