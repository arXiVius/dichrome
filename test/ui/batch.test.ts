import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import { longEdgeDetents } from '../../src/ui/model/exportSizes';
import {
  BATCH_STORAGE_KEY, DEFAULT_BATCH_PREFS, batchItems, loadBatchPrefs, saveBatchPrefs,
  selectDetent, uniqueEntryName, zipFileName, zipFiles,
} from '../../src/ui/model/batch';
import type { ProjectCard } from '../../src/ui/projects/projects';

const card = (id: string, name: string, missing = false): ProjectCard => ({
  id, name, fileName: `${name}.jpg`, updatedAt: 1,
  params: BASELINE_RENDER_PARAMS, width: 4000, height: 3000, missing,
});

describe('ekspor batch', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps every project, marking missing originals', () => {
    expect(batchItems([card('a', 'One'), card('b', 'Two', true)])).toEqual([
      { id: 'a', name: 'One', fileName: 'One.jpg', missing: false },
      { id: 'b', name: 'Two', fileName: 'Two.jpg', missing: true },
    ]);
  });

  it('picks an exact detent, the largest smaller one, or the source', () => {
    const detents = longEdgeDetents(6000, 4000);
    expect(selectDetent(detents, 2048).label).toBe('2048');
    expect(selectDetent(detents, 4096).label).toBe('4096');
    // 3000 tidak ditawarkan: detent terbesar yang lebih kecil, bukan 4096.
    expect(selectDetent(detents, 3000).label).toBe('2048');
    // Lebih besar dari sumber: tidak pernah memperbesar.
    expect(selectDetent(detents, 20000).label).toBe('Source · 6000');
    expect(selectDetent(detents, null).label).toBe('Source · 6000');
  });

  it('never upscales a photo smaller than the requested long edge', () => {
    const detents = longEdgeDetents(1200, 800);
    expect(selectDetent(detents, 2048).label).toBe('Source · 1200');
  });

  it('dedupes ZIP entry names without touching the extension', () => {
    const used = new Set<string>();
    expect(uniqueEntryName('a - Portra 400.jpg', used)).toBe('a - Portra 400.jpg');
    expect(uniqueEntryName('a - Portra 400.jpg', used)).toBe('a - Portra 400 (2).jpg');
    expect(uniqueEntryName('a - Portra 400.jpg', used)).toBe('a - Portra 400 (3).jpg');
    expect(uniqueEntryName('a - Portra 400.tif', used)).toBe('a - Portra 400.tif');
  });

  it('packs files into one ZIP with their names and bytes intact', async () => {
    const blob = zipFiles([
      { name: 'one.jpg', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'two.png', bytes: new Uint8Array([9, 8]) },
    ]);
    expect(blob.type).toBe('application/zip');
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(['one.jpg', 'two.png']);
    expect(Array.from(entries['one.jpg']!)).toEqual([1, 2, 3]);
    expect(Array.from(entries['two.png']!)).toEqual([9, 8]);
  });

  it('names the archive in ASCII with a local timestamp', () => {
    expect(zipFileName(new Date(2026, 9, 26, 14, 30))).toBe('gamma-exports-2026-10-26-1430.zip');
  });

  it('falls back to defaults when stored preferences are absent or broken', () => {
    expect(loadBatchPrefs()).toEqual(DEFAULT_BATCH_PREFS);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
    });
    store.set(BATCH_STORAGE_KEY, '{ not json');
    expect(loadBatchPrefs()).toEqual(DEFAULT_BATCH_PREFS);
    store.set(BATCH_STORAGE_KEY, JSON.stringify({ format: 'nope', quality: 500, longEdge: 'x' }));
    // Kualitas di luar rentang dijepit; format dan sisi panjang kembali ke bawaan.
    expect(loadBatchPrefs()).toEqual({ ...DEFAULT_BATCH_PREFS, quality: 100 });
    saveBatchPrefs({ format: 'png16', quality: 40, longEdge: null });
    expect(loadBatchPrefs()).toEqual({ format: 'png16', quality: 40, longEdge: null });
  });
});
