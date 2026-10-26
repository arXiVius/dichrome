/**
 * Progressive Loading Module for DICHROIC
 *
 * Provides:
 * 1. Lazy stage loading: stages are only compiled/loaded when first needed
 * 2. Tile-based image preloading: large images load progressively in 256px tiles
 * 3. On-demand checkpoint management: checkpoints created only for active stages
 */

import { GPUBuffer, GPUBufferUsage } from 'webgpu-types';
import { Stage, CoreParams, FrameParams, EngineDevice, TapName } from './types';
import { planTiles, TileSpec, SPATIAL_EFFECT_RADIUS_PX, GRAIN_SPATIAL_RADIUS_PX } from './tiling';
import { estimateFrameByteSize } from './graph';

// Stage name to factory mapping for lazy loading
const stageFactoryMap: Record<string, (device: GPUDevice, arenas: any, spec: any) => Stage> = {};

/**
 * Register a stage factory for lazy loading.
 * Called by stage modules during initialization.
 */
export function registerStageFactory(name: string, factory: (device: GPUDevice, arenas: any, spec: any) => Stage): void {
  stageFactoryMap[name] = factory;
}

/**
 * Lazy stage wrapper that loads a stage on first access.
 * Reduces initial memory footprint by not compiling all stages at startup.
 */
class LazyStageWrapper {
  private stage: Stage | null = null;
  private loaded = false;
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  async ensureLoaded(device: GPUDevice, arenas: any, spec: any): Promise<Stage> {
    if (!this.loaded) {
      const factory = stageFactoryMap[this.name];
      if (factory) {
        this.stage = await factory(device, arenas, spec);
        this.loaded = true;
      } else {
        throw new Error(`Stage factory not registered for: ${this.name}`);
      }
    }
    return this.stage!;
  }

  getName(): string {
    return this.name;
  }
}

/**
 * Preload image tiles progressively for large images.
 * Loads 256px tiles on demand and renders through the film pipeline.
 *
 * @param imageBytes Raw image data (ArrayBuffer or Blob)
 * @param onTile Callback invoked for each loaded tile: (texture: GPUTexture, x: number, y: number)
 * @param tileSize Size of each tile in pixels (default 256)
 * @param params Film pipeline parameters
 * @returns Promise that resolves when all tiles are loaded
 */
export async function preloadImageTiles(
  imageBytes: ArrayBuffer,
  onTile: (tile: GPUTexture, x: number, y: number) => Promise<void>,
  tileSize = 256,
  params: CoreParams
): Promise<void> {
  // Create image bitmap from raw data
  const imgBlob = new Blob([imageBytes]);
  const img = await createImageBitmap(imgBlob);
  const { width, height } = img;

  // Load tiles row by row with yield between rows
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      // Extract tile region
      const canvas = document.createElement('canvas');
      canvas.width = tileSize;
      canvas.height = tileSize;
      const ctx = canvas.getContext('2d')!;
      
      // Draw only the valid portion of the tile (handle edge cases)
      const drawWidth = Math.min(tileSize, width - x);
      const drawHeight = Math.min(tileSize, height - y);
      
      ctx.drawImage(
        img,
        x, y, drawWidth, drawHeight, // source rect
        0, 0, drawWidth, drawHeight   // dest rect
      );
      
      // Convert canvas to GPU texture
      const texture = await ctxToGPUTexture(ctx);
      
      // Call the onTile callback
      await onTile(texture, x, y);
    }
    // Yield to main thread after each row to avoid blocking
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/**
 * Create a GPU texture from a 2d canvas context.
 * This is a utility function that should be adapted to the project's
 * WebGPU setup (typically involves creating a texture from a canvas canvas).
 */
async function ctxToGPUTexture(ctx: CanvasRenderingContext2D): Promise<GPUTexture> {
  // Create a temporary offscreen canvas and get the image data
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = ctx.canvas.width;
  tempCanvas.height = ctx.canvas.height;
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.drawImage(ctx.canvas, 0, 0);
  
  const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
  
  // Create WebGPU texture
  const device = (ctx.canvas as HTMLCanvasElement).getContext('webgpu')?.device;
  if (!device) {
    throw new Error('WebGPU device not available');
  }
  
  const texture = device.createTexture({
    size: [tempCanvas.width, tempCanvas.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  
  // Copy image data to texture
  device.queue.copyExternalImageToTexture(
    { source: tempCanvas, flipped: false },
    { texture, mipLevel: 0, layer: 0 },
    [tempCanvas.width, tempCanvas.height]
  );
  
  return texture;
}

/**
 * Estimate the memory budget needed for a given number of stages
 * and frame size, for use in budget-aware progressive loading.
 */
export function estimateMemoryBudget(
  stageCount: number,
  width: number,
  height: number,
  gpuMemoryBytes?: number
): { maxStages: number; maxBytes: number } {
  const frameByteSize = estimateFrameByteSize(width, height);
  return computeAdaptiveCheckpointBound(stageCount, frameByteSize, gpuMemoryBytes);
}

/**
 * CoreParams property defaults for progressive loading.
 * Used when creating minimal params for tile previews.
 */
export const DEFAULT_PROGRESSIVE_PARAMS: CoreParams = {
  filmFormatMm: 35.0,
  grainAmount: 0,
  halationAmount: 0,
  diffusionAmount: 0,
  printExposure: 1,
  exposureCompensationEv: 0,
  scannerUnsharpAmount: 0,
  glarePercent: 0,
  dirCouplersAmount: 1,
  dirInhibitionSameLayer: 1,
  dirInhibitionInterLayer: 1,
};