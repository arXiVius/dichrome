/**
 * Ekspor batch: satu foto pada satu waktu lewat `engine` dan `Session` yang
 * sama dengan editor -- tiap proyek dibuka dengan resep, crop, dan
 * penghapusan objeknya sendiri, dirender pada ukuran ekspor, lalu ditutup.
 * Foto dikumpulkan sebagai ZIP supaya pengguna hanya menerima satu berkas
 * (unduhan ganda diblokir browser; lembar Bagikan iOS pun lebih masuk akal
 * untuk satu arsip).
 *
 * Bebas React seperti `projects`: state diamati lewat `subscribe`/`getState`.
 * Tidak pernah mengubah daftar proyek: `currentId` tetap kosong selama batch
 * (autosave tidak menulis resep batch ke proyek lain) dan `updatedAt` tidak
 * disentuh. Proyek yang sedang terbuka saat batch dimulai dibuka lagi di
 * akhir.
 */
import type { ExportFormat } from '../session/session';
import type { RenderParams } from '../params/renderParams';
import { exportTarget } from '../session/exportTarget';
import { engine as engineBridge } from './engine/engine';
import type { OpenRestore, SavedRemoval } from './engine/engine';
import { projects as projectBridge } from './projects/projects';
import type { ProjectsState } from './projects/projects';
import type { Crop } from '../io/geometry';
import { isScanMode } from './model/tools';
import { stockInfo } from './model/stocks';
import { exportSizeLimits, longEdgeDetents } from './model/exportSizes';
import { EXPORT_EXT } from './model/exportFormats';
import { batchItems, loadBatchPrefs, saveBatchPrefs, selectDetent, uniqueEntryName, zipFileName, zipFiles } from './model/batch';
import type { BatchFile, BatchItem } from './model/batch';
import { exportFileName } from './share';

export type BatchPhase = 'setup' | 'running' | 'done';

export type BatchStatus = 'pending' | 'opening' | 'developing' | 'encoding' | 'done' | 'skipped' | 'failed';

export interface BatchItemState extends BatchItem {
  status: BatchStatus;
  /** Ukuran berkas hasil (hanya `done`). */
  bytes?: number;
  /** Kemajuan render, mis. "tile 2/3". */
  detail?: string;
  error?: string;
}

export interface BatchState {
  open: boolean;
  phase: BatchPhase;
  /** Format yang benar-benar bisa di-encode browser ini (hasil probing). */
  formats: ExportFormat[];
  format: ExportFormat;
  quality: number;
  longEdge: number | null;
  items: BatchItemState[];
  zip?: { blob: Blob; name: string; bytes: number };
  message?: string;
  cancelled: boolean;
}

const TERMINAL: readonly BatchStatus[] = ['done', 'skipped', 'failed'];

/** Selesai dari jumlah yang benar-benar diekspor (proyek tanpa asli tidak dihitung). */
export function batchCompleted(state: BatchState): number {
  return state.items.filter((item) => !item.missing && TERMINAL.includes(item.status)).length;
}

/** Bagian `engine` yang dipakai batch (diganti tiruan di test). */
export interface BatchEngine {
  openFile(file: File, restore: OpenRestore): Promise<boolean>;
  readonly imageSize: { width: number; height: number } | undefined;
  renderExport(
    longEdge: number | undefined,
    requested: { width: number; height: number },
    options: { target?: ReturnType<typeof exportTarget>; onProgress?: (progress: { done: number; total: number }) => void },
  ): Promise<{ width: number; height: number }>;
  exportImage(format: ExportFormat, options?: { longEdge?: number; quality?: number }): Promise<File>;
  releaseExport(): void;
  closePhoto(): void;
  dismissError(): void;
}

/** Sumber satu proyek untuk batch. */
export interface BatchSource {
  file: File;
  params: RenderParams;
  crop?: Crop;
  removals: SavedRemoval[];
}

/** Bagian `projects` yang dipakai batch (diganti tiruan di test). */
export interface BatchProjects {
  getState(): ProjectsState;
  close(): Promise<void>;
  open(id: string): Promise<boolean>;
  source(id: string): Promise<BatchSource | undefined>;
}

export class Batch {
  constructor(
    private readonly engine: BatchEngine = engineBridge,
    private readonly projects: BatchProjects = projectBridge,
  ) {}

