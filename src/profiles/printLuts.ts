/** Asset registry only; the implementation is independent of EMULSION code. */
export const PRINT_LUTS = {
  lut_kodak_2383_d55: { file: 'kodak-2383-d55', name: 'Kodak 2383 D55', size: 33 },
  lut_kodak_2383_d60: { file: 'kodak-2383-d60', name: 'Kodak 2383 D60', size: 33 },
  lut_kodak_2383_d65: { file: 'kodak-2383-d65', name: 'Kodak 2383 D65', size: 33 },
  lut_kodak_2393_d65: { file: 'kodak-2393-d65', name: 'Kodak 2393 D65', size: 13 },
  lut_fuji_3513_d55: { file: 'fuji-3513-d55', name: 'Fujifilm 3513DI D55', size: 33 },
  lut_fuji_3513_d60: { file: 'fuji-3513-d60', name: 'Fujifilm 3513DI D60', size: 33 },
  lut_fuji_3513_d65: { file: 'fuji-3513-d65', name: 'Fujifilm 3513DI D65', size: 33 },
} as const;
export type PrintLutId = keyof typeof PRINT_LUTS;
export const isPrintLut = (id: string): id is PrintLutId => Object.prototype.hasOwnProperty.call(PRINT_LUTS, id);
export interface PrintCube { size: number; rgba: Float32Array }

/** Strict red-fastest .cube parsing, preserving the original measurements. */
export function parsePrintCube(text: string, expectedSize: number): PrintCube {
  let size = 0;
  const data: number[] = [];
  for (const source of text.split(/\r?\n/)) {
    const line = source.split('#')[0]!.trim();
    if (!line || line.startsWith('TITLE')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') { size = Number(parts[1]); continue; }
    if (parts[0] === 'LUT_3D_INPUT_RANGE') {
      if (parts.length !== 3 || Number(parts[1]) !== 0 || Number(parts[2]) !== 1) throw new Error('Print LUT requires a 0–1 Cineon domain.');
      continue;
    }
    if (parts[0] === 'DOMAIN_MIN' || parts[0] === 'DOMAIN_MAX') {
      const expected = parts[0] === 'DOMAIN_MIN' ? 0 : 1;
      if (parts.length !== 4 || parts.slice(1).some(v => Number(v) !== expected)) throw new Error('Print LUT requires a 0–1 Cineon domain.');
      continue;
    }
    if (parts.length !== 3 || parts.some(v => !Number.isFinite(Number(v)))) throw new Error('Invalid print LUT sample.');
    data.push(...parts.map(Number), 1);
  }
  if (size !== expectedSize || data.length !== size ** 3 * 4) throw new Error('Print LUT dimensions do not match its samples.');
  return { size, rgba: Float32Array.from(data) };
}

/**
 * RGBA dari hasil biner (RGB f32 little-endian, tanpa alpha). Alpha = 1
 * persis seperti parser teks di atas, jadi `samplePrintCube`/GPU melihat
 * Larik identik bit per bit -- dijaga parity test terhadap berkas .cube
 * sumber (assets/luts).
 */
function cubeFromRgbBytes(bytes: ArrayBuffer, size: number): PrintCube {
  const n = size ** 3;
  if (bytes.byteLength !== n * 3 * 4) throw new Error('Print LUT dimensions do not match its samples.');
  const rgb = new Float32Array(bytes);
  const rgba = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = rgb[i * 3]!;
    rgba[i * 4 + 1] = rgb[i * 3 + 1]!;
    rgba[i * 4 + 2] = rgb[i * 3 + 2]!;
    rgba[i * 4 + 3] = 1;
  }
  return { size, rgba };
}

const cache = new Map<string, Promise<PrintCube>>();
/**
 * Lazy, shared CPU asset cache. A failed fetch can be retried on the next render.
 * Berkas = hasil panggungan `tools/bake-print-luts.mjs` (f32-LE), bukan lagi
 * `.cube` teks: unduhan ~2,4x lebih kecil dan tanpa parse teks 36 ribu baris.
 */
export function loadPrintCube(id: PrintLutId, assetsBaseUrl: string): Promise<PrintCube> {
  const path = `${assetsBaseUrl.replace(/\/?data\/?$/, '')}/luts/${PRINT_LUTS[id].file}.f32`;
  const existing = cache.get(path);
  if (existing) return existing;
  const pending = (async () => {
    let bytes: ArrayBuffer;
    if (typeof process !== 'undefined' && process.versions?.node && !/^https?:/i.test(path)) {
      const fs = await import('node:fs/promises');
      // Salinan sekali: Buffer boleh berbagi pool; larik hasil tidak boleh.
      const buf = await fs.readFile(path);
      bytes = new Uint8Array(buf).buffer;
    } else {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Could not load ${PRINT_LUTS[id].name}: HTTP ${response.status}`);
      bytes = await response.arrayBuffer();
    }
    return cubeFromRgbBytes(bytes, PRINT_LUTS[id].size);
  })();
  cache.set(path, pending);
  void pending.catch(() => { if (cache.get(path) === pending) cache.delete(path); });
  return pending;
}

/** Standard Cineon 95/685/300 transform (Colour Science / Kodak convention). */
export function encodeCineon(linear: number): number {
  const black = 10 ** ((95 - 685) / 300);
  return Math.min(1, Math.max(0, (685 + 300 * Math.log10(Math.max(linear, 0) * (1 - black) + black)) / 1023));
}
export function decodeCineon(code: number): number {
  const black = 10 ** ((95 - 685) / 300);
  return (10 ** ((code * 1023 - 685) / 300) - black) / (1 - black);
}

/** Tetrahedral reference, including all six tetrahedra and clamped endpoints. */
export function samplePrintCube(cube: PrintCube, rgb: readonly number[]): number[] {
  const p = rgb.map(v => Math.min(1, Math.max(0, v)) * (cube.size - 1));
  const base = p.map(v => Math.min(cube.size - 2, Math.floor(v)));
  const f = p.map((v, i) => v - base[i]!);
  const order = [0, 1, 2].sort((a, b) => f[b]! - f[a]!);
  const v1 = [...base]; v1[order[0]!]!++;
  const v2 = [...v1]; v2[order[1]!]!++;
  const points = [base, v1, v2, base.map(v => v + 1)];
  const weights = [1 - f[order[0]!]!, f[order[0]!]! - f[order[1]!]!, f[order[1]!]! - f[order[2]!]!, f[order[2]!]!];
  return [0, 1, 2].map(c => points.reduce((sum, point, i) => sum + weights[i]! * cube.rgba[(point[0]! + cube.size * (point[1]! + cube.size * point[2]!)) * 4 + c]!, 0));
}
