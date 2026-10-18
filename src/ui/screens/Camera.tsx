/**
 * Kamera gammā (dari dock Welcome back), gaya rangefinder retro-modern.
 * Atas: mode jepret (Natural / RAW / ProRAW; yang belum didukung perangkat
 * dicoret) dan grid. Tengah: jendela bidik 3:4 dengan look film live, data
 * kecil (WB, ISO, EV), lensa (mm), balik kamera. Bawah: jendela film (kemasan
 * stok; ketuk = ganti film), tombol jepret bercincin, penghitung frame roll,
 * dial EV horizontal. Jepret = tirai shutter + frame berkurang satu.
 *
 * Tampilan saja di sini; jepretan lewat `CameraBackend` (sekarang WebCamera,
 * nanti plugin native) jadi UI ini tetap saat port native.
 */
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../components/Icon';
import { haptic } from '../haptics';
import { LiveLook, loadLooks, lookKey } from '../engine/looks';
import { stockInfo } from '../model/stocks';
import { CAPTURE_MODES, CameraUnavailableError, MODE_INFO, WebCamera } from '../camera/backend';
import { DEFAULT_LENSES } from '../camera/backend';
import type { CameraBackend, CaptureMode, Lens } from '../camera/backend';

const PAPER = 'kodak_portra_endura';
const FILMS = ['kodak_portra_400', 'kodak_gold_200', 'kodak_ektar_100', 'kodak_portra_800', 'kodak_ultramax_400', 'kodak_vision3_500t', 'fujifilm_pro_400h', 'fujifilm_c200'];
/** Jendela film: warna kemasan stok, seperti potongan kotak film di punggung kamera analog. */
const FILM_BOX: Record<string, { brand: string; speed: string; name: string; bg: string; fg: string }> = {
  kodak_portra_400: { brand: 'KODAK', speed: '400', name: 'PORTRA', bg: '#e8702a', fg: '#fff' },
  kodak_gold_200: { brand: 'KODAK', speed: '200', name: 'GOLD', bg: '#f2b705', fg: '#3a1c00' },
  kodak_ektar_100: { brand: 'KODAK', speed: '100', name: 'EKTAR', bg: '#d6362b', fg: '#fff' },
  kodak_portra_800: { brand: 'KODAK', speed: '800', name: 'PORTRA', bg: '#c94a26', fg: '#fff' },
  kodak_ultramax_400: { brand: 'KODAK', speed: '400', name: 'ULTRAMAX', bg: '#2357b5', fg: '#ffd23f' },
  kodak_vision3_500t: { brand: 'KODAK', speed: '500T', name: 'VISION3', bg: '#2a3d7a', fg: '#fff' },
  fujifilm_pro_400h: { brand: 'FUJI', speed: '400', name: 'PRO 400H', bg: '#2b9b7a', fg: '#fff' },
  fujifilm_c200: { brand: 'FUJI', speed: '200', name: 'C200', bg: '#3a8f3a', fg: '#fff' },
};
/** Satu roll: penghitung frame mundur dari sini, roll baru otomatis saat habis. */
const ROLL = 36;
const WB: ReadonlyArray<{ code: string; name: string; gains: readonly [number, number, number] }> = [
  { code: 'AWB', name: 'Auto', gains: [1, 1, 1] },
  { code: 'DAY', name: 'Daylight', gains: [1.04, 1, 0.95] },
  { code: 'CLD', name: 'Cloudy', gains: [1.1, 1, 0.88] },
  { code: 'SHD', name: 'Shade', gains: [1.16, 1, 0.82] },
  { code: 'TNG', name: 'Tungsten', gains: [0.76, 1, 1.34] },
  { code: 'FLR', name: 'Fluorescent', gains: [0.9, 1, 1.14] },
];
const EV_STEP = 1 / 3;
const EV_MAX = 2;
/** Jarak geser horizontal (px) per 1/3 EV di dial. */
const EV_PX = 14;

const store = {
  get<T extends string>(key: string, fallback: T, allowed: readonly string[]): T {
    try { const v = localStorage.getItem(key); return v && allowed.includes(v) ? (v as T) : fallback; } catch { return fallback; }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* diblokir */ }
  },
};

