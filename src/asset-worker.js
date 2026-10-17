import { parentPort, workerData } from 'node:worker_threads';
import { extractMatchingAssets } from './assets.js';

try {
  const assets = await extractMatchingAssets(workerData.archivePath, workerData.outputDir);
  parentPort.postMessage({ ok: true, assets });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message || 'Asset extraction failed.' });
}
