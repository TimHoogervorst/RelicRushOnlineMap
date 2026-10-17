import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

function resourcePath(id) {
  const split = id.indexOf(':');
  return split < 0 || id.slice(0, split) === 'minecraft' ? id.slice(split + 1) : path.join(id.slice(0, split), id.slice(split + 1));
}

function matchingModels(blockstate, properties) {
  const variants = blockstate.variants ?? {};
  const matched = Object.entries(variants).map(([key, model]) => {
    const required = Object.fromEntries(key.split(',').filter(Boolean).map(pair => pair.split('=')));
    return { model, required, score: Object.keys(required).length };
  }).filter(({ required }) => Object.entries(required).every(([key, value]) => properties[key] === value)).sort((a, b) => b.score - a.score);
  const output = [];
  if (matched.length) {
    const value = matched[0].model;
    output.push(...(Array.isArray(value) ? [value[0]] : [value]));
  }
  for (const part of blockstate.multipart ?? []) {
    const conditions = part.when ?? {};
    const applies = Object.entries(conditions).every(([key, value]) => {
      const actual = properties[key];
      return Array.isArray(value) ? value.includes(actual) : typeof value === 'string' && value.includes('|') ? value.split('|').includes(actual) : value === actual;
    });
    if (applies) output.push(...(Array.isArray(part.apply) ? part.apply : [part.apply]).filter(Boolean));
  }
  return output;
}

