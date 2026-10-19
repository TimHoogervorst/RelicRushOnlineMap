import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

function resource(id) {
  if (typeof id !== 'string') return null;
  const name = id.replace(/^minecraft:/, '');
  return /^[a-z0-9_./-]+$/.test(name) && !name.split('/').some(p => p === '.' || p === '..') ? name : null;
}

export async function listItemIcons(roots) {
  const scan = async (directory, extension, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return (await Promise.all(entries.map(entry => entry.isDirectory()
      ? scan(path.join(directory, entry.name), extension, `${prefix}${entry.name}/`)
      : entry.isFile() && entry.name.endsWith(extension) ? [`minecraft:${prefix}${entry.name.slice(0, -extension.length)}`] : []))).flat();
  };
  const ids = new Set((await Promise.all(roots.flatMap(root => [scan(path.join(root, 'items'), '.json'), scan(path.join(root, 'models/item'), '.json'), scan(path.join(root, 'textures/item'), '.png')]))).flat());
  return [...ids].sort().map(id => ({ id, name: id.slice(10).replaceAll('_', ' ') }));
}

// Use the default inventory state for items whose appearance depends on game state.
function inventoryModel(node, depth = 0) {
  if (!node || depth > 16) return null;
  if (node.type === 'minecraft:model') return node.model;
  if (node.type === 'minecraft:special') return node.base;
  return inventoryModel(node.fallback ?? node.on_false ?? node.models?.[0] ?? node.entries?.[0]?.model ?? node.cases?.[0]?.model, depth + 1);
}

