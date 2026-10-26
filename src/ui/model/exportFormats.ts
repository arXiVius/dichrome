/**
 * Metadata berkas ekspor, dipakai lembar Ekspor satu foto dan ekspor batch.
 * Modul murni: tidak menyentuh engine atau DOM, jadi bisa diuji tanpa WebGPU.
 */
import type { ExportFormat } from '../../session/session';

export const EXPORT_MIME: Record<ExportFormat, string> = {
  png8: 'image/png',
  png16: 'image/png',
  tiff16: 'image/tiff',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

export const EXPORT_EXT: Record<ExportFormat, string> = {
  png8: 'png',
  png16: 'png',
  tiff16: 'tif',
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
};

export interface FormatInfo {
  name: string;
  hint: string;
  lossy: boolean;
}

export const FORMAT_INFO: Record<ExportFormat, FormatInfo> = {
  png8: { name: 'PNG 8-bit', hint: 'Lossless · every pixel as rendered', lossy: false },
  png16: { name: 'PNG 16-bit', hint: 'Lossless · smooth gradients', lossy: false },
  tiff16: { name: 'TIFF 16-bit', hint: 'Uncompressed · for further editing', lossy: false },
  jpeg: { name: 'JPEG', hint: 'Lossy · smallest widely compatible file', lossy: true },
  webp: { name: 'WebP', hint: 'Lossy · smaller than JPEG at like quality', lossy: true },
  avif: { name: 'AVIF', hint: 'Lossy · smallest file, slowest to encode', lossy: true },
};

/** Bawaan format lossy: tanpa artefak yang terlihat, jauh lebih kecil dari 100. */
export const DEFAULT_QUALITY = 92;
