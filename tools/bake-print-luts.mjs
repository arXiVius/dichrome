/**
 * Panggang LUT cetak `.cube` (sumber di `assets/luts/`) menjadi biner
 * `public/luts/<nama>.f32`: RGB float32 little-endian berurutan, tanpa alpha
 * (alpha = 1 disintesis pemuat). Nilai identik dengan `parsePrintCube` teks
 * (f32-LE sama dengan pembulatan `Float32Array.from` parser) -- bit-exactness
 * dijaga `test/printLut.test.ts` terhadap parser teks asli.
 *
 * Hasil: ~1,0 MB per LUT 33³ menjadi 423 KB (unduh + parse; teks .cube tidak
 * terkompresi dan mahal diparse). Sumber TIDAK lagi ikut precache PWA.
 *
 * Pakai: node tools/bake-print-luts.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const srcDir = join(root, 'assets', 'luts');
const outDir = join(root, 'public', 'luts');
mkdirSync(outDir, { recursive: true });

/** Ukuran yang diharapkan, sama dengan `PRINT_LUTS` (src/profiles/printLuts.ts). */
const EXPECTED = {
  'kodak-2383-d55': 33, 'kodak-2383-d60': 33, 'kodak-2383-d65': 33,
  'kodak-2393-d65': 13, 'fuji-3513-d55': 33, 'fuji-3513-d60': 33, 'fuji-3513-d65': 33,
};

/**
 * Salinan persis dari parser ketat di `src/profiles/printLuts.ts`
 * (`parsePrintCube`): domain 0-1 Cineon, urutan merah-cepat. Mengembalikan
 * RGB saja (tanpa alpha); parity test membuktikan kecocokannya dengan parser
 * teks yang dipakai aplikasi.
 */
function parseCubeRgb(text, expectedSize) {
  let size = 0;
  const data = [];
  for (const source of text.split(/\r?\n/)) {
    const line = source.split('#')[0].trim();
    if (!line || line.startsWith('TITLE')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') { size = Number(parts[1]); continue; }
    if (parts[0] === 'LUT_3D_INPUT_RANGE') {
      if (parts.length !== 3 || Number(parts[1]) !== 0 || Number(parts[2]) !== 1) throw new Error('Print LUT requires a 0-1 Cineon domain.');
      continue;
    }
    if (parts[0] === 'DOMAIN_MIN' || parts[0] === 'DOMAIN_MAX') {
      const expected = parts[0] === 'DOMAIN_MIN' ? 0 : 1;
      if (parts.length !== 4 || parts.slice(1).some((v) => Number(v) !== expected)) throw new Error('Print LUT requires a 0-1 Cineon domain.');
      continue;
    }
    if (parts.length !== 3 || parts.some((v) => !Number.isFinite(Number(v)))) throw new Error('Invalid print LUT sample.');
    data.push(...parts.map(Number));
  }
  if (size !== expectedSize || data.length !== size ** 3 * 3) throw new Error('Print LUT dimensions do not match its samples.');
  return { size, rgb: Float32Array.from(data) };
}

let total = 0;
for (const [id, expectedSize] of Object.entries(EXPECTED)) {
  const text = readFileSync(join(srcDir, `${id}.cube`), 'utf8');
  const { size, rgb } = parseCubeRgb(text, expectedSize);
  // f32 little-endian eksplisit (DataView): jelas soal endianness, dan bit
  // yang sama dengan `Float32Array.from` parser teks di semua host LE.
  const out = new Uint8Array(rgb.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < rgb.length; i++) view.setFloat32(i * 4, rgb[i], true);
  writeFileSync(join(outDir, `${id}.f32`), out);
  total += out.length;
  console.log(`${id}.f32  ${size}^3  ${out.length} bytes`);
}
console.log(`total ${total} bytes (sum .cube asli: 6.173.235 bytes)`);
