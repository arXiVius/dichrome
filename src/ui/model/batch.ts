/**
 * Ekspor batch: bagian murni (tanpa engine/DOM) -- daftar proyek, pemilihan
 * sisi panjang per foto, penamaan entri ZIP, kontainer ZIP, dan preferensi
 * tersimpan. `ui/batch.ts` yang menjalankan render; modul ini bisa diuji
 * tanpa WebGPU.
 */
import { Zip, ZipPassThrough } from 'fflate';
import type { ExportFormat } from '../../session/session';
import type { ProjectCard } from '../projects/projects';
import type { LongEdgeDetent } from './exportSizes';
import { FORMAT_INFO } from './exportFormats';

export interface BatchItem {
  id: string;
  name: string;
  fileName: string;
  /** Berkas asli tidak lagi tersimpan di perangkat: dilewati. */
  missing: boolean;
}

/** Proyek yang ikut batch, urutan daftar dipertahankan (terbaru dulu). */
export function batchItems(cards: readonly ProjectCard[]): BatchItem[] {
  return cards.map(({ id, name, fileName, missing }) => ({ id, name, fileName, missing }));
}

/**
 * Detent untuk satu foto. `null` = ukuran sumber; nilai lain = batas sisi
 * panjang yang diminta. Tidak pernah memperbesar: bila batas lebih besar dari
 * sumber, sumber yang dipakai.
 */
export function selectDetent(detents: readonly LongEdgeDetent[], wanted: number | null): LongEdgeDetent {
  const source = detents[detents.length - 1]!;
  // Batas yang lebih besar dari sumber berarti "sumber": jangan turun ke
  // detent tetap terbesar hanya karena angkanya lebih kecil dari batas.
  if (wanted === null || wanted >= Math.max(source.width, source.height)) return source;
  const exact = detents.find((d) => d.longEdge === wanted);
  if (exact) return exact;
  const smaller = detents.filter((d) => d.longEdge !== null && d.longEdge <= wanted);
  return smaller.length > 0 ? smaller[smaller.length - 1]! : source;
}

/** `photo.jpg` -> `photo (2).jpg` bila nama itu sudah dipakai di ZIP. */
export function uniqueEntryName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** Label cap waktu ASCII (Chromium membuang nama unduhan non-ASCII). */
export function zipFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `gamma-exports-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

export interface BatchFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * ZIP aliran: tiap berkas dimasukkan apa adanya (PNG/JPEG sudah terkompresi),
 * potongan ditampung lalu disatukan sebagai Blob tanpa salinan kedua dari
 * seluruh arsip. Entri sebagian tetap sah bila batch dibatalkan di tengah,
 * karena ZIP ditulis setelah render, bukan selama render.
 */
export function zipFiles(files: readonly BatchFile[]): Blob {
  // `fflate` mengetik potongan sebagai `Uint8Array<ArrayBufferLike>`; Blob
  // hanya menerima buffer non-shared. Potongan berasal dari alokasi biasa.
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk as Uint8Array<ArrayBuffer>);
  });
  for (const file of files) {
    const entry = new ZipPassThrough(file.name);
    zip.add(entry);
    entry.push(file.bytes, true);
  }
  zip.end();
  return new Blob(chunks, { type: 'application/zip' });
}

// ---------------------------------------------------------------------------
// Preferensi batch

export interface BatchPrefs {
  format: ExportFormat;
  /** 1..100, hanya format lossy. */
  quality: number;
  /** `null` = ukuran sumber tiap foto. */
  longEdge: number | null;
}

export const BATCH_STORAGE_KEY = 'dichroic.batch.v1';

/** JPEG 2048 adalah pertukaran yang aman untuk puluhan foto sekaligus. */
export const DEFAULT_BATCH_PREFS: BatchPrefs = { format: 'jpeg', quality: 92, longEdge: 2048 };

function clampQuality(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_BATCH_PREFS.quality;
  return Math.min(100, Math.max(1, n));
}

export function loadBatchPrefs(): BatchPrefs {
  try {
    const raw = localStorage.getItem(BATCH_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BatchPrefs>;
      const format = typeof parsed.format === 'string' && parsed.format in FORMAT_INFO
        ? parsed.format as ExportFormat : DEFAULT_BATCH_PREFS.format;
      const longEdge = parsed.longEdge === null ? null
        : typeof parsed.longEdge === 'number' && Number.isFinite(parsed.longEdge) ? parsed.longEdge
          : DEFAULT_BATCH_PREFS.longEdge;
      return { format, quality: clampQuality(parsed.quality), longEdge };
    }
  } catch {
    // Preferensi rusak/diblokir: bawaan berlaku untuk sesi ini.
  }
  return { ...DEFAULT_BATCH_PREFS };
}

export function saveBatchPrefs(prefs: BatchPrefs): void {
  try {
    localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Penyimpanan diblokir: preferensi hanya berlaku untuk sesi ini.
  }
}
