import test from 'node:test';
import assert from 'node:assert/strict';
import { shadeTerrain, isStructuralBlock } from '../src/terrain-shading.js';

function render(heights, { owners = heights.map(() => 1), strength = 1, surfaceStrength = 0 } = {}) {
  const raw = Buffer.alloc(heights.length * 4, 120);
  for (let i = 3; i < raw.length; i += 4) raw[i] = 255;
  shadeTerrain(raw, Float32Array.from(heights), Uint32Array.from(owners), heights.length, 1, 4, strength, surfaceStrength);
  return Array.from({ length: heights.length }, (_, i) => raw[i * 4]);
}

test('local contrast is independent of elevation and distant outliers', () => {
  const heights = Array.from({ length: 80 }, (_, x) => x >= 30 && x < 40 ? 4 : 1);
  const original = render(heights);
  assert.deepEqual(render(heights.map(y => y + 80)), original);
  heights[79] = 1000;
  assert.deepEqual(render(heights).slice(20, 50), original.slice(20, 50));
});

test('ledges distinguish upper and lower rims; stairs remain softer', () => {
  const ledge = render(Array.from({ length: 64 }, (_, x) => x < 32 ? 1 : 4));
  const step = render(Array.from({ length: 64 }, (_, x) => x < 32 ? 1 : 1.5));
  assert.ok(ledge[32] > ledge[31], 'upper rim is brighter than lower rim');
  assert.ok(Math.abs(step[32] - step[31]) < ledge[32] - ledge[31]);
  assert.ok(ledge[31] < 120, 'lower side gets a dark band');
});

test('empty space and unrelated sections do not create relief', () => {
  assert.deepEqual(render([1, 1, -Infinity, -Infinity]), [120, 120, 120, 120]);
  assert.deepEqual(render([1, 1, 8, 8], { owners: [1, 1, 2, 2] }), [120, 120, 120, 120]);
  assert.deepEqual(render([1, 8, 2, 4], { strength: 0 }), [120, 120, 120, 120]);
  assert.ok(render([1, 8, 2, 4], { strength: 10 }).every(value => value >= 57 && value <= 144));
});

test('decorations and fluids do not define terrain; partial structural blocks do', () => {
  for (const name of ['poppy', 'short_grass', 'oak_leaves', 'water', 'torch', 'redstone_wall_torch', 'potted_fern', 'pink_petals']) assert.equal(isStructuralBlock(`minecraft:${name}`), false, name);
  for (const name of ['grass_block', 'moss_block', 'stone', 'stone_slab', 'oak_stairs', 'oak_fence', 'snow_block']) assert.equal(isStructuralBlock(`minecraft:${name}`), true, name);
});

test('surface shading colors entire blocks independently of ledge strength and absolute height', () => {
  const heights = Array.from({ length: 64 }, (_, x) => x < 32 ? 1 : 5);
  const shaded = render(heights, { strength: 0, surfaceStrength: 1 });
  assert.ok(shaded[20] > 120, 'lower path brightens away from the edge');
  assert.ok(shaded[44] < 120, 'raised surface darkens away from the edge');
  assert.deepEqual(shaded.slice(44, 48), Array(4).fill(shaded[44]), 'tone covers the whole block');
  assert.deepEqual(render(heights.map(y => y + 100), { strength: 0, surfaceStrength: 1 }), shaded);
  const stronger = render(heights, { strength: 0, surfaceStrength: 2 });
  assert.ok(stronger[44] < shaded[44]);
  assert.deepEqual(render(heights, { strength: 0, surfaceStrength: 1, owners: heights.map((_, x) => x < 32 ? 1 : 2) }), Array(64).fill(120));
  assert.deepEqual(render([1, 1, 1, 1, -Infinity, -Infinity, -Infinity, -Infinity], { strength: 0, surfaceStrength: 1 }), Array(8).fill(120));
});
