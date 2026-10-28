/**
 * Graf render: rangkaian `Stage` yang dijalankan berurutan di atas SATU
 * pasangan buffer ping-pong, berhenti pada tahap terakhir yang menulis tap
 * yang diminta pemanggil.
 *
 * Ini mencerminkan topologi referensi Python: sebuah "tap" bukan lokasi
 * penyimpanan tersendiri, melainkan label checkpoint pada satu buffer citra
 * yang terus disempurnakan tahap demi tahap. `CurveDevelop`, `Dir`,
 * `Halation`, `Grain`, dan `Diffusion['camera']` (Task 13-16) semuanya
 * MENULIS `cmy_film` — masing-masing menyempurnakan keadaan yang sama, bukan
 * menghasilkan salinan baru. Karena itu `run()` mencari tahap **terakhir**
 * yang menulis tap yang diminta (bukan yang pertama): memakai kecocokan
 * pertama akan menghentikan graf di tahap pertama yang menyentuh tap itu dan
 * membuat tahap-tahap penyempurna berikutnya lulus tanpa pernah berjalan.
 *
 * `Array.prototype.findLastIndex` (ES2023) SENGAJA tidak dipakai — lib
 * tsconfig paket ini adalah `ES2022`, yang mendahului method itu; memakainya
 * akan lulus di runtime Node tapi gagal `tsc -b --noEmit`. `findLastStageIndex`
 * di bawah adalah loop terbalik manual yang setara, tanpa menaikkan target lib.
 *
 * CACHE PER-TAHAP: slider mengubah parameter ~60×/s, dan setiap perubahan
 * biasanya hanya mempengaruhi satu tahap dan tahap-tahap sesudahnya. Tiap
 * `Stage` karena itu boleh memberi `paramHash`; `runSingleBuffer` menghitung
 * hash semua tahap sampai `collect`, mencari checkpoint TERAKHIR yang masih
 * bersih, lalu menyalin buffer checkpoint itu ke `front` dan baru menjalankan
 * tahap sesudahnya -- tahap hulu yang tidak berubah tidak didispatch sama
 * sekali. Checkpoint adalah buffer GPU seukuran frame, jadi jumlahnya dibatasi
 * (`CHECKPOINT_BUDGET_BYTES`/`CHECKPOINT_MAX_STAGES`); tahap yang tidak muat
 * hanya berarti render penuh, tidak pernah piksel yang salah.
 */

import type { DiffusionFilterConfig } from '../host/diffusionFilter';
import type { LensFrame } from '../host/lens';
import { CORE_PARAMS_BYTES, writeCoreParams } from './params';
import type { CoreParams } from './params';
import type { NaturalFrame } from '../host/naturalize';
import type { EngineDevice } from './device';
import type { TapName } from './taps';
import { gpuBufferUsage, gpuMapMode } from './webgpuGlobals';
import { planExportTiles, planTiles } from './tiling';
import type { TileSpec } from './tiling';

/**
 * Nilai per-render yang dipakai HOST saat meng-encode tahap, tapi tidak
 * masuk blok `CoreParams` (yang sengaja mencerminkan persis push-constant OFX,
 * 26 field -- `test/params.test.ts`). Fase 2A.5: `filmFormatMm` menggantikan
 * konstanta 35.0 yang dulu disalin di halation/DIR/grain, supaya ukuran
 * piksel (`film_format_mm * 1000 / max(fullWidth, fullHeight)`, Python
 * `ResizingService.pixel_size_um`) bisa disetel -- termasuk ke ukuran piksel
 * foto sungguhan pada fixture 64 px.
 */
export interface FrameParams {
  neutralFilm?: Float32Array;
  cameraOutput?: Float32Array;
  softenDetail?: { amount: number; luma: readonly number[] };
  /** Ekstensi "Natural" (`host/naturalize.ts`): hanya dibaca tahap `natural`. */
  natural?: NaturalFrame;
  filmFormatMm: number;
  /**
   * Fase 2C: `camera.exposure_compensation_ev` Python (EV kompensasi, TANPA
   * auto-exposure) untuk midgray `_comp` print. Baku 0.
   */
  exposureCompensationEv?: number;
  /** Fase 2C: `enlarger.print_exposure_compensation` Python. Baku `false`. */
  printExposureCompensation?: boolean;
  /** Fase 2C: `enlarger.print_exposure` Python (linear, `2**printExposureEv`). Baku 1. */
  printExposure?: number;
  /** Fase 2C: `film_render.halation.active` Python. Baku `true`. */
  halationEnabled?: boolean;
  /** Fase 2C: `film_render.halation.halation_amount` Python. Baku 1. */
  halationAmount?: number;
  /** Fase 2C: `scanner.unsharp_mask[1]` Python (amount; sigma tetap 0.7 px). Baku 0.7. */
  scannerUnsharpAmount?: number;
  /** Fase 2C: `print_render.glare.percent` Python. Baku 0.03. */
  glarePercent?: number;
  /** Fase 2C: `grainSeed` OFX (RNG grain; Python memakai seed tetap). Baku 1. */
  grainSeed?: number;
  /** Fase 2C: `grainAmount` OFX (`applyGrainControls`). Baku 1. */
  grainAmount?: number;
  /**
   * Fase 2C: pengali nilai input TER-ENCODE sebelum decode CCTF
   * (`2**autoexposure_ev`, Python `FilmingStage.auto_exposure`). Hanya dibaca
   * bila flag decode menyala. Baku 1.
   */
  inputDecodeScale?: number;
  /**
   * Ekstensi "Camera Raw" (`host/cameraDevelop.ts`): isi uniform
   * `CameraFrame` `filmExposure`. Tidak ada = dilewati persis.
   */
  camera?: Float32Array;
  /** Ekstensi lens blur (`host/lens.ts`): hanya dibaca tahap `lensBlur`. */
  lens?: LensFrame;
  /**
   * Fase 2D: `film_render.dir_couplers` Python -- `amount` (0 bila
   * `active=False`), `inhibition_samelayer`, `inhibition_interlayer`, dan
   * `diffusion_size_um` (0 mematikan difusi spasial, termasuk ekornya).
   * Baku 1, 1, 1, 20.
   */
  dirCouplersAmount?: number;
  dirInhibitionSameLayer?: number;
  dirInhibitionInterlayer?: number;
  dirDiffusionUm?: number;
  /**
   * Fase 2D: `enlarger.preflash_exposure` dan shift filter M/Y preflash
   * Python. Baku 0 (preflash mati).
   */
  preflashExposure?: number;
  preflashMFilterShift?: number;
  preflashYFilterShift?: number;
  /**
   * Fase 2D Task 4: `camera.diffusion_filter` dan `enlarger.diffusion_filter`
   * Python bila aktif (tahap `diffusionFft`). Tidak ada = tidak aktif.
   */
  cameraDiffusion?: DiffusionFilterConfig;
  printDiffusion?: DiffusionFilterConfig;
}

/** Python `CameraParams.film_format_mm` default (35 mm). */
export const DEFAULT_FRAME: Readonly<FrameParams> = Object.freeze({ filmFormatMm: 35 });

