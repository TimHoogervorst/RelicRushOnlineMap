import express from 'express';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { decodeLitematic } from './litematic.js';
import { openProject, importSchematicSection } from './project-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = 'rr_editor_session';

function digest(value) { return createHash('sha256').update(value).digest(); }
function equalSecret(a, b) { return timingSafeEqual(digest(String(a)), digest(String(b))); }
function originAllowed(req) {
  if (req.get('sec-fetch-site') === 'cross-site') return false;
  const origin = req.get('origin');
  if (!origin) return req.get('sec-fetch-site') === 'same-origin' || req.get('sec-fetch-site') === 'none';
  try { return new URL(origin).host === req.get('host') && new URL(origin).protocol === `${req.protocol}:`; }
  catch { return false; }
}

export function createApp({ dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data')), password = process.env.EDITOR_PASSWORD ?? 'relic-local', loginLimit = 5, secureCookies = process.env.COOKIE_SECURE === 'true', sessionDurationMs = SESSION_MS, initializeWorker = true, assetExtractor } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  const sessions = new Map(), failures = new Map();
  const getSession = req => {
    const token = (req.get('cookie') ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const session = token && sessions.get(token);
    if (!session || session.expires <= Date.now()) { if (token) sessions.delete(token); return null; }
    return { token, session };
  };
  const requireEditor = (req, res, next) => getSession(req) ? next() : res.status(401).json({ error: 'Editor login required.' });
  const requireSameOrigin = (req, res, next) => originAllowed(req) ? next() : res.status(403).json({ error: 'Cross-origin request rejected.' });
  const extractAssets = assetExtractor ?? ((archivePath, outputDir) => new Promise((resolve, reject) => {
    const job = new Worker(new URL('./asset-worker.js', import.meta.url), { workerData: { archivePath, outputDir } });
    job.once('message', result => result.ok ? resolve(result.assets) : reject(new Error(result.error)));
    job.once('error', reject);
    job.once('exit', code => { if (code !== 0) reject(new Error(`Asset extraction worker exited (${code}).`)); });
  }));
  let workerState = { ready: false, error: null };
  let activeWorker;
  let assetSetupBusy = false;
  const startWorker = (forceRender = false) => {
    if (!initializeWorker) return;
    workerState = { ready: false, warning: null, rendered: Boolean(workerState.rendered) };
    activeWorker = new Worker(new URL('./seed-worker.js', import.meta.url), { workerData: { dataDir, fixturePath: path.resolve(process.env.STARTING_FIXTURE ?? path.join(root, 'schematics', 'Start 0F.litematic')), assetsDir: process.env.MINECRAFT_ASSETS ? path.resolve(process.env.MINECRAFT_ASSETS) : path.join(dataDir, 'assets', 'minecraft'), clientJar: process.env.MINECRAFT_CLIENT_JAR ?? (process.env.APPDATA ? path.join(process.env.APPDATA, 'PrismLauncher', 'libraries', 'com', 'mojang', 'minecraft', '26.3', 'minecraft-26.3-client.jar') : '/seed-assets/minecraft-client.jar'), forceRender } });
    activeWorker.on('message', value => { workerState = value; });
    activeWorker.on('error', error => { workerState = { ready: false, error: error.message }; });
    activeWorker.on('exit', code => { if (code && !workerState.error) workerState = { ready: false, error: `Initialization worker exited (${code})` }; });
  };

  app.use(express.static(path.join(root, 'public'), { etag: true, maxAge: '1h', dotfiles: 'deny' }));
  app.use(express.json({ limit: '32kb' }));
  app.post('/api/auth/login', requireSameOrigin, (req, res) => {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const recent = (failures.get(key) ?? []).filter(time => Date.now() - time < 15 * 60 * 1000);
    if (recent.length >= loginLimit) { failures.set(key, recent); return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' }); }
    if (typeof req.body?.password !== 'string' || !equalSecret(req.body.password, password)) {
      recent.push(Date.now()); failures.set(key, recent);
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    failures.delete(key);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { expires: Date.now() + sessionDurationMs });
    res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionDurationMs / 1000)}${secureCookies || req.secure ? '; Secure' : ''}`).json({ authenticated: true });
  });
  app.get('/api/auth/session', (req, res) => res.json({ authenticated: Boolean(getSession(req)) }));
  app.post('/api/auth/logout', requireEditor, requireSameOrigin, (req, res) => {
    const active = getSession(req); if (active) sessions.delete(active.token);
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies ? '; Secure' : ''}`).status(204).end();
  });

  const protectNamespace = (req, res, next) => requireEditor(req, res, () => {
    if (/^(POST|PUT|PATCH|DELETE)$/.test(req.method)) return requireSameOrigin(req, res, next);
    next();
  });
  const reserveAssetSetup = (_req, res, next) => {
    if (assetSetupBusy) return res.status(409).json({ error: 'Asset setup is already running. Try again when it finishes.' });
    assetSetupBusy = true;
    let released = false;
    const release = () => { if (!released) { released = true; assetSetupBusy = false; } };
    res.locals.releaseAssetSetup = release;
    res.once('finish', release);
    next();
  };
  for (const namespace of ['/api/editor', '/api/assets', '/api/project', '/api/backups', '/api/generation', '/api/setup']) app.use(namespace, protectNamespace);

  app.get('/health', (_req, res) => res.status(workerState.ready ? 200 : 503).json({ status: workerState.ready ? 'ok' : 'starting', worker: workerState }));
  app.get('/api/map/manifest', async (_req, res) => {
    try {
      const current = JSON.parse(await readFile(path.join(dataDir, 'releases', 'current.json'), 'utf8'));
      const manifest = await readFile(path.join(dataDir, 'releases', current.directory, 'manifest.json'), 'utf8');
      res.set('Cache-Control', 'no-cache').type('application/json').send(manifest);
    } catch { res.status(503).json({ error: 'The public map is not generated yet.', detail: workerState.warning ?? 'Set up matching Minecraft assets in Edit.' }); }
  });
  app.get('/api/map/image', async (_req, res) => {
    try {
      const current = JSON.parse(await readFile(path.join(dataDir, 'releases', 'current.json'), 'utf8'));
      const manifest = JSON.parse(await readFile(path.join(dataDir, 'releases', current.directory, 'manifest.json'), 'utf8'));
      if (!/^revision-[0-9]+$/.test(current.directory) || path.basename(manifest.image) !== manifest.image) throw new Error('Invalid release manifest paths');
      res.set('Cache-Control', 'public, max-age=300').type('png').send(await readFile(path.join(dataDir, 'releases', current.directory, manifest.image)));
    } catch { res.status(503).type('text').send('The public map is not available until matching Minecraft assets are configured.'); }
  });
  app.get('/api/status', (_req, res) => res.json({ initialized: workerState.ready, mapAvailable: Boolean(workerState.rendered), warning: workerState.warning ?? null }));
  app.get('/api/editor/project', requireEditor, async (_req, res) => {
    const source = path.join(dataDir, 'assets', 'minecraft', 'asset-source.json');
    try { res.json({ assetsConfigured: true, assets: JSON.parse(await readFile(source, 'utf8')) }); }
    catch { res.json({ assetsConfigured: false, assets: null }); }
  });
  app.get('/api/project/floors', requireEditor, async (_req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try { res.json({ floors: db.prepare('SELECT id,name,sort_order AS sortOrder FROM floors ORDER BY sort_order').all() }); }
    finally { db.close(); }
  });
  app.post('/api/project/import', requireEditor, requireSameOrigin, express.raw({ type: 'application/octet-stream', limit: '128mb' }), async (req, res) => {
    const temporary = path.join(dataDir, `schematic-upload-${randomBytes(12).toString('hex')}.litematic`);
    let db;
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a Litematic file first.' });
      await mkdir(dataDir, { recursive: true });
      await writeFile(temporary, req.body, { flag: 'wx', mode: 0o600 });
      const schematic = decodeLitematic(req.body);
      db = openProject(path.join(dataDir, 'project.sqlite'));
      const result = importSchematicSection(db, schematic, {
        floorId: req.get('x-floor-id') || null,
        floorName: req.get('x-floor-name') || 'Floor 0',
        sectionName: req.get('x-section-name') || path.basename(req.get('x-source-name') || 'Imported section', '.litematic')
      });
      res.status(201).json(result);
    } catch (error) { res.status(400).json({ error: error.message || 'Could not import this Litematic.' }); }
    finally { db?.close(); await rm(temporary, { force: true }).catch(() => {}); }
  });
  app.post('/api/assets/upload', requireEditor, requireSameOrigin, reserveAssetSetup, express.raw({ type: 'application/octet-stream', limit: '128mb' }), async (req, res) => {
    const temporary = path.join(dataDir, `asset-upload-${randomBytes(12).toString('hex')}.jar`);
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a Minecraft client JAR first.' });
      await writeFile(temporary, req.body, { flag: 'wx', mode: 0o600 });
      const metadata = await extractAssets(temporary, path.join(dataDir, 'assets', 'minecraft'));
      if (activeWorker && activeWorker.threadId !== -1) await new Promise(resolve => activeWorker.once('exit', resolve));
      startWorker(true);
      res.json({ configured: true, assets: metadata });
    } catch (error) { res.status(400).json({ error: error.message || 'Could not configure Minecraft assets.' }); }
    finally { await rm(temporary, { force: true }).catch(() => {}); res.locals.releaseAssetSetup?.(); }
  });
  app.all('/api/editor/*path', requireEditor, (_req, res) => res.status(404).json({ error: 'Editor operation is not available yet.' }));
  app.all('/api/assets/*path', requireEditor, (_req, res) => res.status(404).json({ error: 'Asset operation is not available yet.' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API operation is not available.' }));
  app.use((error, _req, res, _next) => {
    res.locals.releaseAssetSetup?.();
    res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? 'Upload exceeds the 128 MiB compressed limit.' : 'Invalid request.' });
  });

  if (initializeWorker) mkdir(dataDir, { recursive: true }).then(() => startWorker()).catch(error => { workerState = { ready: false, error: error.message }; });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, '0.0.0.0', () => process.stdout.write(`RR Map listening on ${port}\n`));
}
