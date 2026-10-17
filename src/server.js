import express from 'express';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const fixturePath = path.resolve(process.env.STARTING_FIXTURE ?? path.join(root, 'schematics', 'Start 0F.litematic'));
const clientJar = process.env.MINECRAFT_CLIENT_JAR ?? (process.env.APPDATA ? path.join(process.env.APPDATA, 'PrismLauncher', 'libraries', 'com', 'mojang', 'minecraft', '26.3', 'minecraft-26.3-client.jar') : '/seed-assets/minecraft-client.jar');
const assetsDir = process.env.MINECRAFT_ASSETS ? path.resolve(process.env.MINECRAFT_ASSETS) : undefined;
await mkdir(dataDir, { recursive: true });

let workerState = { ready: false, error: null };
const worker = new Worker(new URL('./seed-worker.js', import.meta.url), { workerData: { dataDir, fixturePath, assetsDir, clientJar } });
worker.on('message', value => { workerState = value; });
worker.on('error', error => { workerState = { ready: false, error: error.message }; });
worker.on('exit', code => { if (code && !workerState.error) workerState = { ready: false, error: `Initialization worker exited (${code})` }; });

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(root, 'public'), { etag: true, maxAge: '1h' }));
app.get('/health', (_req, res) => res.status(workerState.ready ? 200 : 503).json({ status: workerState.ready ? 'ok' : 'starting', worker: workerState }));
app.get('/api/map/manifest', async (_req, res) => {
  try {
    const current = JSON.parse(await readFile(path.join(dataDir, 'releases', 'current.json'), 'utf8'));
    const manifest = await readFile(path.join(dataDir, 'releases', current.directory, 'manifest.json'), 'utf8');
    res.set('Cache-Control', 'no-cache').type('application/json').send(manifest);
  } catch {
    res.status(503).json({ error: 'The public map is not generated yet.', detail: workerState.warning ?? 'Set up the matching Minecraft 26.3 assets and restart generation.' });
  }
});
app.get('/api/map/image', async (_req, res) => {
  try {
    const current = JSON.parse(await readFile(path.join(dataDir, 'releases', 'current.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(dataDir, 'releases', current.directory, 'manifest.json'), 'utf8'));
    if (!/^revision-[0-9]+$/.test(current.directory) || path.basename(manifest.image) !== manifest.image) throw new Error('Invalid release manifest paths');
    const png = await readFile(path.join(dataDir, 'releases', current.directory, manifest.image));
    res.set('Cache-Control', 'public, max-age=300').type('png').send(png);
  } catch {
    res.status(503).type('text').send('The public map is not available until matching Minecraft assets are configured.');
  }
});
app.get('/api/status', (_req, res) => res.json({ initialized: workerState.ready, mapAvailable: Boolean(workerState.rendered), warning: workerState.warning ?? null }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, '0.0.0.0', () => process.stdout.write(`RR Map listening on ${port}\n`));