export interface StageContext {
  device: GPUDevice;
  params: CoreParams;
  frame: Readonly<FrameParams>;
  paramsBuffer: GPUBuffer;
  source: GPUBuffer;
  dest: GPUBuffer;
  /**
   * Buffer antara milik graf, dipakai ulang antar dispatch berlabel sama.
   * Tahap multi-pass (Task 11+) HARUS memperoleh buffer perantaranya lewat
   * fungsi ini, bukan `device.createBuffer()` sendiri — pool-nya berumur
   * selama instance `RenderGraph`, bukan selama satu `run()`, persis supaya
   * render ter-tile (Task 19, satu `run()` per tile pada graf yang sama)
   * tidak menciptakan buffer baru per tile per tahap dan meledakkan VRAM.
   */
  scratch(label: string, bytes: number): GPUBuffer;
  /**
   * Buffer kecil yang hanya hidup selama render ini (uniform per tahap);
   * dihancurkan graf setelah GPU selesai. Pakai lewat `frameBuffer` di
   * `transient.ts`. Jangan untuk sumber daya yang di-cache antar render.
   */
  transient?(descriptor: GPUBufferDescriptor): GPUBuffer;
}

export interface Stage {
  dispose?: () => void;
  /** Release frame-sized persistent textures/spectra without recompiling pipelines. */
  releaseFrameResources?: () => void;
  name: string;
  /** Setiap tap kanonis yang ditulis tahap ini. Kosong untuk tahap murni internal. */
  writesTaps: readonly TapName[];
  /**
   * Task 19b: radius (px) apron spasial yang tahap ini "konsumsi" setelah
   * berjalan -- port `xRadius`/`consumeSpatialRadius(xRadius)` hulu
   * (`SpektraVulkanRenderer.cpp:4999-5006`/`:6238-6244`, konstanta sama
   * `SPATIAL_EFFECT_RADIUS_PX`/`GRAIN_SPATIAL_RADIUS_PX` yang
   * `tiling.ts::estimateTileOverlap` jumlahkan untuk merencanakan apron
   * buffer). Dipakai HANYA oleh `RenderGraph.runSingleBuffer` saat
   * `shrinkApron` benar (render ter-tile sungguhan, lih. `runTiled` di
   * bawah) -- untuk render full-frame biasa field ini tidak pernah dibaca,
   * `params.activeWidth/Height` pemanggil dipakai apa adanya untuk SETIAP
   * tahap sama seperti sebelum Task 19b. `undefined`/`0` (baku) untuk
   * tahap tanpa kernel spasial (materializeActiveRegion, filmExposure,
   * curveDevelop, printExpose/printDevelop).
   */
  spatialRadiusPx?: number | ((params: CoreParams, frame: Readonly<FrameParams>) => number);
  encode(encoder: GPUCommandEncoder, ctx: StageContext): void;
  /**
   * Optional parameter hash/key for incremental stage caching.
   * Return a string or number that uniquely represents this stage's inputs/parameters.
   */
  paramHash?: (params: CoreParams, frame: Readonly<FrameParams>) => string | number;
}

/**
 * Resolves the parameter signature for a stage, using the stage's custom `paramHash`
 * method if defined, or falling back to built-in parameter signatures for known
 * engine stage names. Returns undefined for unknown stages (which marks them always dirty).
 */
export function getStageParamHash(
  stage: Stage,
  params: CoreParams,
  frame: Readonly<FrameParams>,
): string | undefined {
  if (stage.paramHash !== undefined) {
    return String(stage.paramHash(params, frame));
  }
  const name = stage.name;
  if (name === 'materializeActiveRegion') {
    return `mat:${params.width}x${params.height}:${params.activeOriginX},${params.activeOriginY},${params.activeWidth},${params.activeHeight}`;
  }
  if (name === 'softenDetail') {
    const s = frame.softenDetail;
    return `soft:${params.width}x${params.height}:${params.fullWidth}x${params.fullHeight}:${s?.amount ?? 0}:${s?.luma ? s.luma.join(',') : ''}`;
  }
  if (name === 'natural') {
    const n = frame.natural;
    return `nat:${params.width}x${params.height}:${params.fullWidth}x${params.fullHeight}:${params.tileOriginX},${params.tileOriginY}:${n?.amount}:${n?.gain}:${n?.logMean}`;
  }
  if (name === 'filmExposure' || name === 'cameraLinear') {
    let cam = '';
    if (frame.camera) {
      for (let i = 0; i < frame.camera.length; i++) cam += frame.camera[i] + ',';
    }
    return `filmExp:${name}:${params.filmExposureEv}:${params.filmGamma}:${params.inputColorSpace}:${params.rgbToRawMethod}:${params.colorDecodeMin}:${params.colorDecodeMax}:${params.slot0}:${params.slot1}:${frame.inputDecodeScale ?? 1}:${cam}`;
  }
  if (name.startsWith('neutralFilm:')) {
    let nHash = '';
    if (frame.neutralFilm) {
      for (let i = 0; i < frame.neutralFilm.length; i++) nHash += frame.neutralFilm[i] + ',';
    }
    return `${name}:${nHash}:${params.hanatosWidth}:${params.hanatosHeight}`;
  }
  if (name === 'lensBlur') {
    const l = frame.lens;
    if (!l) return undefined;
    return `lens:${params.width}x${params.height}:${l.focusDisparity}:${l.cocScalePx}:${l.maxCocPx}:${l.nearDisparity}:${l.foreground}:${l.bladeCurvature}:${l.catEye}:${l.blades}:${l.depth.width}x${l.depth.height}`;
  }
  if (name.startsWith('diffusion:')) {
    const site = name.includes('camera') ? 'camera' : 'print';
    const conf = site === 'camera' ? frame.cameraDiffusion : frame.printDiffusion;
    return `diff:${name}:${params.width}x${params.height}:${frame.filmFormatMm}:${conf?.family}:${conf?.strength}:${conf?.spatialScale}`;
  }
  if (name === 'halation') {
    return `hal:${frame.halationEnabled !== false}:${frame.halationAmount ?? 1}:${frame.filmFormatMm}:${params.slot1}`;
  }
  if (name === 'curveDevelop') {
    return `curve:${params.filmPushPullMode}:${params.filmPushPullStops}:${params.slot1}:${params.filmGamma}`;
  }
  if (name === 'dir') {
    return `dir:${frame.dirCouplersAmount ?? 1}:${frame.dirInhibitionSameLayer ?? 1}:${frame.dirInhibitionInterlayer ?? 1}:${frame.dirDiffusionUm ?? 20}:${frame.filmFormatMm}`;
  }
  if (name === 'grain') {
    return `grain:${frame.grainSeed ?? 1}:${frame.grainAmount ?? 1}:${frame.filmFormatMm}`;
  }
  if (name === 'printScan:expose') {
    return `pExp:${frame.printExposure ?? 1}:${frame.printExposureCompensation ?? false}:${frame.exposureCompensationEv ?? 0}:${frame.preflashExposure ?? 0}:${frame.preflashMFilterShift ?? 0}:${frame.preflashYFilterShift ?? 0}:${params.slot1}:${params.filmGamma}`;
  }
  if (name === 'printScan:develop') {
    return `pDev:${params.slot1}`;
  }
  if (name.startsWith('printLut:')) {
    let co = '';
    if (frame.cameraOutput) {
      for (let i = 0; i < frame.cameraOutput.length; i++) co += frame.cameraOutput[i] + ',';
    }
    return `${name}:${co}`;
  }
  if (name === 'cameraOutput') {
    let co = '';
    if (frame.cameraOutput) {
      for (let i = 0; i < frame.cameraOutput.length; i++) co += frame.cameraOutput[i] + ',';
    }
    return `camOut:${co}`;
  }
  if (name.startsWith('scannerPost:')) {
    return `scanPost:${frame.scannerUnsharpAmount ?? 0.7}:${frame.glarePercent ?? 0.03}:${params.slot1}`;
  }
  return undefined;
}

