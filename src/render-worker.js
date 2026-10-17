import { parentPort, workerData } from 'node:worker_threads';
import { createRendererAdapter } from './renderer-adapter.ts';

try {
  const renderer = createRendererAdapter();
  const manifest = await renderer.render(workerData);
  parentPort.postMessage({ ok: true, manifest });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message ?? 'Map rendering failed.' });
}