export async function renderItemIcon(roots, id) {
  const name = resource(id);
  if (!name) return null;
  const read = async (folder, id, extension) => {
    const relative = resource(id);
    if (!relative) return null;
    for (const root of roots) {
      try { return await readFile(path.join(root, folder, `${relative}${extension}`)); } catch { /* next pack */ }
    }
    return null;
  };
  const json = async (folder, id) => { try { return JSON.parse(await read(folder, id, '.json')); } catch { return null; } };
  const loadModel = async (id, seen = new Set()) => {
    if (seen.size > 16 || seen.has(id)) return {};
    seen.add(id);
    const own = await json('models', id);
    if (!own) return {};
    const parent = own.parent ? await loadModel(own.parent, seen) : {};
    return { ...parent, ...own, textures: { ...parent.textures, ...own.textures }, display: { ...parent.display, ...own.display } };
  };
  const definition = await json('items', name);
  const model = await loadModel(inventoryModel(definition?.model) ?? `item/${name}`);
  const resolveTexture = reference => {
    const seen = new Set();
    while (reference?.startsWith('#')) {
      if (seen.has(reference)) return null;
      seen.add(reference); reference = model.textures?.[reference.slice(1)];
    }
    return resource(reference);
  };
  const textures = new Map();
  const texture = async reference => {
    const resolved = resolveTexture(reference);
    if (!resolved) return null;
    if (!textures.has(resolved)) textures.set(resolved, (async () => {
      const bytes = await read('textures', resolved, '.png');
      if (!bytes) return null;
      try { return await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); } catch { return null; }
    })());
    return textures.get(resolved);
  };
  if (!model.elements?.length) {
    const layers = [];
    for (let i = 0; i < 5; i++) {
      const ref = resolveTexture(model.textures?.[`layer${i}`]);
      const bytes = ref && await read('textures', ref, '.png');
      if (bytes) layers.push({ input: await sharp(bytes).resize(64, 64, { kernel: 'nearest' }).png().toBuffer() });
    }
    if (layers.length) return sharp({ create: { width: 64, height: 64, channels: 4, background: '#00000000' } }).composite(layers).png().toBuffer();
    // Keep the previous texture fallback for special entity-rendered items.
    for (const key of ['all', 'top', 'side', 'particle']) {
      const ref = resolveTexture(model.textures?.[key]);
      const bytes = ref && await read('textures', ref, '.png');
      if (bytes) return bytes;
    }
    return await read('textures', `item/${name}`, '.png');
  }

  const size = 64, pixels = Buffer.alloc(size * size * 4), depth = new Float32Array(size * size).fill(-Infinity);
  const gui = model.display?.gui ?? {}, scale = gui.scale ?? [1, 1, 1], translation = gui.translation ?? [0, 0, 0];
  const rotate = (v, axis, angle) => {
    const a = (axis + 1) % 3, b = (axis + 2) % 3, cos = Math.cos(angle * Math.PI / 180), sin = Math.sin(angle * Math.PI / 180);
    const result = [...v]; result[a] = v[a] * cos - v[b] * sin; result[b] = v[a] * sin + v[b] * cos; return result;
  };
  const project = (point, element) => {
    let v = [...point];
    if (element.rotation) {
      const { origin = [8, 8, 8], axis, angle = 0, rescale } = element.rotation, index = ['x', 'y', 'z'].indexOf(axis);
      if (index >= 0) {
        v = rotate(v.map((n, i) => n - origin[i]), index, angle);
        if (rescale) v = v.map((n, i) => i === index ? n : n / Math.cos(angle * Math.PI / 180));
        v = v.map((n, i) => n + origin[i]);
      }
    }
    v = v.map((n, i) => (n - 8) * scale[i]);
    for (const axis of [2, 1, 0]) v = rotate(v, axis, gui.rotation?.[axis] ?? 0);
    return [(v[0] + translation[0]) * 4 + 32, 32 - (v[1] + translation[1]) * 4, v[2] + translation[2]];
  };
  const triangle = (vertices, uv, tex, light, tint) => {
    const [a, b, c] = vertices;
    const area = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(area) < 0.0001) return;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const u = ((b[1] - c[1]) * (x + .5 - c[0]) + (c[0] - b[0]) * (y + .5 - c[1])) / area;
      const v = ((c[1] - a[1]) * (x + .5 - c[0]) + (a[0] - c[0]) * (y + .5 - c[1])) / area, w = 1 - u - v;
      if (Math.min(u, v, w) < -0.00001) continue;
      const z = u * a[2] + v * b[2] + w * c[2], offset = y * size + x;
      if (z < depth[offset]) continue;
      const tx = Math.max(0, Math.min(tex.info.width - 1, Math.floor((u * uv[0][0] + v * uv[1][0] + w * uv[2][0]) / 16 * tex.info.width)));
      // Animated textures use their first square frame in the inventory preview.
      const frameHeight = Math.min(tex.info.height, tex.info.width);
      const ty = Math.max(0, Math.min(frameHeight - 1, Math.floor((u * uv[0][1] + v * uv[1][1] + w * uv[2][1]) / 16 * frameHeight)));
      const source = (ty * tex.info.width + tx) * 4;
      if (!tex.data[source + 3]) continue;
      for (let channel = 0; channel < 3; channel++) pixels[offset * 4 + channel] = Math.round(tex.data[source + channel] * light * tint[channel]);
      pixels[offset * 4 + 3] = tex.data[source + 3]; depth[offset] = z;
    }
  };
  for (const element of model.elements.slice(0, 256)) {
    const [x, y, z] = element.from, [X, Y, Z] = element.to;
    const faces = {
      up: [[[x,Y,z],[x,Y,Z],[X,Y,Z],[X,Y,z]], [x,z,X,Z], 1],
      down: [[[x,y,Z],[x,y,z],[X,y,z],[X,y,Z]], [x,16-Z,X,16-z], .65],
      north: [[[X,Y,z],[X,y,z],[x,y,z],[x,Y,z]], [16-X,16-Y,16-x,16-y], .85],
      south: [[[x,Y,Z],[x,y,Z],[X,y,Z],[X,Y,Z]], [x,16-Y,X,16-y], .85],
      west: [[[x,Y,z],[x,y,z],[x,y,Z],[x,Y,Z]], [z,16-Y,Z,16-y], .7],
      east: [[[X,Y,Z],[X,y,Z],[X,y,z],[X,Y,z]], [16-Z,16-Y,16-z,16-y], .7],
    };
    for (const [direction, face] of Object.entries(element.faces ?? {})) {
      if (!faces[direction]) continue;
      const tex = await texture(face.texture); if (!tex) continue;
      const [points, defaultUV, light] = faces[direction], [u, v, U, V] = face.uv ?? defaultUV;
      const coordinates = [[u,v],[u,V],[U,V],[U,v]], turn = ((face.rotation ?? 0) / 90) % 4;
      const uv = coordinates.map((_, i) => coordinates[(i + turn) % 4]);
      const vertices = points.map(p => project(p, element));
      const tint = face.tintindex === undefined ? [1,1,1] : [0.49,0.70,0.34];
      for (const indices of [[0,1,2],[0,2,3]]) triangle(indices.map(i => vertices[i]), indices.map(i => uv[i]), tex, model.gui_light === 'front' ? 1 : light, tint);
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}