/**
 * Fase 2A.5: radius boleh bergantung ukuran piksel (sigma halation/DIR dalam
 * um -> px, `src/engine/spatialRadius.ts`), jadi diselesaikan per run dari
 * `params` (dimensi gambar penuh) dan `frame` (format film).
 */
function resolveSpatialRadius(stage: Stage, params: CoreParams, frame: Readonly<FrameParams>): number {
  const r = stage.spatialRadiusPx;
  if (r === undefined) return 0;
  return typeof r === 'function' ? r(params, frame) : r;
}

const PING_PONG_USAGE =
  gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_SRC | gpuBufferUsage.COPY_DST;

/**
 * Loop terbalik manual yang setara `Array.prototype.findLastIndex` — lih.
 * komentar modul di atas untuk alasan tidak memakai method bawaan itu.
 */
function findLastStageIndex(stages: readonly Stage[], tap: TapName): number {
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    if (stages[i]!.writesTaps.includes(tap)) return i;
  }
  return -1;
}

/** Sub-rektangel `{x, y, width, height}` sederhana -- dipakai `inflateActiveRect` di bawah. */
interface ActiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Task 19b: port `inflatedCenterRect` + `setActiveRect` hulu
 * (`SpektraVulkanRenderer.cpp:6195-6217`) -- membesarkan `center` (rektangel
 * AKTIF tile, TANPA apron) sebesar `radius` di setiap sisi, diklip ke
 * `[0,bufWidth) x [0,bufHeight)`. Ini persis mekanisme yang MENULISKAN apron:
 * dipanggil sebelum setiap tahap dengan `radius = remainingSpatialRadius`
 * ("radius efek spasial yang BELUM dikonsumsi tahap manapun sejauh ini",
 * lih. `runSingleBuffer`), jadi tahap paling awal memproses AKTIF+SELURUH
 * apron yang tersisa, dan tiap tahap spasial mengonsumsi radiusnya sendiri
 * sampai tahap TERAKHIR memproses persis `center` -- rektangel keluaran tile
 * yang sebenarnya, TANPA apron.
 *
 * Fallback "seluruh buffer" saat hasil kempis ke lebar/tinggi nol mengikuti
 * `setActiveRect` hulu persis (baris 6213-6216) -- tidak akan terpicu untuk
 * `radius>=0` dan `center` yang valid (lebar/tinggi aktif tile SELALU >0,
 * dijamin `planTiles`), tapi diport apa adanya demi kesetiaan, bukan
 * dihilangkan sebagai "tidak mungkin terjadi".
 */
function inflateActiveRect(
  center: ActiveRect,
  radius: number,
  bufWidth: number,
  bufHeight: number,
): ActiveRect {
  const x0 = center.x > radius ? center.x - radius : 0;
  const y0 = center.y > radius ? center.y - radius : 0;
  const x1 = Math.min(bufWidth, center.x + center.width + radius);
  const y1 = Math.min(bufHeight, center.y + center.height + radius);

  const originX = Math.min(x0, bufWidth);
  const originY = Math.min(y0, bufHeight);
  const width = Math.min(x1 > x0 ? x1 - x0 : 0, bufWidth - originX);
  const height = Math.min(y1 > y0 ? y1 - y0 : 0, bufHeight - originY);

  if (width === 0 || height === 0) {
    return { x: 0, y: 0, width: bufWidth, height: bufHeight };
  }
  return { x: originX, y: originY, width, height };
}

/**
 * Task 19: ekstrak buffer satu tile (`tile.tileWidth x tile.tileHeight`,
 * termasuk apron) dari `source` bertata-letak gambar PENUH
 * (`fullWidth x fullHeight`, tersirat dari `fullWidth` di sini karena
 * `planTiles` menjamin `tile.tileOriginX/Y + tile.tileWidth/Height <=
 * fullWidth/Height` -- lih. `tiling.ts`). Baris-demi-baris (bukan satu
 * `subarray`) dengan alasan yang SAMA seperti
 * `materializeActiveRegion.wgsl`: sub-rektangel dari tata-letak 2D bukan
 * rentang byte kontigu.
 */
/**
 * Sumber piksel tile ekspor: isi `into` dengan RGBA tile (`tileOriginX/Y`,
 * `tileWidth x tileHeight` di koordinat frame penuh) dan kembalikan
 * subarray-nya. Dipakai ekspor yang membaca tile langsung dari foto sumber.
 */
export type TileSource = (tile: TileSpec, into: Float32Array) => Float32Array;

/**
 * GPU menolak pekerjaan satu tile karena memori (error scope `out-of-memory`
 * atau `internal`). Ekspor menangkapnya, mengecilkan anggaran tile, lalu
 * mengulang dengan tile yang lebih kecil.
 */
export class GpuMemoryError extends Error {
  constructor(detail: string, readonly tilePixels: number) {
    super(`The GPU ran out of memory rendering a ${tilePixels}-pixel tile: ${detail}`);
    this.name = 'GpuMemoryError';
  }
}

function extractTileInput(source: Float32Array, fullWidth: number, tile: TileSpec, into?: Float32Array): Float32Array {
  const floats = tile.tileWidth * tile.tileHeight * 4;
  const out = into ? into.subarray(0, floats) : new Float32Array(floats);
  for (let row = 0; row < tile.tileHeight; row += 1) {
    const srcRowStart = ((tile.tileOriginY + row) * fullWidth + tile.tileOriginX) * 4;
    const dstRowStart = row * tile.tileWidth * 4;
    out.set(source.subarray(srcRowStart, srcRowStart + tile.tileWidth * 4), dstRowStart);
  }
  return out;
}

/**
 * Task 19: jahit HANYA sub-rektangel AKTIF (`tile.activeWidth x
 * tile.activeHeight`, TANPA apron) dari hasil satu tile ke posisi
 * globalnya pada `output` bertata-letak gambar PENUH. Posisi lokal
 * sub-rektangel aktif di dalam buffer hasil tile adalah
 * `tile.activeOriginX/Y - tile.tileOriginX/Y` -- SAMA persis konversi
 * yang `runTiled` pakai untuk mengisi `CoreParams.activeOriginX/Y` saat
 * mendispatch tile ini (lih. `runTiled`), jadi baris yang dijahit di sini
 * SELALU baris yang benar-benar ditulis tahap terakhir graf untuk tile
 * ini.
 */