export function CameraScreen({ onClose, onCaptured }: {
  onClose: () => void;
  onCaptured: (file: File) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [backend] = useState<CameraBackend>(() => new WebCamera());
  const [mode, setMode] = useState<CaptureMode>(() => store.get('gamma.camera.mode', 'natural', CAPTURE_MODES));
  const [film, setFilm] = useState<string>(() => store.get('gamma.camera.film', FILMS[0]!, FILMS));
  const [grid, setGrid] = useState(() => store.get('gamma.camera.grid', 'on', ['on', 'off']) === 'on');
  const [lenses, setLenses] = useState<readonly Lens[]>(DEFAULT_LENSES);
  const [lens, setLens] = useState<Lens>(DEFAULT_LENSES[0]!);
  const facing = lens.facing;
  const [ev, setEv] = useState(0);
  const [wb, setWb] = useState(0);
  const [focus, setFocus] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [curtain, setCurtain] = useState(false);
  const [frames, setFrames] = useState(() => Number(store.get('gamma.camera.frames', String(ROLL), Array.from({ length: ROLL }, (_, i) => String(i + 1)))));
  const opts = useRef({ look: undefined as string | undefined, ev: 0, wb: WB[0]!.gains as readonly [number, number, number] });
  opts.current = { look: lookKey(film, PAPER, 'printSimulation'), ev, wb: WB[wb]!.gains };

  useEffect(() => store.set('gamma.camera.mode', mode), [mode]);
  useEffect(() => store.set('gamma.camera.film', film), [film]);
  useEffect(() => store.set('gamma.camera.frames', String(frames)), [frames]);
  useEffect(() => store.set('gamma.camera.grid', grid ? 'on' : 'off'), [grid]);

  // Kamera hidup selama layar terbuka; ganti arah = mulai ulang.
  useEffect(() => {
    const v = video.current;
    if (!v) return undefined;
    let alive = true;
    setLive(false);
    setError(null);
    backend.start(v, lens).then(
      async () => {
        if (!alive) return;
        setError(null);
        // Nama lensa baru terbaca setelah izin kamera: ganti daftar bawaan dengan lensa sebenarnya.
        const found = await backend.lenses();
        if (!alive) return;
        setLenses(found);
        if (!lens.deviceId) setLens(found.find((l) => l.facing === lens.facing && l.mm === 24) ?? found.find((l) => l.facing === lens.facing) ?? lens);
      },
      (e: unknown) => { if (alive) setError(e instanceof CameraUnavailableError ? e.message : 'Couldn’t start the camera.'); },
    );
    return () => { alive = false; backend.stop(); };
  }, [backend, lens]);

  // Jendela bidik: tiap frame video lewat look live.
  useEffect(() => {
    const v = video.current, c = canvas.current;
    if (!v || !c) return undefined;
    const look = new LiveLook(c);
    void loadLooks();
    let raf = 0;
    const tick = () => {
      if (look.draw(v, opts.current)) setLive(true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const shoot = async () => {
    if (busy || !live) return;
    haptic();
    setBusy(true);
    // Tirai shutter menutup sesaat, lalu film maju satu frame (roll baru saat habis).
    setCurtain(true);
    window.setTimeout(() => setCurtain(false), 140);
    setFrames((n) => (n <= 1 ? ROLL : n - 1));
    try {
      const file = await backend.capture(mode, { facing });
      window.setTimeout(() => haptic(), 90);
      onCaptured(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t take the photo.');
      setBusy(false);
    }
  };

  // Dial EV: geser horizontal (kanan = lebih terang), tik per 1/3 EV.
  const drag = useRef<{ x: number; ev: number } | null>(null);
  const onRulerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, ev };
  };
  const onRulerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = Math.max(-EV_MAX, Math.min(EV_MAX, Math.round((d.ev + (e.clientX - d.x) / EV_PX * EV_STEP) / EV_STEP) * EV_STEP));
    if (Math.abs(next - ev) > 1e-6) { haptic(); setEv(next); }
  };
  const evText = `${ev > 0 ? '+' : ev < 0 ? '−' : ''}${Math.abs(ev).toFixed(1)}`;
  const ticks = Array.from({ length: 2 * EV_MAX / EV_STEP + 1 }, (_, i) => -EV_MAX + i * EV_STEP);
  const supported = backend.modes.includes(mode);
  const box = FILM_BOX[film] ?? FILM_BOX.kodak_portra_400!;

  return (
    <motion.div
      className="cam-screen"
      role="dialog"
      aria-modal="true"
      aria-label="Camera"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ type: 'spring', duration: 0.4, bounce: 0 }}
    >
      <header className="cam-top">
        <button
          type="button"
          className="cam-mode"
          data-unsupported={!supported || undefined}
          aria-label={`Capture format: ${MODE_INFO[mode].label}${supported ? '' : ' (not on this device yet)'}. Tap to change.`}
          onClick={() => { haptic(); setMode(CAPTURE_MODES[(CAPTURE_MODES.indexOf(mode) + 1) % CAPTURE_MODES.length]!); }}
        >
          {MODE_INFO[mode].label}
        </button>
        <span className="cam-format">{MODE_INFO[mode].format}{supported ? '' : ` · ${backend.name}: JPEG`}</span>
        <div className="cam-top-actions">
          <button type="button" className="cam-icon" aria-label="Grid" aria-pressed={grid} onClick={() => { haptic(); setGrid((g) => !g); }}>
            <Icon name="grid" size={20} />
          </button>
          <button type="button" className="cam-icon" aria-label="Close camera" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
      </header>

      <div
        className="cam-finder"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          const r = e.currentTarget.getBoundingClientRect();
          setFocus({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
        }}
      >
        <video ref={video} className="cam-video" playsInline muted aria-hidden="true" />
        <canvas
          ref={canvas}
          className="cam-canvas"
          data-live={live || undefined}
          style={{ transform: facing === 'front' ? 'scaleX(-1)' : undefined }}
          aria-label="Viewfinder"
          role="img"
        />
        {grid && (
          <div className="cam-grid" aria-hidden="true"><i /><i /><i /><i /></div>
        )}
        {focus && (
          <span className="cam-focus" aria-hidden="true" style={{ left: `${focus.x * 100}%`, top: `${focus.y * 100}%` }}>
            <i />
            <span style={{ transform: `translateY(${-ev * 9}px)` }}><Icon name="exposure" size={18} strokeWidth={1.8} /></span>
            <i />
          </span>
        )}
        {error && <p className="cam-error" role="alert">{error}</p>}
        <span className="cam-curtain" data-closed={curtain || undefined} aria-hidden="true" />
        <div className="cam-data">
          <button type="button" aria-label={`White balance: ${WB[wb]!.name}. Tap to change.`} onClick={() => { haptic(); setWb((i) => (i + 1) % WB.length); }}>{WB[wb]!.code}</button>
          <span>ISO AUTO</span>
          <span>{ev === 0 ? '±' : ''}{evText} EV</span>
        </div>
        <div className="cam-finder-bar">
          <span className="cam-chip-spacer" aria-hidden="true" />
          <div className="cam-lenses" role="radiogroup" aria-label="Lens">
            {lenses.filter((l) => l.facing === facing).map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={lens.id === l.id} className="cam-lens" onClick={() => { if (l.id !== lens.id) { haptic(); setLens(l); } }}>
                {l.mm}mm
              </button>
            ))}
          </div>
          <button type="button" className="cam-icon cam-flip" aria-label="Switch camera" onClick={() => {
            haptic();
            const other = facing === 'back' ? 'front' : 'back';
            setLens(lenses.find((l) => l.facing === other && (other === 'front' || l.mm === 24)) ?? lenses.find((l) => l.facing === other) ?? DEFAULT_LENSES.find((l) => l.facing === other)!);
          }}>
            <Icon name="switchCamera" size={20} />
          </button>
        </div>
      </div>

      <div className="cam-plate">
        <div className="cam-row">
          <button type="button" className="cam-film" aria-label={`Film: ${stockInfo(film).short}. Tap to change.`} onClick={() => { haptic(); setFilm(FILMS[(FILMS.indexOf(film) + 1) % FILMS.length]!); }}>
            <span className="cam-window">
              <span className="cam-film-box" style={{ background: box.bg, color: box.fg }}>
                <small>{box.brand}</small>
                <b>{box.speed}</b>
                <small>{box.name}</small>
              </span>
            </span>
            <span className="cam-caption">FILM</span>
          </button>

          <motion.button
            type="button"
            className="cam-shutter"
            aria-label="Take photo"
            disabled={!live || busy}
            whileTap={{ scale: 0.94 }}
            onClick={() => void shoot()}
          >
            <span />
          </motion.button>

          <div className="cam-counter" aria-label={`${frames} exposures left on this roll`}>
            <span className="cam-window is-counter">
              <i aria-hidden="true" />
              <motion.b key={frames} initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', duration: 0.35, bounce: 0.2 }}>
                {String(frames).padStart(2, '0')}
              </motion.b>
              <small>EXP</small>
            </span>
            <span className="cam-caption">FRAMES</span>
          </div>
        </div>

        <div
          className="cam-dial"
          role="slider"
          tabIndex={0}
          aria-label="Exposure compensation"
          aria-valuemin={-EV_MAX}
          aria-valuemax={EV_MAX}
          aria-valuenow={Number(ev.toFixed(2))}
          aria-valuetext={`${evText} EV`}
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onDoubleClick={() => setEv(0)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') setEv((v) => Math.min(EV_MAX, v + EV_STEP));
            if (e.key === 'ArrowLeft') setEv((v) => Math.max(-EV_MAX, v - EV_STEP));
          }}
        >
          <span className="cam-dial-label">EV <b>{evText}</b></span>
          <span className="cam-dial-ticks" aria-hidden="true">
            {ticks.map((t) => (
              <i key={t} data-major={Math.abs(t - Math.round(t)) < 1e-6 || undefined} data-on={Math.abs(t - ev) < 1e-6 || undefined} />
            ))}
          </span>
          <span className="cam-dial-numbers" aria-hidden="true"><span>−2</span><span>−1</span><span>0</span><span>+1</span><span>+2</span></span>
        </div>
      </div>
    </motion.div>
  );
}
