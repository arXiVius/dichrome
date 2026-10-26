import { describe, it, expect } from 'vitest';
import { exportSizeLimits, longEdgeDetents } from '../../src/ui/model/exportSizes';
import { asciiName, exportFileName, formatBytes } from '../../src/ui/share';
import { rgbToRgba8, clampQuality } from '../../src/io/canvasEncode';
import { quantize } from '../../src/io/encode';
import type { RgbPixels } from '../../src/io/encode';

describe('detent sisi panjang ekspor', () => {
  it('hanya detent yang memperkecil, lalu Source', () => {
    expect(longEdgeDetents(6000, 4000).map((d) => [d.label, d.width, d.height, d.request])).toEqual([
      ['2048', 2048, 1365, 2048],
      ['4096', 4096, 2731, 4096],
      ['Source · 6000', 6000, 4000, undefined],
    ]);
    expect(longEdgeDetents(1200, 800).map((d) => d.label)).toEqual(['Source · 1200']);
    // Potret: sisi panjang = tinggi.
    expect(longEdgeDetents(3000, 4500)[0]).toMatchObject({ width: 1365, height: 2048 });
  });

  it('batas kanvas iOS (16,7 MP) memberi "Max" untuk format lossy', () => {
    const detents = longEdgeDetents(8064, 6048, { area: 16_777_216, side: 16_384 });
    const last = detents[detents.length - 1]!;
    expect(last.label).toBe('Max · 4729');
    expect(last.request).toBe(4729);
    expect(last.width * last.height).toBeLessThanOrEqual(16_777_216);
    expect(detents.map((d) => d.longEdge)).toEqual([2048, 4096, null]);
  });

  it('tanpa batas 4096 px: PNG/TIFF/JPEG = Source, hanya WebP/AVIF dibatasi kanvas', () => {
    expect(exportSizeLimits(false)).toBeUndefined();
    const full = longEdgeDetents(8064, 6048, exportSizeLimits(false));
    expect(full.at(-1)).toMatchObject({ label: 'Source · 8064', width: 8064, height: 6048, request: undefined });
    expect(full.map((d) => d.label)).toEqual(['2048', '4096', 'Source · 8064']);
    expect(exportSizeLimits(true)).toBeDefined();
  });
});

describe('nama berkas ekspor', () => {
  it('ASCII polos (Chromium membuang nama download non-ASCII)', () => {
    expect(asciiName('Café — night')).toBe('Cafe - night');
    expect(exportFileName('IMG_0012.HEIC', 'Kodak Portra 400', 'Kodak Endura Premier', 'jpg')).toBe(
      'IMG_0012 - Kodak Portra 400 on Kodak Endura Premier.jpg',
    );
    expect(exportFileName(undefined, 'Fujifilm Provia 100F', undefined, 'png')).toBe('photo - Fujifilm Provia 100F scan.png');
  });

  it('ukuran berkas', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});

describe('encoder kanvas', () => {
  it('RGB f32 -> RGBA 8-bit: clamp, bulatkan, alfa penuh', () => {
    expect([...rgbToRgba8(Float32Array.of(0, 0.5, 1, -0.2, 1.4, 0.2), 2, 1)]).toEqual([0, 128, 255, 255, 0, 255, 51, 255]);
    expect(clampQuality(0)).toBe(0.01);
    expect(clampQuality(1.5)).toBe(1);
    expect(clampQuality(Number.NaN)).toBe(1);
  });

  it('identik byte demi byte dengan quantize 8-bit untuk setiap tipe masukan', () => {
    // Referensi: implementasi lama (quantize lalu salin ke RGBA).
    const reference = (rgb: RgbPixels, n: number): number[] => {
      const q = quantize(rgb.subarray(0, n * 3), 8);
      const out: number[] = [];
      for (let i = 0, j = 0; i < n; i += 1, j += 3) out.push(q[j]!, q[j + 1]!, q[j + 2]!, 255);
      return out;
    };
    const n = 60_000;
    let seed = 0x9e3779b9;
    const next = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    const values = new Float32Array(n * 3);
    const special = [0, -0, 1, 1.5, -1, -0.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (let i = 0; i < n * 3; i += 1) {
      // Sepertiga nilai acak, sepertiga tepat di sekitar batas .5 LSB, sisanya khusus.
      const kind = i % 3;
      if (kind === 0) values[i] = next();
      else if (kind === 1) values[i] = (Math.floor(next() * 256) + 0.5) / 255 + (next() - 0.5) * 1e-15;
      else values[i] = special[(i / 3) % special.length]!;
    }
    expect([...rgbToRgba8(values, n, 1)]).toEqual(reference(values, n));

    const bytes = new Uint8Array(n * 3);
    const words = new Uint16Array(n * 3);
    for (let i = 0; i < n * 3; i += 1) { bytes[i] = Math.floor(next() * 256); words[i] = Math.floor(next() * 65_536); }
    expect([...rgbToRgba8(bytes, n, 1)]).toEqual(reference(bytes, n));
    expect([...rgbToRgba8(words, n, 1)]).toEqual(reference(words, n));
  });
});