function stitchTileOutput(
  output: Float32Array,
  fullWidth: number,
  tileResult: Float32Array,
  tile: TileSpec,
  channels: 3 | 4 = 4,
): void {
  const localOriginX = tile.activeOriginX - tile.tileOriginX;
  const localOriginY = tile.activeOriginY - tile.tileOriginY;
  for (let row = 0; row < tile.activeHeight; row += 1) {
    const srcRowStart = ((localOriginY + row) * tile.tileWidth + localOriginX) * 4;
    const dstRowStart = ((tile.activeOriginY + row) * fullWidth + tile.activeOriginX) * channels;
    if (channels === 4) {
      output.set(tileResult.subarray(srcRowStart, srcRowStart + tile.activeWidth * 4), dstRowStart);
    } else {
      for (let col = 0; col < tile.activeWidth; col++) {
        const source = srcRowStart + col * 4;
        const dest = dstRowStart + col * 3;
        output[dest] = tileResult[source]!;
        output[dest + 1] = tileResult[source + 1]!;
        output[dest + 2] = tileResult[source + 2]!;
      }
    }
  }
}

/**
 * Pool buffer scratch yang DIBAGI antar tahap (dan antar graf milik satu
 * `Session`). Tahap berjalan berurutan dalam satu command buffer dan hanya
 * berkomunikasi lewat `source`/`dest`, jadi scratch tahap A bebas dipakai
 * ulang tahap B: memori puncak = tahap terbesar, bukan jumlah semua tahap
 * (dulu ~9,9 GB scratch persisten untuk satu ekspor 24 MP ber-grain).
 *
 * Kunci pool adalah SLOT (`slot0`, `slot1`, ...), bukan label tahap: label
 * pertama yang diminta sebuah tahap mendapat slot0, label kedua slot1, dst.,
 * dan label yang sama dalam satu tahap mendapat slot yang sama (dipakai
 * tahap untuk sengaja menumpuk buffer yang umurnya tidak bertumpuk).
 *
 * Membesarkan slot di tengah encode tidak boleh menghancurkan buffer lama
 * (perintah yang sudah di-encode masih merujuknya): buffer lama dipensiunkan
 * dan baru dihancurkan `flushRetired()` setelah GPU selesai.
 */
export class ScratchPool {
  private readonly buffers = new Map<string, GPUBuffer>();
  private readonly frameBuffers = new Map<string, GPUBuffer>();
  private retired: GPUBuffer[] = [];

  constructor(private readonly device: GPUDevice) {}

  get(key: string, bytes: number): GPUBuffer {
    const existing = this.buffers.get(key);
    if (existing && existing.size >= bytes) return existing;
    if (existing) this.retired.push(existing);
    const buffer = this.device.createBuffer({ label: `scratch:${key}`, size: bytes, usage: PING_PONG_USAGE });
    this.buffers.set(key, buffer);
    return buffer;
  }

  /** Reuse the large ping/pong/readback buffers across frames and stock changes. */
  getFrame(key: 'ping' | 'pong' | 'readback', bytes: number): GPUBuffer {
    const existing = this.frameBuffers.get(key);
    if (existing && existing.size >= bytes) return existing;
    if (existing) this.retired.push(existing);
    const usage = key === 'readback'
      ? gpuBufferUsage.COPY_DST | gpuBufferUsage.MAP_READ
      : PING_PONG_USAGE;
    const buffer = this.device.createBuffer({ label: `frame:${key}`, size: bytes, usage });
    this.frameBuffers.set(key, buffer);
    return buffer;
  }

  /** Hancurkan buffer yang tergantikan; panggil hanya setelah pekerjaan GPU yang merujuknya selesai. */
  flushRetired(): void {
    for (const buffer of this.retired) buffer.destroy();
    this.retired = [];
  }

  /** Byte yang sedang dipegang (untuk pengujian dan diagnosis memori). */
  get bytes(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) total += buffer.size;
    return total;
  }

  /**
   * Lepas semua buffer. `Session` memanggilnya setelah render penuh (ekspor):
   * scratch seukuran foto penuh tidak dibiarkan menetap sementara pengguna
   * lanjut mengedit pratinjau yang jauh lebih kecil.
   */
  release(): void {
    this.flushRetired();
    for (const buffer of this.buffers.values()) buffer.destroy();
    for (const buffer of this.frameBuffers.values()) buffer.destroy();
    this.buffers.clear();
    this.frameBuffers.clear();
    returnFreedMemory(this.device);
  }
}

/**
 * Dawn baru mengembalikan memori buffer yang sudah `destroy()` ke sistem
 * setelah submit BERIKUTNYA selesai (terukur: 3 GB tetap terpakai sampai
 * ada submit, lalu turun ke nol). Tanpa ini memori ekspor tertahan sampai
 * pengguna menggeser slider lagi.
 */
export function returnFreedMemory(device: GPUDevice): void {
  try {
    device.queue.submit([]);
    void device.queue.onSubmittedWorkDone().catch(() => {});
  } catch {
    // A lost device must not turn resource cleanup into another failure.
  }
}

/**
 * Batas memori cache checkpoint per-tahap (`RenderGraph.stageCheckpoints`).
 *
 * Setiap checkpoint adalah SATU buffer GPU seukuran frame (16 B/piksel), jadi
 * cache "semua tahap" pada pratinjau 2048x1366 adalah ~490 MiB buffer yang
 * ditahan terus-menerus -- lebih besar daripada anggaran pratinjau perangkat
 * itu sendiri, dan justru pada kasus (zoom tinggi) yang paling butuh memori.
 * Batasnya dinyatakan dalam byte DAN jumlah tahap; yang pertama tercapai
 * menang.
 *
 * Yang disimpan adalah checkpoint tahap PALING AWAL: checkpoint tahap c juga
 * membuat setiap perubahan pada tahap > c melanjutkan dari c+1 (bukan dari 0),
 * jadi N checkpoint awal menutup semua perubahan hilir dengan N tahap yang
 * tidak perlu dihitung ulang -- per byte, itu cakupan terluas. Konsekuensinya
 * perubahan hilir (mis. exposure print) melewati sebagian, bukan hampir semua,
 * tahap saat frame-nya besar; frame pratinjau biasa (<= 1 MP, 16 MiB) tetap
 * memuat semua 8.
 */
/**
 * Adaptive checkpoint sizing: bound depends on:
 * - Number of stages in the chain (more stages = fewer checkpoints per stage)
 * - Frame byte size (larger frames = fewer checkpoints to stay within budget)
 * - Available GPU memory (detected via navigator.deviceMemory or fallback)
 *
 * Formula: maxStages = min(8, ceil(stages.length/2), floor(128MiB / frame_size))
 *         maxBytes = maxStages * typical_frame_size (capped at 128MiB)
 */
