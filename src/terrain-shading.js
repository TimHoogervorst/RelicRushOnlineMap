// Decoration policy is deliberately independent of texture alpha and biome tint:
// tinted solid blocks (notably grass) still define terrain. Unknown models with
// no top face never enter the structural pass.
const decorations = /(?:^|_)(?:leaves|sapling|flower|flowers|tulip|orchid|bush|fern|grass|seagrass|kelp|vine|vines|roots|sprouts|torch|lantern|candle|coral|fan|mushroom|fungus|sign|banner|button|rail|carpet|petals)$/;
const nonTerrain = new Set(['water', 'lava', 'fire', 'soul_fire', 'redstone_wire', 'tripwire', 'cobweb', 'snow', 'glow_lichen', 'sculk_vein', 'lily_pad', 'dandelion', 'poppy', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac', 'rose_bush', 'peony', 'pink_petals', 'spore_blossom', 'bamboo', 'sugar_cane', 'wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'sweet_berry_bush', 'hanging_roots', 'short_dry_grass', 'tall_dry_grass', 'dead_bush']);

export function isStructuralBlock(id) {
  const name = id.split(':').at(-1);
  return !nonTerrain.has(name) && !decorations.test(name) && !name.includes('potted_') && !name.includes('wall_torch') && !name.includes('coral_');
}

const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const cardinalDirections = directions.slice(0, 4);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Fixed sample count per pixel; missing terrain and other sections are not pits.
 * Heights retain model sub-block detail. This is visual relief, not navigation.
 */
export function shadeTerrain(raw, heights, owners, width, depth, pixelSize, strength, surfaceStrength = 0) {
  if (!strength && !surfaceStrength) return;
  const columns = Math.ceil(width / pixelSize), rows = Math.ceil(depth / pixelSize);
  const tones = new Float32Array(columns * rows);
  if (surfaceStrength) {
    const totals = new Float64Array(tones.length), counts = new Uint32Array(tones.length), sections = new Uint32Array(tones.length);
    for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
      const at = z * width + x;
      if (!Number.isFinite(heights[at])) continue;
      const cell = Math.floor(z / pixelSize) * columns + Math.floor(x / pixelSize);
      if (counts[cell] && sections[cell] !== owners[at]) sections[cell] = 0;
      else if (!counts[cell]) sections[cell] = owners[at];
      totals[cell] += heights[at]; counts[cell]++;
    }
    for (let cell = 0; cell < totals.length; cell++) if (counts[cell]) totals[cell] /= counts[cell];
    // One tone per block, sampled over a broader eight-block neighborhood.
    // This colors wall tops and passage surfaces, rather than just their rims.
    for (let z = 0; z < rows; z++) for (let x = 0; x < columns; x++) {
      const cell = z * columns + x;
      if (!counts[cell] || !sections[cell]) continue;
      let difference = 0, samples = 0;
      for (let radius = 1; radius <= 8; radius++) for (const [dx, dz] of directions) {
        const nx = x + dx * radius, nz = z + dz * radius;
        if (nx < 0 || nx >= columns || nz < 0 || nz >= rows) continue;
        const other = nz * columns + nx;
        if (!counts[other] || sections[other] !== sections[cell]) continue;
        difference += clamp(totals[cell] - totals[other], -6, 6); samples++;
      }
      if (samples) tones[cell] = clamp(-0.10 * difference / samples * surfaceStrength, -0.40, 0.25);
    }
  }
  const edgeRadius = Math.max(1, Math.round(pixelSize / 4));
  const radii = [pixelSize, 3 * pixelSize];
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const at = z * width + x, height = heights[at];
    if (!Number.isFinite(height) || !raw[at * 4 + 3]) continue;
    const owner = owners[at];
    let relief = 0, scales = 0, upperEdge = 0, lowerEdge = 0;
    for (const radius of radii) {
      let sum = 0, count = 0;
      for (const [dx, dz] of directions) {
        const nx = x + dx * radius, nz = z + dz * radius;
        if (nx < 0 || nx >= width || nz < 0 || nz >= depth) continue;
        const other = nz * width + nx;
        if (owners[other] !== owner || !Number.isFinite(heights[other])) continue;
        // Limit influence of isolated tall blocks and deep outliers.
        sum += clamp((height - heights[other]) / (radius / pixelSize), -3, 3);
        count++;
      }
      if (count) { relief += sum / count; scales++; }
    }
    for (const [dx, dz] of cardinalDirections) {
      const nx = x + dx * edgeRadius, nz = z + dz * edgeRadius;
      if (nx < 0 || nx >= width || nz < 0 || nz >= depth) continue;
      const other = nz * width + nx;
      if (owners[other] !== owner || !Number.isFinite(heights[other])) continue;
      const difference = height - heights[other];
      // Half slabs have no hard rim; single steps remain gentle. Larger drops
      // smoothly saturate, keeping tall walls from blacking out a passage.
      const t = clamp((Math.abs(difference) - 0.5) / 2.5, 0, 1);
      const edge = t * t * (3 - 2 * t);
      if (difference > 0) upperEdge = Math.max(upperEdge, edge);
      else lowerEdge = Math.max(lowerEdge, edge);
    }
    const surfaceTone = tones[Math.floor(z / pixelSize) * columns + Math.floor(x / pixelSize)];
    const reliefShade = clamp(1 + strength * (-0.10 * (scales ? relief / scales : 0) + 0.18 * upperEdge - 0.30 * lowerEdge), 0.48, 1.2);
    const shade = clamp(reliefShade * (1 + surfaceTone), 0.40, 1.3);
    for (let channel = 0; channel < 3; channel++) raw[at * 4 + channel] = clamp(Math.round(raw[at * 4 + channel] * shade), 0, 255);
  }
}