export async function renderOrthographic(schematic, { assets, output, pixelSize = 16, maxPixels = 20_000_000 } = {}) {
  if (!assets) throw new Error('Minecraft assets are not configured. Set MINECRAFT_ASSETS to the extracted assets/minecraft directory from the matching Minecraft 26.3 client JAR.');
  const { x: width, z: depth, y: height } = schematic.dimensions;
  const outWidth = width * pixelSize, outHeight = depth * pixelSize;
  if (outWidth * outHeight > maxPixels) throw new Error(`Map image ${outWidth}×${outHeight} exceeds the ${maxPixels.toLocaleString()} pixel safety limit.`);
  const raw = Buffer.alloc(outWidth * outHeight * 4, 0);
  const zBuffer = new Float32Array(outWidth * outHeight).fill(-Infinity);
  const modelCache = new Map(), textureCache = new Map(), stateModelCache = new Map();
  const diagnostics = new Set();
  const specialFallbacks = new Set();

  const readJson = async file => {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
  };
  const modelData = async (modelId, level = 0) => {
    if (modelCache.has(modelId)) return modelCache.get(modelId);
    if (level > 12) return null;
    const model = await readJson(path.join(assets, 'models', `${resourcePath(modelId)}.json`));
    if (!model) { modelCache.set(modelId, null); return null; }
    const parent = model.parent ? await modelData(model.parent, level + 1) : { textures: {}, elements: [] };
    const resolved = { textures: { ...(parent?.textures ?? {}), ...(model.textures ?? {}) }, elements: model.elements ?? parent?.elements ?? [] };
    modelCache.set(modelId, resolved);
    return resolved;
  };
  const textureData = async textureId => {
    const file = path.join(assets, 'textures', `${resourcePath(textureId)}.png`);
    if (!textureCache.has(file)) {
      try {
        const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        textureCache.set(file, { data, width: info.width, height: info.height });
      } catch { textureCache.set(file, null); }
    }
    return textureCache.get(file);
  };
  const blockModels = async block => {
    const blockstateId = block.id;
    const cacheKey = `${blockstateId}|${JSON.stringify(block.properties ?? {})}`;
    if (stateModelCache.has(cacheKey)) return stateModelCache.get(cacheKey);
    const state = await readJson(path.join(assets, 'blockstates', `${resourcePath(blockstateId)}.json`));
    const selected = state ? matchingModels(state, block.properties ?? {}) : [];
    const models = [];
    if (block.id === 'minecraft:water') {
      const pixels = await textureData('minecraft:block/water_still');
      if (pixels) {
        models.push({ element: { from: [0, 15, 0], to: [16, 15, 16] }, pixels, uv: [0, 0, 16, 16], rotateY: 0, uvRotation: 0, tint: [63, 118, 228] });
        specialFallbacks.add('minecraft:water uses a flat, non-animated still-water surface with default blue tint; biome tint and fluid flow are unavailable');
      }
    }
    for (const variant of selected) {
      if (!variant?.model) continue;
      const model = await modelData(variant.model);
      if (!model) continue;
      for (const element of model.elements) {
        const face = element.faces?.up;
        if (!face?.texture || !Array.isArray(element.from) || !Array.isArray(element.to)) continue;
        let texture = face.texture;
        const seen = new Set();
        while (typeof texture === 'string' && texture.startsWith('#') && !seen.has(texture)) { seen.add(texture); texture = model.textures[texture.slice(1)]; }
        if (typeof texture !== 'string') { diagnostics.add(block.id); continue; }
        const pixels = await textureData(texture);
        if (!pixels) continue;
        const uv = face.uv ?? [element.from[0], element.from[2], element.to[0], element.to[2]];
        models.push({ element, pixels, uv, rotateY: ((variant.y ?? 0) % 360 + 360) % 360, uvRotation: face.rotation ?? 0, tint: null });
      }
    }
    stateModelCache.set(cacheKey, models);
    if (!models.length) diagnostics.add(block.id);
    return models;
  };

  let lowY = Infinity, highY = -Infinity;
  const ordered = [...schematic.blocks].sort((a, b) => a.y - b.y);
  const prepared = [];
  for (const block of ordered) {
    const faces = await blockModels(block);
    if (!faces.length) {
      lowY = Math.min(lowY, block.y);
      highY = Math.max(highY, block.y + 1);
      specialFallbacks.add(`${block.id} uses a visible magenta cross fallback because no top-face model could be rendered`);
    }
    for (const { element } of faces) {
      lowY = Math.min(lowY, block.y + element.from[1] / 16);
      highY = Math.max(highY, block.y + element.to[1] / 16);
    }
    prepared.push({ block, faces });
  }
  for (const { block, faces } of prepared) {
    if (!faces.length) {
      const startX = Math.max(0, block.x * pixelSize), endX = Math.min(outWidth, (block.x + 1) * pixelSize);
      const startY = Math.max(0, (depth - block.z - 1) * pixelSize), endY = Math.min(outHeight, (depth - block.z) * pixelSize);
      for (let py = startY; py < endY; py++) for (let px = startX; px < endX; px++) {
        const at = py * outWidth + px;
        if (block.y + 1 < zBuffer[at]) continue;
        const lx = (px - startX) % pixelSize, ly = (py - startY) % pixelSize;
        const edge = lx === 0 || ly === 0 || lx === pixelSize - 1 || ly === pixelSize - 1;
        const cross = lx === ly || lx + ly === pixelSize - 1;
        const color = edge || cross ? [255, 0, 220] : [52, 36, 52];
        const dest = at * 4;
        raw[dest] = color[0]; raw[dest + 1] = color[1]; raw[dest + 2] = color[2]; raw[dest + 3] = 255;
        zBuffer[at] = block.y + 1;
      }
      continue;
    }
    for (const { element, pixels, uv, rotateY, uvRotation, tint } of faces) {
      const y = block.y + element.to[1] / 16;
      const baseMinX = element.from[0] / 16, baseMaxX = element.to[0] / 16;
      const baseMinZ = element.from[2] / 16, baseMaxZ = element.to[2] / 16;
      const rotatePoint = (x, z) => rotateY === 90 ? [1 - z, x] : rotateY === 180 ? [1 - x, 1 - z] : rotateY === 270 ? [z, 1 - x] : [x, z];
      const corners = [[baseMinX, baseMinZ], [baseMaxX, baseMinZ], [baseMinX, baseMaxZ], [baseMaxX, baseMaxZ]].map(([x, z]) => rotatePoint(x, z));
      const minX = Math.min(...corners.map(point => point[0])), maxX = Math.max(...corners.map(point => point[0]));
      const minZ = Math.min(...corners.map(point => point[1])), maxZ = Math.max(...corners.map(point => point[1]));
      const startX = Math.max(0, Math.floor((block.x + minX) * pixelSize));
      const endX = Math.min(outWidth, Math.ceil((block.x + maxX) * pixelSize));
      const startY = Math.max(0, Math.floor((depth - block.z - maxZ) * pixelSize));
      const endY = Math.min(outHeight, Math.ceil((depth - block.z - minZ) * pixelSize));
      const shade = Math.max(.65, 1 - (highY - y) * .018);
      for (let py = startY; py < endY; py++) for (let px = startX; px < endX; px++) {
        const worldX = px / pixelSize - block.x;
        const worldZ = depth - (py + .5) / pixelSize - block.z;
        const modelX = rotateY === 90 ? worldZ : rotateY === 180 ? 1 - worldX : rotateY === 270 ? 1 - worldZ : worldX;
        const modelZ = rotateY === 90 ? 1 - worldX : rotateY === 180 ? 1 - worldZ : rotateY === 270 ? worldX : worldZ;
        const tx = Math.max(0, Math.min(pixels.width - 1, Math.floor(uv[0] + (uv[2] - uv[0]) * (modelX - baseMinX) / Math.max(.001, baseMaxX - baseMinX))));
        let tz = Math.max(0, Math.min(pixels.height - 1, Math.floor(uv[1] + (uv[3] - uv[1]) * (modelZ - baseMinZ) / Math.max(.001, baseMaxZ - baseMinZ))));
        if (uvRotation === 90) tz = pixels.height - 1 - tz;
        const sample = (tz * pixels.width + tx) * 4, at = py * outWidth + px;
        const alpha = tint ? Math.min(pixels.data[sample + 3], 170) : pixels.data[sample + 3];
        if (!alpha || y < zBuffer[at]) continue;
        const dest = at * 4;
        const mix = alpha / 255;
        raw[dest] = Math.round(pixels.data[sample] * (tint?.[0] ?? 255) / 255 * shade * mix + raw[dest] * (1 - mix));
        raw[dest + 1] = Math.round(pixels.data[sample + 1] * (tint?.[1] ?? 255) / 255 * shade * mix + raw[dest + 1] * (1 - mix));
        raw[dest + 2] = Math.round(pixels.data[sample + 2] * (tint?.[2] ?? 255) / 255 * shade * mix + raw[dest + 2] * (1 - mix));
        raw[dest + 3] = Math.max(raw[dest + 3], alpha);
        if (alpha > 248) zBuffer[at] = y;
      }
    }
  }
  await sharp(raw, { raw: { width: outWidth, height: outHeight, channels: 4 } }).png().toFile(output);
  const highestBlockY = Number.isFinite(highY) ? Math.floor(highY) : 0;
  const lowestBlockY = Number.isFinite(lowY) ? Math.floor(lowY) : 0;
  return {
    image: path.basename(output), width: outWidth, height: outHeight,
    bounds: { x: 0, y: 0, z: 0, width, height, depth }, projection: 'orthographic-xz',
    highestBlockY, lowestBlockY,
    materials: [...new Set(schematic.blocks.map(block => block.id))].sort(),
    unsupportedBlocks: [...diagnostics].sort(),
    specialBlockFallbacks: [...specialFallbacks].sort(),
    renderer: { name: 'relic-ortho-model-rasterizer', version: 1, textureSource: 'Minecraft 26.3 client assets (world_version 5023)', pixelSize, heightShadePerBlock: 0.018 }
  };
}

