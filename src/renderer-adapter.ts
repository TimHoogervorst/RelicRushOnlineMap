import { renderOrthographic as renderRasterizer } from './renderer.js';

export interface RenderBlock {
  sectionId?: string;
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
  heightGrid: { width: number; depth: number; values: Array<Array<number | null>> };
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
      // The rasterizer is currently implemented in JavaScript; keep the
      // application-facing contract typed while its option types migrate.
      const rasterOptions = input as unknown as Parameters<typeof renderRasterizer>[1];
      return await renderRasterizer(input.schematic, rasterOptions) as OrthographicRenderManifest;
    }
  };
}
