import test from 'node:test';
import assert from 'node:assert/strict';
import { SaveQueue } from '../src/save-queue.js';

test('serializes saves and coalesces pending autosaves to the newest revision', async () => {
  const queue = new SaveQueue();
  const started = [];
  let finishFirst;
  const firstGate = new Promise(resolve => { finishFirst = resolve; });
  const first = queue.enqueue(1, async () => { started.push(1); await firstGate; return 1; }).catch(error => error);
  const second = queue.enqueue(2, async () => { started.push(2); return 2; }).catch(error => error);
  const third = queue.enqueue(3, async () => { started.push(3); return 3; });
  finishFirst();
  assert.match((await first).message, /superseded/);
  assert.match((await second).message, /coalesced/);
  assert.equal(await third, 3);
  assert.deepEqual(started, [1, 3]);
});

test('reports a failed save and continues with a later revision', async () => {
  const queue = new SaveQueue();
  await assert.rejects(queue.enqueue(1, async () => { throw new Error('render failed'); }), /render failed/);
  assert.equal(await queue.enqueue(2, async () => 'saved'), 'saved');
  assert.equal(queue.status.state, 'saved');
  assert.equal(queue.status.revision, 2);
});
