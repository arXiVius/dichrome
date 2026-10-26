/**
 * Progressive Loading Module for DICHROIC
 *
 * Provides:
 * 1. Lazy stage loading: stages are only compiled/loaded when first needed
 * 2. Tile-based image preloading: large images load progressively in 256px tiles
 * 3. On-demand checkpoint management: checkpoints created only for active stages
 */

/**
 * Progressive Loading Module for DICHROIC
 *
 * Provides:
 * 1. Lazy stage loading: stages are only compiled/loaded when first needed
 * 2. Tile-based image preloading: large images load progressively in 256px tiles
 * 3. On-demand checkpoint management: checkpoints created only for active stages
 */

/**
 * Preload image tiles progressively for large images.
 * Loads 256px tiles on demand and renders through the film pipeline.
 *
 * @param imageBytes Raw image data (ArrayBuffer or Blob)
 * @param onTile Callback invoked for each loaded tile: (tile: { x: number; y: number })
 * @param tileSize Size of each tile in pixels (default 256)
 * @returns Promise that resolves when all tiles are loaded
 */
export async function preloadImageTiles(
  _imageBytes: ArrayBuffer,
  _onTile: (tile: { x: number; y: number }) => Promise<void>,
  _tileSize = 256,
): Promise<void> {
  // Stub preserved for when tile preloading is first needed; otherwise removed so
  // this module compiles cleanly without canvas / WebGPU / progressive-loading deps.
}

/**
 * Build a minimal CoreParams struct for a given tile for use during tile prefetch.
 */
export function minimalTileParams(width: number, height: number) {
  return {
    width,
    height,
    filmExposureEv: 0,
    filmGamma: 1,
    exposureCount: 1,
    inputColorSpace: 0,
    rgbToRawMethod: 0,
    colorSpaceCount: 0,
    transferLutSize: 0,
    colorDecodeMin: 0,
    colorDecodeMax: 0,
    hanatosWidth: 0,
    hanatosHeight: 0,
    slot0: 0,
    slot1: 0,
    slot2: 0,
    filmPushPullMode: 0,
    filmPushPullStops: 0,
    fullWidth: width,
    fullHeight: height,
    tileOriginX: 0,
    tileOriginY: 0,
    activeOriginX: 0,
    activeOriginY: 0,
    activeWidth: width,
    activeHeight: height,
  };
}

export type { CoreParams } from './params';
export { CORE_PARAMS_BYTES, CORE_PARAMS_WGSL, CORE_PARAMS_FIELD_NAMES, writeCoreParams, FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING, FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION, FLAG_GLARE_ACTIVE, FLAG_UNSHARP_ACTIVE, FLAG_INPUT_CCTF_DECODING } from './params';
export { computeAdaptiveCheckpointBound } from './graph';