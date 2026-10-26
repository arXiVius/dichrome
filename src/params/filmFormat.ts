/**
 * Sisi panjang tiap format film (mm), `filmFormatLongEdgeMm` OFX
 * (`SpektraVulkanRenderer.cpp:2008`). Modul ringan tanpa impor engine, dipakai
 * `plan.ts`, `Session`, dan UI (readout lens blur).
 */
import type { FilmFormat } from './renderParams';

export const FILM_FORMAT_LONG_EDGE_MM: Readonly<Record<FilmFormat, number>> = Object.freeze({
  standard8: 4.8,
  super8: 5.79,
  standard16: 10.26,
  super16: 12.52,
  standard35: 35,
  super35: 24.89,
  standard65: 52.48,
  imax70: 70.41,
});

/**
 * Ukuran butir fisik per format (mikron). Butir diskalakan terhadap lebar
 * panjang format supaya terlihat proporsional無論 resolusi keluaran. Nilai
 * adalah estimasi representatif untuk negatif warna hitam-putih standar;
 * grainAmount dari parameter UI mengalikan ukuran ini.
 */
export const FILM_FORMAT_GRAIN_UM: Readonly<Record<FilmFormat, number>> = Object.freeze({
  standard8: 10,
  super8: 12,
  standard16: 15,
  super16: 18,
  standard35: 25,
  super35: 22,
  standard65: 38,
  imax70: 50,
});

/** Label layar untuk setiap format film. */
export const FILM_FORMAT_LABELS: Readonly<Record<FilmFormat, string>> = Object.freeze({
  standard8: 'Standard 8 mm',
  super8: 'Super 8 mm',
  standard16: 'Standard 16 mm',
  super16: 'Super 16 mm',
  standard35: 'Standard 35 mm',
  super35: 'Super 35 mm',
  standard65: 'Standard 65 mm',
  imax70: 'IMAX 70 mm',
});

/** Deskripsi singkat untuk setiap format (ditampilkan sebagai catatan alat). */
export const FILM_FORMAT_NOTES: Readonly<Record<FilmFormat, string>> = Object.freeze({
  standard8: 'Format kecil, butir terlihat besar. Cocok untuk look home-movie.',
  super8: 'Lebih lebar dari standard 8, butir sedikit lebih halus.',
  standard16: 'Format dokumenter klasik, butir sedang.',
  super16: '16 mm lebar, digunakan banyak di TV dan film indie.',
  standard35: 'Referensi 35 mm. Butir diskalakan ke 25 mikron di titik netral.',
  super35: '35 mm lebar untuk kamera cinematography, butir sedikit lebih padat.',
  standard65: 'Format besar, butir halus, detail tinggi.',
  imax70: 'IMAX 70 mm, butir sangat halus, resolusi maksimum.',
});