export function computeAdaptiveCheckpointBound(
  stageCount: number,
  frameByteSize: number,
  gpuMemoryBytes?: number
): { maxStages: number; maxBytes: number } {
  // Base budget: 128 MiB, adjustable via device memory detection
  const baseBudget = gpuMemoryBytes ?? 128 * 1024 * 1024;

  // Factor 1: stages count - capped at hard ceiling of 8 stages
  const hardCeiling = 8;
  const stagesFactor = stageCount > 0 ? Math.min(hardCeiling, stageCount) : hardCeiling;

  // Factor 2: frame size - larger frames consume more budget per checkpoint
  const budgetFactor = frameByteSize > 0 ? Math.floor(baseBudget / frameByteSize) : hardCeiling;

  // Adaptive: take the most restrictive of the factors
  const maxStages = Math.min(hardCeiling, stagesFactor, Math.max(1, budgetFactor));

  // Compute max bytes: each checkpoint can be at most baseBudget
  const maxBytes = baseBudget;

  return { maxStages, maxBytes };
}

/**
 * Estimate the byte size of a frame at given dimensions.
 * Assumes Float32Array RGBA = 4 bytes per pixel.
 */
export function estimateFrameByteSize(width: number, height: number): number {
  return width * height * 4 * 4; // width * height pixels * 4 bytes (f32) * 4 channels (RGBA)
}

export class RenderGraph {
  private readonly stages: Stage[] = [];
  /**
   * Pool scratch. SENGAJA TIDAK dibersihkan di akhir `run()` — lih.
   * dokumentasi `StageContext.scratch` di atas. Graf yang tidak diberi pool
   * bersama memiliki pool sendiri, dibersihkan lewat `dispose()`.
   */
  private readonly pool: ScratchPool;
  private readonly ownsPool: boolean;
  private readonly stageCheckpoints = new Map<number, { buffer: GPUBuffer; paramHash: string; bytes: number }>();
  private lastInputRef: Float32Array | null = null;
  private lastWidth = 0;
  private lastHeight = 0;
  #disposed = false;

  /** Estimated byte size of a single frame checkpoint. Computed adaptively. */
  private adaptiveMaxStages = 8;
  private adaptiveMaxBytes = 128 * 1024 * 1024;
  private frameByteSizeEstimate = 0;
  private gpuMemoryBytes?: number;

  constructor(
    private readonly engine: EngineDevice,
    sharedPool?: ScratchPool,
    /** Optional GPU memory budget in bytes; computed from navigator.deviceMemory if omitted */
    gpuMemoryBytes?: number
  ) {
    this.pool = sharedPool ?? new ScratchPool(engine.device);
    this.ownsPool = sharedPool === undefined;
    this.gpuMemoryBytes = gpuMemoryBytes;
    this.frameByteSizeEstimate = estimateFrameByteSize(6000, 4000);
    this.updateAdaptiveBounds();
  }

  private updateAdaptiveBounds(frameBytes?: number): void {
    const { maxStages, maxBytes } = computeAdaptiveCheckpointBound(
      this.stages.length,
      frameBytes ?? this.frameByteSizeEstimate,
      this.gpuMemoryBytes
    );
    this.adaptiveMaxStages = maxStages;
    this.adaptiveMaxBytes = maxBytes;
  }

  addStage(stage: Stage): void {
    this.stages.push(stage);
    this.updateAdaptiveBounds();
  }

  /** Byte dan jumlah checkpoint yang sedang dipegang (pengujian, diagnosis memori). */
  get checkpointUsage(): { count: number; bytes: number } {
    let bytes = 0;
    for (const cp of this.stageCheckpoints.values()) bytes += cp.bytes;
    return { count: this.stageCheckpoints.size, bytes };
  }

  /** Clear all cached stage outputs. */
  clearStageCheckpoints(): void {
    for (const cp of this.stageCheckpoints.values()) {
      cp.buffer.destroy();
    }
    this.stageCheckpoints.clear();
    this.lastInputRef = null;
    this.lastWidth = 0;
    this.lastHeight = 0;
  }

  /**
   * Task 19: titik masuk publik. `options.maxBufferBytes`, bila diberikan,
   * diteruskan ke `planTiles` (lih. `tiling.ts`) untuk merencanakan grid
   * tile. Gambar yang muat memakai satu frame utuh: batas gambar sendiri
   * sudah mencakup seluruh konteks blur, tanpa apron tambahan. Pengujian
   * parity dapat memaksa tiling lewat `forceTiling`.
   *
   * `options.overlap` — BUKAN bagian tanda tangan yang dituliskan rencana
   * (`{ maxBufferBytes?: number }` saja) tapi tanpanya pemanggil tidak
   * punya cara memberi tahu `RenderGraph` seberapa besar apron dibutuhkan
   * — `RenderGraph` sendiri buta terhadap tahap spasial mana yang aktif
   * (`Stage` adalah tipe opak, lih. dokumentasi modul di atas);
   * `estimateTileOverlap` (`tiling.ts`) ada justru untuk pemanggil hitung
   * nilai ini dari `SpatialEffectFlags` sebelum memanggil `run()`. Baku ke
   * 0 (tanpa apron) bila tidak diberikan — SALAH untuk render dengan efek
   * spasial aktif, jadi pemanggil yang memaksa tiling WAJIB
   * menyertakannya.
   */
  async run(
    input: Float32Array,
    params: CoreParams,
    collect: TapName,
    options?: {
      maxBufferBytes?: number;
      /** Diagnostic parity tests may deliberately tile an image that already fits. */
      forceTiling?: boolean;
      overlap?: number;
      frame?: FrameParams;
      /**
       * `rgb`: keluaran 3 kanal rapat, dikemas langsung dari memori readback
       * yang di-map -- tanpa salinan RGBA f32 seukuran frame (384 MB pada
       * 24 MP) yang dulu dibuat lalu dibuang. Baku `rgba`.
       */
      output?: 'rgba' | 'rgb';
      /**
       * Opsional: matikan cache inkremental antar-tahap (default aktif untuk full-frame).
       */
      incrementalCache?: boolean;
    },
  ): Promise<Float32Array> {
    const frame = options?.frame ?? DEFAULT_FRAME;
    const output = options?.output ?? 'rgba';
    const maxBufferBytes = options?.maxBufferBytes;
    if (maxBufferBytes !== undefined) {
      const overlap = options?.overlap ?? 0;
      const tiles = planTiles(params.width, params.height, maxBufferBytes, overlap, options?.forceTiling);
      if (tiles.length > 1) {
        return this.runTiled(input, params, collect, tiles, frame, output);
      }
    }
    return this.runSingleBuffer(input, params, collect, false, frame, output, undefined, undefined, options?.incrementalCache);
  }

