import express from 'express';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { decodeLitematic } from './litematic.js';
import { openProject, importSchematicSection, projectRevision, snapshotProject, saveMarker, deleteMarker, readMarker, restoreMarker, readSectionBlocks, readSectionBlock, saveBlock, restoreBlock, moveSectionBlocks, restoreBlockMove } from './project-store.js';
import { createGenerationService, renderInWorker } from './generation.js';

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

export function createApp({ dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data')), password = process.env.EDITOR_PASSWORD ?? 'relic-local', loginLimit = 5, secureCookies = process.env.COOKIE_SECURE === 'true', sessionDurationMs = SESSION_MS, initializeWorker = true, assetExtractor, renderer } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  const sessions = new Map(), failures = new Map();
  const markerHistory = new Map();
  const blockHistory = new Map();
  const rememberMarker = (token, command) => {
    const history = markerHistory.get(token) ?? { undo: [], redo: [] };
    history.undo.push(command);
    if (history.undo.length > 50) history.undo.shift();
    history.redo = [];
    markerHistory.set(token, history);
  };
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
  const generation = createGenerationService({ dataDir, renderer: renderer ?? { render: renderInWorker }, assetsDir: process.env.MINECRAFT_ASSETS ? path.resolve(process.env.MINECRAFT_ASSETS) : path.join(dataDir, 'assets', 'minecraft') });
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
    const active = getSession(req); if (active) { sessions.delete(active.token); markerHistory.delete(active.token); blockHistory.delete(active.token); }
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
      return res.set('Cache-Control', 'no-cache').json(await generation.currentManifest(_req.query.floor));
    } catch { res.status(503).json({ error: 'The public map is not generated yet.', detail: workerState.warning ?? 'Set up matching Minecraft assets in Edit.' }); }
  });
  app.get('/api/map/image', async (_req, res) => {
    try {
      const revision = String(_req.query.revision ?? '');
      if (!/^[0-9]+$/.test(revision)) throw new Error('Invalid release revision');
      const directory = `revision-${revision}`;
      const manifest = JSON.parse(await readFile(path.join(dataDir, 'releases', directory, 'manifest.json'), 'utf8'));
      if (manifest.projectRevision !== Number(revision)) throw new Error('Invalid release revision');
      const floor = manifest.floors?.find(item => item.id === _req.query.floor);
      const imageName = floor?.image ?? manifest.image;
      if (path.basename(imageName) !== imageName) throw new Error('Invalid release manifest paths');
      res.set('Cache-Control', `public, max-age=31536000, immutable`).type('png').send(await readFile(path.join(dataDir, 'releases', directory, imageName)));
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
    try { res.json({ revision: projectRevision(db), floors: db.prepare('SELECT id,name,sort_order AS sortOrder FROM floors ORDER BY sort_order').all() }); }
    finally { db.close(); }
  });
  app.get('/api/project/height-range', requireEditor, async (req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      const floor = snapshotProject(db).floors.find(item => item.id === req.query.floor);
      if (!floor) return res.status(404).json({ error: 'Floor does not exist.' });
      let minY = 0, maxY = 0;
      for (const block of floor.blocks) { minY = Math.min(minY, block.y); maxY = Math.max(maxY, block.y); }
      res.json({ minY, maxY });
    } finally { db.close(); }
  });
  app.get('/api/project/sections/:id/blocks', requireEditor, async (req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      const section = db.prepare('SELECT id,name,bounds_json,placement_x AS placementX,placement_z AS placementZ FROM sections WHERE id=?').get(req.params.id);
      if (!section) return res.status(404).json({ error: 'Section does not exist.' });
      res.json({ revision: projectRevision(db), section: { ...section, bounds: JSON.parse(section.bounds_json) }, blocks: readSectionBlocks(db, section.id) });
    } finally { db.close(); }
  });
  app.get('/api/project/preview', requireEditor, async (req, res) => {
    const maxY = Number(req.query.maxY), floorId = String(req.query.floor ?? '');
    if (!Number.isSafeInteger(maxY) || Math.abs(maxY) > 1_000_000 || !floorId) return res.status(400).json({ error: 'Choose a floor and whole-block height.' });
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    const temporary = path.join(dataDir, `slice-preview-${randomBytes(12).toString('hex')}.png`);
    try {
      const floor = snapshotProject(db).floors.find(item => item.id === floorId);
      if (!floor) return res.status(404).json({ error: 'Floor does not exist.' });
      const assets = process.env.MINECRAFT_ASSETS ? path.resolve(process.env.MINECRAFT_ASSETS) : path.join(dataDir, 'assets', 'minecraft');
      await (renderer ?? { render: renderInWorker }).render({ schematic: { dimensions: floor.dimensions, blocks: floor.blocks.filter(block => block.y <= maxY) }, assets, output: temporary });
      res.type('png').set('Cache-Control', 'no-store').sendFile(temporary, error => { void rm(temporary, { force: true }); if (error && !res.headersSent) res.status(500).end(); });
    } catch (error) { await rm(temporary, { force: true }); res.status(500).json({ error: error.message }); }
    finally { db.close(); }
  });
  app.get('/api/project/block-palette', requireEditor, async (_req, res) => {
    try {
      const directory = path.join(dataDir, 'assets', 'minecraft', 'blockstates');
      const files = await readdir(directory);
      const blocks = [];
      for (const file of files.filter(name => name.endsWith('.json'))) {
        const id = `minecraft:${file.slice(0, -5)}`;
        let source;
        try { source = JSON.parse(await readFile(path.join(directory, file), 'utf8')); } catch { continue; }
        const values = new Map();
        for (const key of Object.keys(source.variants ?? {})) for (const pair of key.split(',').filter(Boolean)) {
          const [name, value] = pair.split('='); if (!values.has(name)) values.set(name, new Set());
          for (const allowed of value.split('|')) values.get(name).add(allowed);
        }
        const gather = condition => {
          if (!condition || typeof condition !== 'object') return;
          for (const [name, value] of Object.entries(condition)) {
            if (name === 'OR' || name === 'AND') { for (const part of value) gather(part); continue; }
            if (!values.has(name)) values.set(name, new Set());
            for (const allowed of Array.isArray(value) ? value : String(value).split('|')) values.get(name).add(allowed);
          }
        };
        for (const part of source.multipart ?? []) gather(part.when);
        blocks.push({ id, properties: Object.fromEntries([...values].map(([name, allowed]) => [name, [...allowed].sort()])) });
      }
      blocks.sort((a, b) => a.id.localeCompare(b.id));
      res.json({ blocks });
    } catch { res.status(503).json({ error: 'Configure matching Minecraft assets before editing blocks.' }); }
  });
  app.post('/api/project/blocks', requireEditor, requireSameOrigin, async (req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      if (!Number.isSafeInteger(req.body?.expectedRevision)) return res.status(400).json({ error: 'A project revision is required.' });
      const { sectionId, x, y, z, state = null } = req.body;
      if (state !== null) {
        if (!state || typeof state.id !== 'string' || !/^minecraft:[a-z0-9_./-]+$/.test(state.id)) return res.status(400).json({ error: 'Choose a block from the configured Minecraft palette.' });
        let blockstate;
        try { blockstate = JSON.parse(await readFile(path.join(dataDir, 'assets', 'minecraft', 'blockstates', `${state.id.slice('minecraft:'.length)}.json`), 'utf8')); }
        catch { return res.status(400).json({ error: 'Choose a block from the configured Minecraft palette.' }); }
        const allowed = new Map();
        for (const key of Object.keys(blockstate.variants ?? {})) for (const pair of key.split(',').filter(Boolean)) { const [name, value] = pair.split('='); if (!allowed.has(name)) allowed.set(name, new Set()); for (const item of value.split('|')) allowed.get(name).add(item); }
        const gather = condition => { if (!condition || typeof condition !== 'object') return; for (const [name, value] of Object.entries(condition)) { if (name === 'OR' || name === 'AND') { for (const part of value) gather(part); continue; } if (!allowed.has(name)) allowed.set(name, new Set()); for (const item of Array.isArray(value) ? value : String(value).split('|')) allowed.get(name).add(item); } };
        for (const part of blockstate.multipart ?? []) gather(part.when);
        for (const [name, value] of Object.entries(state.properties ?? {})) if (!allowed.get(name)?.has(value)) return res.status(400).json({ error: `Invalid ${name}=${value} state for ${state.id}.` });
        const variants = Object.keys(blockstate.variants ?? {});
        const matchesVariant = variants.some(key => key.split(',').filter(Boolean).every(pair => { const [name, value] = pair.split('='); return state.properties?.[name] === value || value.split('|').includes(state.properties?.[name]); }));
        if (variants.length && !matchesVariant) return res.status(400).json({ error: `The selected property combination is not a valid state for ${state.id}.` });
      }
      const before = readSectionBlock(db, sectionId, x, y, z);
      const result = saveBlock(db, { sectionId, x, y, z, state }, req.body.expectedRevision);
      const after = readSectionBlock(db, sectionId, x, y, z);
      const history = blockHistory.get(getSession(req).token) ?? { undo: [], redo: [] };
      history.undo.push({ sectionId, x, y, z, before, after }); if (history.undo.length > 100) history.undo.shift(); history.redo = [];
      blockHistory.set(getSession(req).token, history);
      try { const saved = await generation.save(snapshotProject(db)); return res.status(before ? 200 : 201).json({ ...result, saved: true, status: generation.queue.status }); }
      catch (error) { return res.status(202).json({ ...result, saved: false, warning: error.message, status: generation.queue.status }); }
    } catch (error) {
      const status = /another editor tab|does not exist|owning section/i.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
    } finally { db.close(); }
  });
  app.post('/api/project/block-moves', requireEditor, requireSameOrigin, async (req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      if (!Number.isSafeInteger(req.body?.expectedRevision)) return res.status(400).json({ error: 'A project revision is required.' });
      const command = moveSectionBlocks(db, req.body, req.body.expectedRevision);
      const token = getSession(req).token, history = blockHistory.get(token) ?? { undo: [], redo: [] };
      command.kind = 'selection-move'; history.undo.push(command); if (history.undo.length > 100) history.undo.shift(); history.redo = []; blockHistory.set(token, history);
      try { const saved = await generation.save(snapshotProject(db)); return res.status(200).json({ ...command, saved: true, status: generation.queue.status }); }
      catch (error) { return res.status(202).json({ ...command, saved: false, warning: error.message, status: generation.queue.status }); }
    } catch (error) {
      const status = /another editor tab|does not exist|owning section|collision|selected block/i.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
    } finally { db.close(); }
  });
  for (const direction of ['undo', 'redo']) app.post(`/api/project/blocks/${direction}`, requireEditor, requireSameOrigin, async (req, res) => {
    const token = getSession(req).token, history = blockHistory.get(token) ?? { undo: [], redo: [] };
    const source = history[direction], target = history[direction === 'undo' ? 'redo' : 'undo'];
    const command = source.at(-1);
    if (!command) return res.status(409).json({ error: `There is no block edit to ${direction}.` });
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      if (!Number.isSafeInteger(req.body?.expectedRevision)) return res.status(400).json({ error: 'A project revision is required.' });
      const result = command.kind === 'selection-move'
        ? restoreBlockMove(db, command, direction, req.body.expectedRevision)
        : restoreBlock(db, command, direction, req.body.expectedRevision);
      source.pop(); target.push(command); blockHistory.set(token, history);
      try { const saved = await generation.save(snapshotProject(db)); res.json({ ...result, saved: true, status: generation.queue.status }); }
      catch (error) { res.status(202).json({ ...result, saved: false, warning: error.message, status: generation.queue.status }); }
    } catch (error) {
      const status = /another editor tab|does not exist|collision|changed since this history/i.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
    } finally { db.close(); }
  });
  app.get('/api/generation/status', requireEditor, async (_req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      let currentRevision = 0;
      try { currentRevision = JSON.parse(await readFile(path.join(dataDir, 'releases', 'current.json'), 'utf8')).revision; } catch { /* no complete public release yet */ }
      const currentProjectRevision = projectRevision(db);
      const status = { ...generation.queue.status };
      if (status.revision === 0 && currentRevision >= currentProjectRevision) { status.state = 'saved'; status.revision = currentRevision; }
      else if (status.state === 'saved' && currentRevision < currentProjectRevision) status.state = 'unsaved';
      res.json({ ...status, projectRevision: currentProjectRevision, currentRevision });
    }
    finally { db.close(); }
  });
  app.post('/api/generation/save', requireEditor, requireSameOrigin, async (req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      const revision = projectRevision(db);
      if (!Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision !== revision) return res.status(409).json({ error: 'This project changed in another editor tab. Reload and retry your edit.', projectRevision: revision });
      const snapshot = snapshotProject(db);
      const result = await generation.save(snapshot);
      res.json({ ...result, status: generation.queue.status });
    } catch (error) {
      const status = /Stale revision|another editor tab/i.test(error.message) ? 409 : 503;
      res.status(status).json({ error: error.message, status: generation.queue.status });
    } finally { db.close(); }
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
      const revision = projectRevision(db);
      if (!Number.isSafeInteger(Number(req.get('x-project-revision'))) || Number(req.get('x-project-revision')) !== revision) return res.status(409).json({ error: 'This project changed in another editor tab. Reload and retry your edit.', projectRevision: revision });
      const result = importSchematicSection(db, schematic, {
        floorId: req.get('x-floor-id') || null,
        floorName: req.get('x-floor-name') || 'Floor 0',
        sectionName: req.get('x-section-name') || path.basename(req.get('x-source-name') || 'Imported section', '.litematic')
      });
      const savedRevision = projectRevision(db);
      try {
        const saved = await generation.save(snapshotProject(db));
        res.status(201).json({ ...result, saved, status: generation.queue.status });
      } catch (error) {
        res.status(202).json({ ...result, saved: false, projectRevision: savedRevision, status: generation.queue.status, warning: error.message });
      }
    } catch (error) { res.status(400).json({ error: error.message || 'Could not import this Litematic.' }); }
    finally { db?.close(); await rm(temporary, { force: true }).catch(() => {}); }
  });
  app.post('/api/project/markers', requireEditor, requireSameOrigin, async (req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      if (!Number.isSafeInteger(req.body?.expectedRevision)) return res.status(400).json({ error: 'A project revision is required.' });
      const marker = saveMarker(db, req.body.marker, req.body.expectedRevision);
      rememberMarker(getSession(req).token, { id: marker.id, before: null, after: readMarker(db, marker.id) });
      try {
        const saved = await generation.saveMetadata(snapshotProject(db));
        res.status(201).json({ marker, saved, status: generation.queue.status });
      } catch (error) { res.status(202).json({ marker, saved: false, revision: marker.revision, warning: error.message, status: generation.queue.status }); }
    } catch (error) {
      const status = /another editor tab|does not exist|owning section|floor/i.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
    } finally { db.close(); }
  });
  app.put('/api/project/markers/:id', requireEditor, requireSameOrigin, async (req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      if (!Number.isSafeInteger(req.body?.expectedRevision)) return res.status(400).json({ error: 'A project revision is required.' });
      const before = readMarker(db, req.params.id);
      const marker = saveMarker(db, req.body.marker, req.body.expectedRevision, req.params.id, { preserveDisplayedPosition: req.body.preserveDisplayedPosition === true });
      rememberMarker(getSession(req).token, { id: marker.id, before, after: readMarker(db, marker.id) });
      try {
        const saved = await generation.saveMetadata(snapshotProject(db));
        res.json({ marker, saved, status: generation.queue.status });
      } catch (error) { res.status(202).json({ marker, saved: false, revision: marker.revision, warning: error.message, status: generation.queue.status }); }
    } catch (error) {
      const status = /another editor tab|does not exist|owning section|floor/i.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
    } finally { db.close(); }
  });
  app.delete('/api/project/markers/:id', requireEditor, requireSameOrigin, async (req, res) => {
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      if (!Number.isSafeInteger(req.body?.expectedRevision)) return res.status(400).json({ error: 'A project revision is required.' });
      const before = readMarker(db, req.params.id);
      const result = deleteMarker(db, req.params.id, req.body.expectedRevision);
      rememberMarker(getSession(req).token, { id: req.params.id, before, after: null });
      try {
        const saved = await generation.saveMetadata(snapshotProject(db));
        res.json({ ...result, saved, status: generation.queue.status });
      } catch (error) { res.status(202).json({ ...result, saved: false, warning: error.message, status: generation.queue.status }); }
    } catch (error) {
      const status = /another editor tab|does not exist/i.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
    } finally { db.close(); }
  });
  for (const direction of ['undo', 'redo']) app.post(`/api/project/markers/${direction}`, requireEditor, requireSameOrigin, async (req, res) => {
    const active = getSession(req);
    const history = markerHistory.get(active.token) ?? { undo: [], redo: [] };
    const source = history[direction], target = history[direction === 'undo' ? 'redo' : 'undo'];
    const command = source.at(-1);
    if (!command) return res.status(409).json({ error: `There is no marker edit to ${direction}.` });
    const db = openProject(path.join(dataDir, 'project.sqlite'));
    try {
      if (!Number.isSafeInteger(req.body?.expectedRevision)) return res.status(400).json({ error: 'A project revision is required.' });
      const result = restoreMarker(db, command.id, direction === 'undo' ? command.before : command.after, req.body.expectedRevision);
      source.pop(); target.push(command); markerHistory.set(active.token, history);
      try {
        const saved = await generation.saveMetadata(snapshotProject(db));
        res.json({ ...result, saved, status: generation.queue.status });
      } catch (error) { res.status(202).json({ ...result, saved: false, warning: error.message, status: generation.queue.status }); }
    } catch (error) {
      const status = /another editor tab|section no longer/i.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
    } finally { db.close(); }
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
