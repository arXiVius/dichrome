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

export const MODE_INFO: Record<CaptureMode, { label: string; format: string; size: string }> = {
  natural: { label: 'Natural', format: 'JPEG', size: '~4 MB' },
  raw: { label: 'RAW', format: 'DNG', size: '~18 MB' },
  proraw: { label: 'ProRAW', format: 'DNG', size: '~50 MB' },
};

export type Facing = 'back' | 'front';

export interface CameraBackend {
  /** Nama untuk label kecil di layar ("Web preview" / "iPhone"). */
  readonly name: string;
  /** Mode yang benar-benar didukung perangkat ini (yang lain tampil, tetapi jatuh ke format web). */
  readonly modes: readonly CaptureMode[];
  /** Pembesaran yang tersedia (lensa native; web = digital). */
  readonly zooms: readonly number[];
  start(video: HTMLVideoElement, facing: Facing): Promise<void>;
  stop(): void;
  /** Jepret: frame penuh, `zoom` dipotong dari tengah. */
  capture(mode: CaptureMode, opts: { zoom: number; facing: Facing }): Promise<File>;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class CameraUnavailableError extends Error {
  override name = 'CameraUnavailableError';
}

/** Kamera browser: pratinjau dan JPEG dari frame video (tanpa RAW). */
export class WebCamera implements CameraBackend {
  readonly name = 'Web preview';
  readonly modes: readonly CaptureMode[] = ['natural'];
  readonly zooms: readonly number[] = [1, 2, 5];
  #stream: MediaStream | undefined;
  #video: HTMLVideoElement | undefined;

  async start(video: HTMLVideoElement, facing: Facing): Promise<void> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraUnavailableError('This browser can’t use the camera.');
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: facing === 'back' ? 'environment' : 'user', width: { ideal: 4032 }, height: { ideal: 3024 } },
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

  async capture(_mode: CaptureMode, { zoom, facing }: { zoom: number; facing: Facing }): Promise<File> {
    const video = this.#video;
    if (!video || !video.videoWidth) throw new CameraUnavailableError('The camera isn’t ready yet.');
    const w = Math.round(video.videoWidth / zoom), h = Math.round(video.videoHeight / zoom);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CameraUnavailableError('Couldn’t take the photo.');
    // Kamera depan: simpan seperti yang terlihat di jendela bidik (cermin).
    if (facing === 'front') { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, (video.videoWidth - w) / 2, (video.videoHeight - h) / 2, w, h, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) throw new CameraUnavailableError('Couldn’t take the photo.');
    return new File([blob], `gamma_${stamp()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  }
}