  /**
   * Task 19: render satu tile per panggilan `runSingleBuffer` (graf/pool
   * yang SAMA, lih. dokumentasi `StageContext.scratch` di atas), menjahit
   * hanya sub-rektangel AKTIF tiap tile (bukan buffernya yang termasuk
   * apron) ke posisi globalnya pada `output`. `planTiles` menjamin
   * sub-rektangel aktif itu menutupi `params.width x params.height` PENUH
   * tanpa celah/tumpang-tindih (`tiling.test.ts`) — perulangan di bawah
   * karena itu boleh menimpa `output` tanpa penjaga tambahan.
   */
  /** Stream only each tile's core; never allocate a float output for the whole photo. */
  async runToTiles(
    input: Float32Array | TileSource, params: CoreParams, collect: TapName,
    draw: (rgb: Float32Array, tile: TileSpec) => void,
    options: { maxBufferBytes: number; memoryBudget: number; overlap: number;
      /** Apron tile ekspor (baku `overlap`); lih. `EXPORT_APRON_SIGMAS`. */
      exportOverlap?: number;
      frame: FrameParams; wholeFrame?: boolean; isCancelled?: () => boolean;
      /** Optional viewport crop; retain the normal tile origins and aprons. */
      region?: { x: number; y: number; width: number; height: number };
      /** Dipanggil sebelum tiap tile (`done` = tile selesai) dan sekali di akhir. */
      onProgress?: (done: number, total: number, tile: TileSpec) => void },
  ): Promise<void> {
    let tiles = options.wholeFrame ? planTiles(params.width, params.height, options.maxBufferBytes, options.overlap)
      : planExportTiles(params.width, params.height, options.maxBufferBytes, options.exportOverlap ?? options.overlap, options.memoryBudget);
    if (options.wholeFrame && tiles.length !== 1) throw new RangeError('This effect requires a whole-frame render.');
    if (options.region) {
      const r = options.region;
      tiles = tiles.filter(t => t.activeOriginX < r.x + r.width && t.activeOriginX + t.activeWidth > r.x &&
        t.activeOriginY < r.y + r.height && t.activeOriginY + t.activeHeight > r.y);
    }
    // Satu buffer input dan satu buffer RGB untuk seluruh tile (dipakai lewat
    // subarray): tanpa ini tiap tile meninggalkan puluhan MB sampah yang di
    // Safari bisa menumpuk sebelum GC berjalan.
    let maxTile = 0;
    let maxActive = 0;
    for (const t of tiles) {
      maxTile = Math.max(maxTile, t.tileWidth * t.tileHeight);
      maxActive = Math.max(maxActive, t.activeWidth * t.activeHeight);
    }
    const source = typeof input === 'function' ? input : undefined;
    const tileInput = tiles.length > 1 || source ? new Float32Array(maxTile * 4) : undefined;
    const tileRgb = new Float32Array(maxActive * 3);
    const device = this.engine.device;
    // Error scope per tile: GPU yang kehabisan memori (buffer gagal dibuat,
    // submit ditolak) dilaporkan sebagai `GpuMemoryError` supaya pemanggil
    // bisa mengecilkan tile dan mencoba lagi, bukan menulis piksel rusak.
    const scoped = typeof device.pushErrorScope === 'function';
    for (const [index, tile] of tiles.entries()) {
      if (options.isCancelled?.()) throw new Error('Tile render cancelled.');
      options.onProgress?.(index, tiles.length, tile);
      const whole = tiles.length === 1 && tile.tileWidth === params.width && tile.tileHeight === params.height;
      const tileParams: CoreParams = whole ? params : {
        ...params, width: tile.tileWidth, height: tile.tileHeight,
        tileOriginX: tile.tileOriginX, tileOriginY: tile.tileOriginY,
        activeOriginX: tile.activeOriginX - tile.tileOriginX,
        activeOriginY: tile.activeOriginY - tile.tileOriginY,
        activeWidth: tile.activeWidth, activeHeight: tile.activeHeight,
      };
      const region = { x: tile.activeOriginX - tile.tileOriginX, y: tile.activeOriginY - tile.tileOriginY,
        width: tile.activeWidth, height: tile.activeHeight };
      const pixels = source ? source(tile, tileInput!) : whole ? input as Float32Array : extractTileInput(input as Float32Array, params.width, tile, tileInput);
      if (scoped) {
        device.pushErrorScope('out-of-memory');
        device.pushErrorScope('internal');
      }
      let rgb: Float32Array | undefined;
      let failure: unknown;
      try {
        rgb = await this.runSingleBuffer(pixels, tileParams, collect, !whole, options.frame, 'rgb', region, tileRgb);
      } catch (error) {
        failure = error;
      }
      if (scoped) {
        const internal = await device.popErrorScope().catch(() => null);
        const oom = await device.popErrorScope().catch(() => null);
        const gpuError = oom ?? internal;
        if (gpuError) throw new GpuMemoryError(gpuError.message, tile.tileWidth * tile.tileHeight);
      }
      if (failure !== undefined) throw failure;
      if (options.isCancelled?.()) throw new Error('Tile render cancelled.');
      draw(rgb!, tile);
      // Allow worker RPC (close, cancel, parameter updates) between GPU submissions.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (tiles.length) options.onProgress?.(tiles.length, tiles.length, tiles[tiles.length - 1]!);
  }

  private async runTiled(
    input: Float32Array,
    params: CoreParams,
    collect: TapName,
    tiles: readonly TileSpec[],
    frame: Readonly<FrameParams>,
    outputChannels: 'rgba' | 'rgb',
  ): Promise<Float32Array> {
    const { width, height } = params;
    const output = new Float32Array(width * height * (outputChannels === 'rgb' ? 3 : 4));

    for (const tile of tiles) {
      const tileInput = extractTileInput(input, width, tile);
      const tileParams: CoreParams = {
        ...params,
        width: tile.tileWidth,
        height: tile.tileHeight,
        tileOriginX: tile.tileOriginX,
        tileOriginY: tile.tileOriginY,
        // TileSpec.activeOriginX/Y ada di ruang koordinat gambar PENUH
        // (lih. dokumentasi `TileSpec`) -- CoreParams.activeOriginX/Y
        // LOKAL ke buffer tile, jadi tileOriginX/Y dikurangkan di sini.
        activeOriginX: tile.activeOriginX - tile.tileOriginX,
        activeOriginY: tile.activeOriginY - tile.tileOriginY,
        activeWidth: tile.activeWidth,
        activeHeight: tile.activeHeight,
      };
      // Task 19b: `shrinkApron=true` -- SATU-satunya pemanggil yang minta
      // `RenderGraph` menyusutkan active rect per-tahap (lih. dokumentasi
      // parameter itu di `runSingleBuffer`). `tileParams.activeOriginX/Y/
      // activeWidth/Height` di atas SUDAH benar sebagai rektangel AKTIF
      // (pusat, TANPA apron) tile ini -- `runSingleBuffer` memakainya
      // sebagai `centerRect` awal yang dibesarkan per-tahap, BUKAN sebagai
      // active rect tetap untuk seluruh tahap (beda dari sebelum Task 19b).
      const tileResult = await this.runSingleBuffer(tileInput, tileParams, collect, true, frame);
      stitchTileOutput(output, width, tileResult, tile, outputChannels === 'rgb' ? 3 : 4);
    }

    return output;
  }

  /**
   * @param shrinkApron Task 19b -- bila benar, `params.activeOriginX/Y/
   *   activeWidth/Height` diperlakukan sebagai `centerRect` (rektangel
   *   AKTIF tile, TANPA apron) yang dibesarkan ULANG sebelum SETIAP tahap
   *   sebesar `remainingSpatialRadius` ("jumlah `Stage.spatialRadiusPx`
   *   tahap ini dan semua tahap SETELAHnya yang akan berjalan" -- port
   *   `setActiveForRemainingRadius`/`consumeSpatialRadius` hulu,
   *   `SpektraVulkanRenderer.cpp:6231-6245` + tujuh call-site
   *   `consumeSpatialRadius` di :6444-6604), bukan dipakai APA ADANYA untuk
   *   seluruh graf seperti sebelumnya. Baku `false` (perilaku pra-Task
   *   19b, dipakai ke-349 gerbang lain yang TIDAK PERNAH lewat
   *   `runTiled` di bawah): setiap tahap memakai `paramsBuffer`/`params`
   *   yang SAMA, ditulis SEKALI di luar loop, persis kode sebelum Task 19b.
   */
  private async runSingleBuffer(
    input: Float32Array,
    params: CoreParams,
    collect: TapName,
    shrinkApron = false,
    frame: Readonly<FrameParams> = DEFAULT_FRAME,
    output: 'rgba' | 'rgb' = 'rgba',
    readRegion?: ActiveRect,
    /** Tujuan RGB yang dipakai ulang (hanya `output: 'rgb'`); hasil = subarray-nya. */
    rgbInto?: Float32Array,
    incrementalCache = true,
  ): Promise<Float32Array> {
    if (this.#disposed) {
      throw new Error(
        'RenderGraph ini sudah di-dispose() -- pool scratch-nya sudah dihancurkan. ' +
          'Memanggil run() lagi akan diam-diam membangun ulang pool dari kosong ' +
          '(kehilangan seluruh reuse antar-tile yang pool itu ada untuk menjaga) ' +
          'sambil tetap menghasilkan piksel yang benar, sehingga tidak akan ' +
          'terlihat sebagai bug sama sekali. Buat RenderGraph baru alih-alih ' +
          'memakai ulang instance yang sudah di-dispose().',
      );
    }

    const expectedFloats = params.width * params.height * 4;
    const expectedBytes = expectedFloats * Float32Array.BYTES_PER_ELEMENT;
    if (input.byteLength !== expectedBytes) {
      throw new Error(
        `Ukuran input tidak cocok dengan params: params.width (${params.width}) x ` +
          `params.height (${params.height}) x 4 komponen x 4 byte = ${expectedBytes} byte ` +
          `diharapkan, tapi input.byteLength adalah ${input.byteLength} byte. Tanpa ` +
          'pemeriksaan ini, ketidakcocokan muncul sebagai peringatan validasi WebGPU ' +
          'asinkron yang terlepas dari panggilan run() yang menyebabkannya.',
      );
    }

    const stopAt = findLastStageIndex(this.stages, collect);
    if (stopAt === -1) {
      const registered =
        this.stages.length === 0
          ? '(tidak ada tahap terdaftar pada graf ini)'
          : this.stages.map((s) => `${s.name}→[${s.writesTaps.join('|')}]`).join(', ');
      throw new Error(
        `Tidak ada tahap yang menulis tap '${collect}'. Tahap terdaftar: ${registered}`,
      );
    }

    const { device } = this.engine;
    const bytes = input.byteLength;
    this.updateAdaptiveBounds(bytes);

    const enableIncremental = !shrinkApron && incrementalCache && !readRegion;

    if (this.lastWidth !== params.width || this.lastHeight !== params.height) {
      this.clearStageCheckpoints();
      this.lastWidth = params.width;
      this.lastHeight = params.height;
    }

    const inputDirty = this.lastInputRef !== input;
    if (inputDirty) {
      this.lastInputRef = input;
    }

    // Evaluasi status dirty per-tahap
    const isDirty: boolean[] = new Array(stopAt + 1);
    const hashes: (string | undefined)[] = new Array(stopAt + 1);

    for (let i = 0; i <= stopAt; i += 1) {
      const stage = this.stages[i]!;
      const hash = enableIncremental ? getStageParamHash(stage, params, frame) : undefined;
      hashes[i] = hash;

      const inputIsDirty = i === 0 ? inputDirty : isDirty[i - 1]!;
      if (hash === undefined) {
        isDirty[i] = true;
      } else {
        const cp = this.stageCheckpoints.get(i);
        const selfIsDirty = !cp || cp.paramHash !== hash;
        isDirty[i] = inputIsDirty || selfIsDirty;
      }
    }

    // Cari tahap terdepan yang bersih dan memiliki checkpoint yang tersimpan
    let resumeFromStage = 0;
    if (enableIncremental) {
      for (let c = stopAt - 1; c >= 0; c -= 1) {
        if (!isDirty[c] && this.stageCheckpoints.has(c)) {
          resumeFromStage = c + 1;
          break;
        }
      }
      // Tahap DIR coupler (OP_RESOLVE) membaca log_e_film dari ctx.dest (back),
      // yang dipertahankan hanya jika tahap develop tepat sebelumnya dieksekusi.
      // Jadi bila graf perlu menjalankan DIR, eksekusi tidak boleh mulai langsung di DIR,
      // melainkan dari tahap develop (dirIndex - 1) atau sebelumnya.
      const dirIndex = this.stages.findIndex((s) => s.name === 'dir');
      if (dirIndex !== -1 && resumeFromStage === dirIndex && dirIndex <= stopAt) {
        resumeFromStage = Math.max(0, dirIndex - 1);
      }
    }

    // Keep the largest preview's frame buffers for the next render. Repeated
    // create/destroy cycles on iOS WebGPU can raise GPU-process memory pressure
    // during film/paper changes; the pool grows only when resolution grows.
    const transient: GPUBuffer[] = [];
    const allocate = (descriptor: GPUBufferDescriptor): GPUBuffer => {
      const buffer = device.createBuffer(descriptor);
      transient.push(buffer);
      return buffer;
    };
    try {
      let front = this.pool.getFrame('ping', bytes);
      let back = this.pool.getFrame('pong', bytes);

      const encoder = device.createCommandEncoder({ label: 'graph' });

      if (resumeFromStage > 0) {
        // Melanjutkan dari checkpoint tahap sebelumnya: lewati tahapan upstream
        const sourceCheckpoint = this.stageCheckpoints.get(resumeFromStage - 1)!;
        encoder.copyBufferToBuffer(sourceCheckpoint.buffer, 0, front, 0, bytes);
      } else {
        // `input.buffer` bertipe `ArrayBufferLike` (bisa `SharedArrayBuffer`) di
        // definisi lib TS terbaru, sementara `writeBuffer` mensyaratkan
        // `ArrayBuffer` non-shared. `input` di sini SELALU `Float32Array` biasa
        // yang pemanggil bangun sendiri (lih. graph.test.ts) — tidak pernah
        // shared — jadi cast ini menyempitkan tipe, bukan mengubah perilaku.
        device.queue.writeBuffer(
          front,
          0,
          input.buffer as ArrayBuffer,
          input.byteOffset,
          input.byteLength,
        );
      }

      const paramsBuffer = allocate({
        label: 'coreParams',
        size: CORE_PARAMS_BYTES,
        usage: gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST,
      });
      const staging = new ArrayBuffer(CORE_PARAMS_BYTES);
      writeCoreParams(params, staging);
      device.queue.writeBuffer(paramsBuffer, 0, staging);

      // Task 19b: `remainingSpatialRadius` -- SATU-SATUNYA state baru loop ini
      // butuh. Dimulai dari jumlah `spatialRadiusPx` SEMUA tahap yang akan
      // benar-benar berjalan (0..stopAt, BUKAN seluruh `this.stages` -- tahap
      // setelah titik `collect` tidak pernah dieksekusi, jadi radiusnya tidak
      // pernah "dikonsumsi" apa pun dan tidak boleh ikut dijumlahkan, persis
      // upstream yang HANYA menjumlahkan `xRadius` efek yang `xPath` true).
      // Tetap 0 (dan karena itu `inflateActiveRect` di bawah selalu no-op,
      // mengembalikan `centerRect` yang SAMA setiap tahap) ketika
      // `!shrinkApron` -- lih. dokumentasi parameter itu.
      let remainingSpatialRadius = 0;
      if (shrinkApron) {
        for (let i = 0; i <= stopAt; i += 1) {
          remainingSpatialRadius += resolveSpatialRadius(this.stages[i]!, params, frame);
        }
      }
      const centerRect: ActiveRect = {
        x: params.activeOriginX,
        y: params.activeOriginY,
        width: params.activeWidth,
        height: params.activeHeight,
      };

      for (let i = resumeFromStage; i <= stopAt; i += 1) {
        const stage = this.stages[i]!;
        let stageParams = params;
        let stageParamsBuffer = paramsBuffer;

        if (shrinkApron) {
          const rect = inflateActiveRect(centerRect, remainingSpatialRadius, params.width, params.height);
          stageParams = {
            ...params,
            activeOriginX: rect.x,
            activeOriginY: rect.y,
            activeWidth: rect.width,
            activeHeight: rect.height,
          };

          const stageParamsStaging = new ArrayBuffer(CORE_PARAMS_BYTES);
          writeCoreParams(stageParams, stageParamsStaging);
          stageParamsBuffer = allocate({
            label: `coreParams:${stage.name}`,
            size: CORE_PARAMS_BYTES,
            usage: gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(stageParamsBuffer, 0, stageParamsStaging);

          // Port `consumeSpatialRadius(xRadius)` hulu -- dipanggil SETELAH
          // tahap ini (yaitu berlaku mulai tahap BERIKUTNYA), persis
          // `SpektraVulkanRenderer.cpp`'s tujuh call-site (:6444-6604), yang
          // semuanya muncul SETELAH dispatch efek terkait, bukan sebelumnya.
          remainingSpatialRadius = Math.max(0, remainingSpatialRadius - resolveSpatialRadius(stage, params, frame));
        }

        const slots = new Map<string, string>();
        stage.encode(encoder, {
          device,
          params: stageParams,
          frame,
          paramsBuffer: stageParamsBuffer,
          source: front,
          dest: back,
          transient: allocate,
          scratch: (label, scratchBytes) => {
            let key = slots.get(label);
            if (key === undefined) { key = `slot${slots.size}`; slots.set(label, key); }
            return this.pool.get(key, scratchBytes);
          },
        });
        // Ping-pong: keadaan yang baru ditulis tahap ini (ke `dest`/`back`)
        // menjadi `source` tahap berikutnya.
        [front, back] = [back, front];

        // Simpan checkpoint untuk tahap yang di-cache, sampai batas memori adaptif
        // (lih. `this.adaptiveMaxBytes`). Tahap yang tidak tercakup tetap benar:
        // cache hanya melewati tahap bila checkpoint-nya ada.
        if (enableIncremental && hashes[i] !== undefined &&
          (this.stageCheckpoints.has(i) ||
            (this.stageCheckpoints.size < this.adaptiveMaxStages &&
              this.checkpointUsage.bytes + bytes <= this.adaptiveMaxBytes))) {
          let cp = this.stageCheckpoints.get(i);
          if (!cp || cp.bytes < bytes) {
            if (cp) cp.buffer.destroy();
            const buffer = device.createBuffer({
              label: `cache:${stage.name}:${i}`,
              size: bytes,
              usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_SRC | gpuBufferUsage.COPY_DST,
            });
            cp = { buffer, paramHash: hashes[i]!, bytes };
            this.stageCheckpoints.set(i, cp);
          } else {
            cp.paramHash = hashes[i]!;
          }
          encoder.copyBufferToBuffer(front, 0, cp.buffer, 0, bytes);
        }
      }

      // Hapus checkpoint downstream setelah stopAt yang sudah basi
      for (let i = stopAt + 1; i < this.stages.length; i += 1) {
        const cp = this.stageCheckpoints.get(i);
        if (cp) {
          cp.buffer.destroy();
          this.stageCheckpoints.delete(i);
        }
      }

      const readPixels = readRegion ? readRegion.width * readRegion.height : params.width * params.height;
      const readback = this.pool.getFrame('readback', readPixels * 16);
      if (readRegion) {
        const rowBytes = readRegion.width * 16;
        for (let row = 0; row < readRegion.height; row++) {
          encoder.copyBufferToBuffer(front, ((readRegion.y + row) * params.width + readRegion.x) * 16,
            readback, row * rowBytes, rowBytes);
        }
      } else encoder.copyBufferToBuffer(front, 0, readback, 0, bytes);
      device.queue.submit([encoder.finish()]);

      await readback.mapAsync(gpuMapMode.READ);
      const mapped = new Float32Array(readback.getMappedRange());
      const result = output === 'rgb' ? packRgb(mapped, readPixels, rgbInto) : mapped.slice(0, readPixels * 4);
      readback.unmap();

      return result;
    } catch (error) {
      // Failed allocations/readbacks must not pin a partial frame in the
      // reusable pool. Successful frames retain their normal reuse path.
      this.clearStageCheckpoints();
      this.pool.release();
      this.releaseFrameResources();
      throw error;
    } finally {
      for (const buffer of transient) buffer.destroy();
      this.pool.flushRetired();
    }

  }

  /**
   * Menghancurkan seluruh buffer pada pool scratch dan cache tahap.
   */
  releaseFrameResources(): void {
    this.clearStageCheckpoints();
    for (const stage of this.stages) stage.releaseFrameResources?.();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clearStageCheckpoints();
    for (const stage of this.stages) stage.dispose?.();
    // Pool bersama milik pemanggil (`Session`), yang melepasnya sendiri.
    if (this.ownsPool) this.pool.release();
    this.#disposed = true;
  }
}

/** RGBA -> RGB rapat (kanal alfa dibuang). */
export function packRgb(rgba: Float32Array, pixels: number, into?: Float32Array): Float32Array {
  const rgb = into ? into.subarray(0, pixels * 3) : new Float32Array(pixels * 3);
  for (let p = 0; p < pixels; p += 1) {
    rgb[p * 3] = rgba[p * 4]!;
    rgb[p * 3 + 1] = rgba[p * 4 + 1]!;
    rgb[p * 3 + 2] = rgba[p * 4 + 2]!;
  }
  return rgb;
}