  #state: BatchState = {
    open: false,
    phase: 'setup',
    formats: [],
    ...loadBatchPrefs(),
    items: [],
    cancelled: false,
  };
  readonly #listeners = new Set<() => void>();
  #running = false;
  #cancelled = false;

  getState = (): BatchState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  #set(patch: Partial<BatchState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit();
  }

  /** Buka layar Export All dengan daftar proyek saat ini. */
  open(): void {
    if (this.#running) return;
    const prefs = loadBatchPrefs();
    this.#cancelled = false;
    this.#set({
      open: true,
      phase: 'setup',
      format: prefs.format,
      quality: prefs.quality,
      longEdge: prefs.longEdge,
      items: batchItems(this.projects.getState().list).map((item) => ({
        ...item,
        status: item.missing ? 'skipped' : 'pending',
      })),
      zip: undefined,
      message: undefined,
      cancelled: false,
    });
  }

  close(): void {
    if (this.#running) return;
    this.#set({ open: false });
  }

  /** Format hasil probing; pilihan tersimpan diganti bila tak didukung. */
  setFormats(formats: readonly ExportFormat[]): void {
    if (this.#running || formats.length === 0) return;
    const available = this.#state.formats.length === formats.length
      && formats.every((format, i) => format === this.#state.formats[i]);
    if (available) return;
    const format = formats.includes(this.#state.format) ? this.#state.format
      : formats.includes('jpeg') ? 'jpeg' : formats[0]!;
    this.#set({ formats: [...formats], ...(format === this.#state.format ? {} : { format }) });
  }

  setFormat(format: ExportFormat): void {
    if (this.#running) return;
    this.#set({ format });
    saveBatchPrefs({ format, quality: this.#state.quality, longEdge: this.#state.longEdge });
  }

  setQuality(quality: number): void {
    if (this.#running) return;
    const value = Math.min(100, Math.max(1, Math.round(quality)));
    this.#set({ quality: value });
    saveBatchPrefs({ format: this.#state.format, quality: value, longEdge: this.#state.longEdge });
  }

  setLongEdge(longEdge: number | null): void {
    if (this.#running) return;
    this.#set({ longEdge });
    saveBatchPrefs({ format: this.#state.format, quality: this.#state.quality, longEdge });
  }

  /** Minta berhenti setelah foto yang sedang dirender selesai. */
  cancel(): void {
    if (!this.#running) return;
    this.#cancelled = true;
    this.#set({ cancelled: true, message: 'Finishing this photo…' });
  }

  /**
   * Jalankan batch. Format dan ukuran dibaca sekali di awal sehingga kontrol
   * yang berubah di tengah tidak membuat batch berpindah format.
   */
  async run(): Promise<void> {
    if (this.#running) return;
    const queue = this.#state.items.filter((item) => !item.missing);
    if (queue.length === 0) {
      this.#set({ phase: 'done', message: 'No photos with a saved original to export.' });
      return;
    }
    const format = this.#state.format;
    const quality = this.#state.quality;
    const requestedEdge = this.#state.longEdge;
    const lossy = format === 'jpeg' || format === 'webp' || format === 'avif';
    this.#running = true;
    this.#cancelled = false;
    this.#set({
      phase: 'running',
      cancelled: false,
      message: undefined,
      zip: undefined,
      items: this.#state.items.map((item) => ({
        ...item,
        status: item.missing ? 'skipped' : 'pending',
        bytes: undefined,
        detail: undefined,
        error: undefined,
      })),
    });

    const previous = this.projects.getState().currentId;
    if (previous) await this.projects.close().catch(() => {});

    const files: BatchFile[] = [];
    const used = new Set<string>();
    try {
      for (const item of queue) {
        if (this.#cancelled) break;
        const card = this.#state.items.find((i) => i.id === item.id);
        if (!card) continue;
        try {
          this.#patch(item.id, { status: 'opening' });
          const source = await this.projects.source(item.id);
          if (!source) {
            this.#patch(item.id, { status: 'skipped', detail: 'No saved original' });
            continue;
          }
          const opened = await this.engine.openFile(source.file, {
            params: source.params,
            removals: source.removals,
            crop: source.crop,
          });
          if (!opened) throw new Error('The photo could not be opened.');
          const size = this.engine.imageSize;
          if (!size) throw new Error('The photo has no size.');

          this.#patch(item.id, { status: 'developing' });
          const detents = longEdgeDetents(size.width, size.height, exportSizeLimits(format === 'webp' || format === 'avif'));
          const selected = selectDetent(detents, requestedEdge);
          const target = exportTarget(format, source.params.outputColorSpace);
          await this.engine.renderExport(selected.request, selected, {
            target,
            onProgress: (progress) => this.#patch(item.id, {
              detail: progress.total > 1 ? `tile ${Math.min(progress.done + 1, progress.total)}/${progress.total}` : undefined,
            }),
          });

          this.#patch(item.id, { status: 'encoding', detail: undefined });
          const file = await this.engine.exportImage(format, {
            longEdge: selected.request,
            ...(lossy ? { quality: quality / 100 } : {}),
          });
          const bytes = new Uint8Array(await file.arrayBuffer());
          const name = uniqueEntryName(this.#entryName(card, source.params, format), used);
          files.push({ name, bytes });
          this.#patch(item.id, { status: 'done', bytes: bytes.byteLength });
        } catch (error) {
          // Galat buka/render satu foto tidak menghentikan batch; galatnya
          // disimpan per baris dan Alert engine ditutup supaya tidak muncul
          // setelah layar batch selesai.
          const message = error instanceof Error ? error.message : String(error);
          this.#patch(item.id, { status: 'failed', error: message });
          this.engine.dismissError();
          this.engine.closePhoto();
        } finally {
          this.engine.releaseExport();
        }
      }
    } finally {
      this.engine.closePhoto();
      this.#running = false;
      if (previous) void this.projects.open(previous).catch(() => {});
    }

    this.#set({ cancelled: this.#cancelled });
    if (files.length === 0) {
      this.#set({ phase: 'done', message: this.#cancelled ? 'Cancelled before the first photo finished.' : 'Nothing could be exported.' });
      return;
    }
    this.#set({ message: 'Packing the ZIP…' });
    // Beri kesempatan layar menggambar status "Packing" sebelum kerja sinkron.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      const blob = zipFiles(files);
      this.#set({
        phase: 'done',
        message: this.#cancelled ? 'Cancelled after the photos already finished.' : undefined,
        zip: { blob, name: zipFileName(), bytes: blob.size },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#set({ phase: 'done', message: `Could not pack the ZIP: ${message}` });
    }
  }

  /** Nama entri ZIP dari nama proyek + resepnya (sama dengan ekspor tunggal). */
  #entryName(item: BatchItem, params: RenderParams, format: ExportFormat): string {
    const film = stockInfo(params.film).name;
    const scan = isScanMode(params);
    const paper = scan ? undefined : stockInfo(params.paper).name;
    return exportFileName(item.name || item.fileName, film, paper, EXPORT_EXT[format]);
  }

  #patch(id: string, patch: Partial<BatchItemState>): void {
    this.#set({
      items: this.#state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  }
}

export const batch = new Batch();
