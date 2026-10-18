/**
 * Kamera gammā: antarmuka backend supaya layar kamera (screens/Camera.tsx)
 * tetap sama saat jepretan pindah ke native. Sekarang `WebCamera`
 * (getUserMedia): jendela bidik live dan jepretan JPEG dari frame video --
 * semua mode menghasilkan JPEG. Nanti plugin native (Capacitor, Swift)
 * mengisi antarmuka yang sama: RAW = Bayer DNG, ProRAW = DNG Apple,
 * Natural = RAW yang di-develop netral ke JPEG.
 */

export type CaptureMode = 'natural' | 'raw' | 'proraw';

export const CAPTURE_MODES: readonly CaptureMode[] = ['natural', 'raw', 'proraw'];

export const MODE_INFO: Record<CaptureMode, { label: string; format: string }> = {
  natural: { label: 'Natural', format: 'JPEG' },
  raw: { label: 'RAW', format: 'DNG' },
  proraw: { label: 'ProRAW', format: 'DNG' },
};

export type Facing = 'back' | 'front';

/** Satu lensa fisik: panjang fokus setara 35 mm (seperti di spesifikasi iPhone). */
export interface Lens {
  id: string;
  facing: Facing;
  mm: number;
  /** Perangkat kamera browser untuk lensa ini (web). */
  deviceId?: string;
}

/** Lensa bawaan sebelum daftar perangkat terbaca (izin kamera belum diberikan). */
export const DEFAULT_LENSES: readonly Lens[] = [
  { id: 'back', facing: 'back', mm: 24 },
  { id: 'front', facing: 'front', mm: 23 },
];

/**
 * Lensa dari nama perangkat Safari iOS ("Back Ultra Wide Camera", "Back
 * Camera", "Back Telephoto Camera", "Front Camera"). Kamera virtual (Dual,
 * Triple) dilewati. Panjang fokus web = perkiraan per jenis lensa iPhone
 * (tele berbeda per model: 52/77/120 mm); versi native membaca nilai
 * sebenarnya dari perangkat.
 */
export function lensesFromDevices(devices: ReadonlyArray<{ deviceId: string; label: string }>): Lens[] {
  const lenses: Lens[] = [];
  for (const d of devices) {
    const label = d.label.toLowerCase();
    if (!label || /dual|triple|desk view/.test(label)) continue;
    const front = /front|user|facetime|depan/.test(label);
    const mm = front ? 23 : /ultra ?wide/.test(label) ? 13 : /tele/.test(label) ? 77 : 24;
    const facing: Facing = front ? 'front' : 'back';
    if (lenses.some((l) => l.facing === facing && l.mm === mm)) continue;
    lenses.push({ id: `${facing}-${mm}`, facing, mm, deviceId: d.deviceId });
  }
  if (!lenses.some((l) => l.facing === 'back')) lenses.unshift(...DEFAULT_LENSES.filter((l) => l.facing === 'back'));
  return lenses.sort((a, b) => (a.facing === b.facing ? a.mm - b.mm : a.facing === 'back' ? -1 : 1));
}

export interface CameraBackend {
  /** Nama untuk label kecil di layar ("Web preview" / "iPhone"). */
  readonly name: string;
  /** Mode yang benar-benar didukung perangkat ini (yang lain tampil, tetapi jatuh ke format web). */
  readonly modes: readonly CaptureMode[];
  /** Lensa fisik perangkat ini (setelah `start` pertama; sebelum itu `DEFAULT_LENSES`). */
  lenses(): Promise<Lens[]>;
  start(video: HTMLVideoElement, lens: Lens): Promise<void>;
  stop(): void;
  /** Jepret frame penuh lensa yang aktif, dengan kompensasi exposure (EV) dan white balance. */
  capture(mode: CaptureMode, opts: CaptureOptions): Promise<File>;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface CaptureOptions {
  facing: Facing;
  /** Kompensasi exposure (EV), 0 = apa adanya. */
  ev?: number;
  /** Penguat white balance R, G, B (1 = netral). */
  wb?: readonly [number, number, number];
}

/**
 * Tabel per kanal untuk EV dan white balance: dihitung di cahaya linear
 * (perkiraan gamma 2,2), sama dengan jendela bidik (LiveLook), jadi hasil
 * jepretan seterang yang terlihat. `undefined` bila netral.
 */
export function exposureTables(ev = 0, wb: readonly [number, number, number] = [1, 1, 1]): [Uint8Array, Uint8Array, Uint8Array] | undefined {
  if (Math.abs(ev) < 1e-6 && wb.every((g) => Math.abs(g - 1) < 1e-6)) return undefined;
  const gain = 2 ** ev;
  return wb.map((g) => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) t[i] = Math.round(255 * Math.min(1, ((i / 255) ** 2.2) * gain * g) ** (1 / 2.2));
    return t;
  }) as [Uint8Array, Uint8Array, Uint8Array];
}

export class CameraUnavailableError extends Error {
  override name = 'CameraUnavailableError';
}

/** Kamera browser: pratinjau dan JPEG dari frame video (tanpa RAW). */
export class WebCamera implements CameraBackend {
  readonly name = 'Web preview';
  readonly modes: readonly CaptureMode[] = ['natural'];
  #stream: MediaStream | undefined;
  #video: HTMLVideoElement | undefined;

  async lenses(): Promise<Lens[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return lensesFromDevices(devices.filter((d) => d.kind === 'videoinput'));
    } catch {
      return [...DEFAULT_LENSES];
    }
  }

  async start(video: HTMLVideoElement, lens: Lens): Promise<void> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraUnavailableError('This browser can’t use the camera.');
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(lens.deviceId ? { deviceId: { exact: lens.deviceId } } : { facingMode: lens.facing === 'back' ? 'environment' : 'user' }),
          width: { ideal: 4032 }, height: { ideal: 3024 },
        },
      });
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      throw new CameraUnavailableError(denied ? 'Camera access is off. Allow it for gammā in Settings.' : 'No camera found.');
    }
    this.#video = video;
    video.srcObject = this.#stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
  }

  stop(): void {
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
    if (this.#video) this.#video.srcObject = null;
  }

  async capture(_mode: CaptureMode, { facing, ev, wb }: CaptureOptions): Promise<File> {
    const video = this.#video;
    if (!video || !video.videoWidth) throw new CameraUnavailableError('The camera isn’t ready yet.');
    const w = video.videoWidth, h = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CameraUnavailableError('Couldn’t take the photo.');
    // Kamera depan: simpan seperti yang terlihat di jendela bidik (cermin).
    if (facing === 'front') { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, w, h);
    const tables = exposureTables(ev, wb);
    if (tables) {
      const image = ctx.getImageData(0, 0, w, h);
      const d = image.data, [tr, tg, tb] = tables;
      for (let i = 0; i < d.length; i += 4) { d[i] = tr[d[i]!]!; d[i + 1] = tg[d[i + 1]!]!; d[i + 2] = tb[d[i + 2]!]!; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(image, 0, 0);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) throw new CameraUnavailableError('Couldn’t take the photo.');
    return new File([blob], `gamma_${stamp()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  }
}
