import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { isStructuralBlock, shadeTerrain } from './terrain-shading.js';

const MAX_RENDER_PIXELS = 16_000_000;

function resourcePath(id) {
  const split = id.indexOf(':');
  return split < 0 || id.slice(0, split) === 'minecraft' ? id.slice(split + 1) : path.join(id.slice(0, split), id.slice(split + 1));
}

function defaultBiomeTint(blockId) {
  if (blockId.includes('water')) return [63, 118, 228];
  if (/leaves|azalea|moss/.test(blockId)) return [119, 171, 62];
  return [127, 178, 56];
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

export async function renderOrthographic(schematic, { assets, output, pixelSize = 16, heightShadePerBlock = 0.018, heightShadeMinY = null, heightShadeMaxY = null, heightShadeMultiplier = 1, surfaceShadeMultiplier = 0, maxPixels = MAX_RENDER_PIXELS, assetOverrides = [] } = {}) {
  if (!assets) throw new Error('Minecraft assets are not configured. Set MINECRAFT_ASSETS to the extracted assets/minecraft directory from the matching Minecraft 26.3 client JAR.');
  if (!Number.isInteger(pixelSize) || pixelSize < 4 || pixelSize > 32) throw new Error('Pixel scale must be an integer from 4 to 32 pixels per block.');
  if (typeof heightShadePerBlock !== 'number' || !Number.isFinite(heightShadePerBlock) || heightShadePerBlock < 0 || heightShadePerBlock > 0.05) throw new Error('Height shading must be between 0 and 0.05 per block.');
  if (heightShadeMinY !== null && (!Number.isSafeInteger(heightShadeMinY) || Math.abs(heightShadeMinY) > 1_000_000)) throw new Error('Minimum shading Y must be a whole block coordinate.');
  if (heightShadeMaxY !== null && (!Number.isSafeInteger(heightShadeMaxY) || Math.abs(heightShadeMaxY) > 1_000_000)) throw new Error('Maximum shading Y must be a whole block coordinate.');
  if (heightShadeMinY !== null && heightShadeMaxY !== null && heightShadeMinY >= heightShadeMaxY) throw new Error('Maximum shading Y must be higher than minimum shading Y.');
  if (typeof heightShadeMultiplier !== 'number' || !Number.isFinite(heightShadeMultiplier) || heightShadeMultiplier < 0 || heightShadeMultiplier > 10) throw new Error('Height shading multiplier must be from 0 to 10.');
  if (typeof surfaceShadeMultiplier !== 'number' || !Number.isFinite(surfaceShadeMultiplier) || surfaceShadeMultiplier < 0 || surfaceShadeMultiplier > 10) throw new Error('Surface shading multiplier must be from 0 to 10.');
  const { x: width, z: depth, y: height } = schematic.dimensions;
  const outWidth = width * pixelSize, outHeight = depth * pixelSize;
  const pixelLimit = Math.min(maxPixels, MAX_RENDER_PIXELS);
  if (outWidth * outHeight > pixelLimit) throw new Error(`Map image ${outWidth}×${outHeight} exceeds the ${pixelLimit.toLocaleString('en-US')} pixel safety limit (about ${Math.ceil(pixelLimit * 20 / 1024 ** 2)} MiB for raster buffers, plus geometry and textures).`);
  const raw = Buffer.alloc(outWidth * outHeight * 4, 0);
  const zBuffer = new Float32Array(outWidth * outHeight).fill(-Infinity);
  const surfaceBuffer = new Float32Array(outWidth * outHeight).fill(-Infinity);
  const terrainBuffer = new Float32Array(outWidth * outHeight).fill(-Infinity);
  const terrainOwners = new Uint32Array(outWidth * outHeight);
  const sectionIds = new Map();
  const modelCache = new Map(), textureCache = new Map(), stateModelCache = new Map();
  const diagnostics = new Set();
  const specialFallbacks = new Set();

  const readJson = async file => {
    for (const root of [...assetOverrides, assets]) { try { return JSON.parse(await readFile(path.join(root, path.relative(assets, file)), 'utf8')); } catch {} }
    return null;
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
    const relative = path.join('textures', `${resourcePath(textureId)}.png`);
    let file = path.join(assets, relative);
    for (const root of assetOverrides) { const candidate = path.join(root, relative); try { await access(candidate); file = candidate; break; } catch {} }
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
    let proxy = null;
    const resolveTexture = (model, face) => {
      let texture = face?.texture;
      const seen = new Set();
      while (typeof texture === 'string' && texture.startsWith('#') && !seen.has(texture)) {
        seen.add(texture);
        texture = model.textures[texture.slice(1)];
      }
      return typeof texture === 'string' ? texture : null;
    };
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
        if (face?.texture && Array.isArray(element.from) && Array.isArray(element.to)) {
          const texture = block.id === 'minecraft:grass_block'
            ? 'minecraft:block/moss_block'
            : resolveTexture(model, face);
          if (!texture) diagnostics.add(block.id);
          else {
            const pixels = await textureData(texture);
            if (pixels) {
              const uv = face.uv ?? [element.from[0], element.from[2], element.to[0], element.to[2]];
              const grassUsesMossTexture = block.id === 'minecraft:grass_block';
              models.push({ element, pixels, uv, rotateY: ((variant.y ?? 0) % 360 + 360) % 360, uvRotation: face.rotation ?? 0, tint: !grassUsesMossTexture && face.tintindex !== undefined ? defaultBiomeTint(block.id) : null });
            }
          }
        }
        if (!proxy) {
          for (const [faceName, sideFace] of Object.entries(element.faces ?? {})) {
            if (faceName === 'up' || !sideFace?.texture) continue;
            const texture = resolveTexture(model, sideFace);
            if (!texture) continue;
            const pixels = await textureData(texture);
            if (pixels) {
              proxy = { pixels, tint: sideFace.tintindex === undefined ? null : defaultBiomeTint(block.id) };
              break;
            }
          }
        }
      }
    }
    const result = { faces: models, proxy };
    stateModelCache.set(cacheKey, result);
    if (!models.length && !proxy) diagnostics.add(block.id);
    return result;
  };

  let lowY = Infinity, highY = -Infinity;
  const ordered = [...schematic.blocks].sort((a, b) => a.y - b.y);
  const prepared = [];
  for (const block of ordered) {
    const rendered = await blockModels(block);
    if (!rendered.faces.length) {
      lowY = Math.min(lowY, block.y);
      highY = Math.max(highY, block.y + 1);
      specialFallbacks.add(rendered.proxy
        ? `${block.id} uses a translucent texture proxy because its model has no top face`
        : `${block.id} uses a magenta outline fallback because no top-face model or texture proxy could be rendered`);
    }
    for (const { element } of rendered.faces) {
      lowY = Math.min(lowY, block.y + element.from[1] / 16);
      highY = Math.max(highY, block.y + element.to[1] / 16);
    }
    prepared.push({ block, ...rendered });
  }
  for (const { block, faces, proxy } of prepared) {
    const section = block.sectionId ?? '';
    if (!sectionIds.has(section)) sectionIds.set(section, sectionIds.size + 1);
    const owner = sectionIds.get(section);
    const structural = isStructuralBlock(block.id);
    if (!faces.length) {
      const startX = Math.max(0, block.x * pixelSize), endX = Math.min(outWidth, (block.x + 1) * pixelSize);
      const startY = Math.max(0, (depth - block.z - 1) * pixelSize), endY = Math.min(outHeight, (depth - block.z) * pixelSize);
      for (let py = startY; py < endY; py++) for (let px = startX; px < endX; px++) {
        const at = py * outWidth + px;
        if (block.y + 1 < zBuffer[at]) continue;
        const lx = (px - startX) % pixelSize, ly = (py - startY) % pixelSize;
        const dest = at * 4;
        if (proxy) {
          const tx = Math.min(proxy.pixels.width - 1, Math.floor(lx * proxy.pixels.width / pixelSize));
          const ty = Math.min(proxy.pixels.height - 1, Math.floor(ly * proxy.pixels.height / pixelSize));
          const sample = (ty * proxy.pixels.width + tx) * 4;
          const alpha = Math.round(proxy.pixels.data[sample + 3] * 0.72);
          if (!alpha) continue;
          const mix = alpha / 255;
          raw[dest] = Math.round(proxy.pixels.data[sample] * (proxy.tint?.[0] ?? 255) / 255 * mix + raw[dest] * (1 - mix));
          raw[dest + 1] = Math.round(proxy.pixels.data[sample + 1] * (proxy.tint?.[1] ?? 255) / 255 * mix + raw[dest + 1] * (1 - mix));
          raw[dest + 2] = Math.round(proxy.pixels.data[sample + 2] * (proxy.tint?.[2] ?? 255) / 255 * mix + raw[dest + 2] * (1 - mix));
          raw[dest + 3] = Math.max(raw[dest + 3], alpha);
        } else {
          const edge = lx === 0 || ly === 0 || lx === pixelSize - 1 || ly === pixelSize - 1;
          const cross = lx === ly || lx + ly === pixelSize - 1;
          if (edge || cross) {
            const mix = 0.7;
            raw[dest] = Math.round(255 * mix + raw[dest] * (1 - mix));
            raw[dest + 1] = Math.round(raw[dest + 1] * (1 - mix));
            raw[dest + 2] = Math.round(220 * mix + raw[dest + 2] * (1 - mix));
            raw[dest + 3] = Math.max(raw[dest + 3], 180);
          }
        }
        surfaceBuffer[at] = Math.max(surfaceBuffer[at], block.y + 1);
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
        if (structural && pixels.data[sample + 3] > 248 && y >= terrainBuffer[at]) {
          terrainBuffer[at] = y;
          terrainOwners[at] = owner;
        }
        if (!alpha || y < zBuffer[at]) continue;
        if (y >= surfaceBuffer[at]) surfaceBuffer[at] = y;
        const dest = at * 4;
        const mix = alpha / 255;
        raw[dest] = Math.round(pixels.data[sample] * (tint?.[0] ?? 255) / 255 * mix + raw[dest] * (1 - mix));
        raw[dest + 1] = Math.round(pixels.data[sample + 1] * (tint?.[1] ?? 255) / 255 * mix + raw[dest + 1] * (1 - mix));
        raw[dest + 2] = Math.round(pixels.data[sample + 2] * (tint?.[2] ?? 255) / 255 * mix + raw[dest + 2] * (1 - mix));
        raw[dest + 3] = Math.max(raw[dest + 3], alpha);
        if (alpha > 248) zBuffer[at] = y;
      }
    }
  }
  const heightGrid = Array.from({ length: depth }, () => Array(width).fill(null));
  for (let py = 0; py < outHeight; py++) for (let px = 0; px < outWidth; px++) {
    const surface = surfaceBuffer[py * outWidth + px];
    if (!Number.isFinite(surface)) continue;
    const x = Math.floor(px / pixelSize), z = depth - 1 - Math.floor(py / pixelSize);
    heightGrid[z][x] = Math.max(heightGrid[z][x] ?? -Infinity, surface);
  }
  // Legacy per-block strength remains readable; global Y bounds are obsolete.
  const shadingStrength = Math.min(10, heightShadePerBlock / 0.018 * heightShadeMultiplier);
  shadeTerrain(raw, terrainBuffer, terrainOwners, outWidth, outHeight, pixelSize, shadingStrength, surfaceShadeMultiplier);
  await sharp(raw, { raw: { width: outWidth, height: outHeight, channels: 4 } }).png().toFile(output);
  const highestBlockY = Number.isFinite(highY) ? Math.floor(highY) : 0;
  const lowestBlockY = Number.isFinite(lowY) ? Math.floor(lowY) : 0;
  return {
    image: path.basename(output), width: outWidth, height: outHeight,
    bounds: { x: 0, y: 0, z: 0, width, height, depth }, projection: 'orthographic-xz',
    highestBlockY, lowestBlockY, heightGrid: { width, depth, values: heightGrid },
    materials: [...new Set(schematic.blocks.map(block => block.id))].sort(),
    unsupportedBlocks: [...diagnostics].sort(),
    specialBlockFallbacks: [...specialFallbacks].sort(),
    renderer: { name: 'relic-ortho-model-rasterizer', version: 8, shading: 'local-structural-relief', shadingStrength, surfaceShadeMultiplier, textureSource: 'Minecraft 26.3 client assets (world_version 5023)', pixelSize, heightShadePerBlock, heightShadeMinY, heightShadeMaxY, heightShadeMultiplier, biomeTint: 'deterministic default biome colors; not sampled from world biomes', animation: 'first texture frame' }
  };
}

