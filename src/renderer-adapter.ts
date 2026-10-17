import { renderOrthographic as renderRasterizer } from './renderer.js';

export interface RenderBlock {
  x: number;
  y: number;
  z: number;
  id: string;
  properties: Record<string, string>;
}

export interface OrthographicRenderInput {
  schematic: {
    dimensions: { x: number; y: number; z: number };
    blocks: RenderBlock[];
  };
  assets: string;
  output: string;
  pixelSize?: number;
}

export interface OrthographicRenderManifest {
  image: string;
  width: number;
  height: number;
  bounds: { x: number; y: number; z: number; width: number; height: number; depth: number };
  projection: 'orthographic-xz';
  highestBlockY: number;
  lowestBlockY: number;
  materials: string[];
  unsupportedBlocks: string[];
  specialBlockFallbacks: string[];
}

export interface RendererAdapter {
  readonly engine: 'relic-ortho-model-rasterizer';
  render(input: OrthographicRenderInput): Promise<OrthographicRenderManifest>;
}

/** Typed application seam between generation jobs and the selected raster backend. */
export function createRendererAdapter(): RendererAdapter {
  return {
    engine: 'relic-ortho-model-rasterizer',
    async render(input) {
      return await renderRasterizer(input.schematic, {
        assets: input.assets,
        output: input.output,
        pixelSize: input.pixelSize
      }) as OrthographicRenderManifest;
    }
  };
}
