/**
 * Kamera gammā (dari dock Welcome back). Atas: mode jepret (Natural / RAW /
 * ProRAW; yang belum didukung perangkat dicoret) dan grid. Tengah: jendela
 * bidik bersudut membulat dengan look film live, titik fokus, pembesaran,
 * balik kamera. Bawah: pelat kontrol (foto terakhir, white balance, film,
 * tombol jepret + saklar look, mode exposure, EV/SS, penggaris EV).
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
import type { CameraBackend, CaptureMode, Facing } from '../camera/backend';

const PAPER = 'kodak_portra_endura';
const FILMS = ['kodak_portra_400', 'kodak_gold_200', 'kodak_ektar_100', 'kodak_portra_800', 'kodak_ultramax_400', 'kodak_vision3_500t', 'fujifilm_pro_400h', 'fujifilm_c200'];
/** Singkatan film di braket (seperti kode di kaleng film). */
const FILM_CODE: Record<string, string> = {
  kodak_portra_400: 'P400', kodak_gold_200: 'G200', kodak_ektar_100: 'E100', kodak_portra_800: 'P800',
  kodak_ultramax_400: 'U400', kodak_vision3_500t: '500T', fujifilm_pro_400h: '400H', fujifilm_c200: 'C200',
};
const WB: ReadonlyArray<{ code: string; name: string; gains: readonly [number, number, number] }> = [
  { code: 'AWB', name: 'Auto', gains: [1, 1, 1] },
  { code: 'DAY', name: 'Daylight', gains: [1.04, 1, 0.95] },
  { code: 'CLD', name: 'Cloudy', gains: [1.1, 1, 0.88] },
  { code: 'SHD', name: 'Shade', gains: [1.16, 1, 0.82] },
  { code: 'TNG', name: 'Tungsten', gains: [0.76, 1, 1.34] },
  { code: 'FLR', name: 'Fluorescent', gains: [0.9, 1, 1.14] },
];
const EV_STEP = 1 / 3;
const EV_MAX = 3;
/** Jarak geser (px) per 1/3 EV di penggaris. */
const EV_PX = 12;

const store = {
  get<T extends string>(key: string, fallback: T, allowed: readonly string[]): T {
    try { const v = localStorage.getItem(key); return v && allowed.includes(v) ? (v as T) : fallback; } catch { return fallback; }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* diblokir */ }
  },
};

/** Braket tipis bergradien (gaya pelat kamera Moment); warna di styles.css. */
function Bracket({ shape }: { shape: 'tl' | 'bl' | 'r' }) {
  return <span className={`cam-br is-${shape}`} aria-hidden="true" />;
}

export function CameraScreen({ onClose, onCaptured, lastThumb, onOpenLast }: {
  onClose: () => void;
  onCaptured: (file: File) => void;
  lastThumb?: string;
  onOpenLast?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [backend] = useState<CameraBackend>(() => new WebCamera());
  const [mode, setMode] = useState<CaptureMode>(() => store.get('gamma.camera.mode', 'natural', CAPTURE_MODES));
  const [film, setFilm] = useState<string>(() => store.get('gamma.camera.film', FILMS[0]!, FILMS));
  const [lookOn, setLookOn] = useState(() => store.get('gamma.camera.look', 'on', ['on', 'off']) === 'on');
  const [grid, setGrid] = useState(() => store.get('gamma.camera.grid', 'on', ['on', 'off']) === 'on');
  const [facing, setFacing] = useState<Facing>('back');
  const [zoom, setZoom] = useState(1);
  const [ev, setEv] = useState(0);
  const [wb, setWb] = useState(0);
  const [focus, setFocus] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(0);
  const opts = useRef({ look: undefined as string | undefined, ev: 0, wb: WB[0]!.gains as readonly [number, number, number] });
  opts.current = { look: lookOn ? lookKey(film, PAPER, 'printSimulation') : undefined, ev, wb: WB[wb]!.gains };

  useEffect(() => store.set('gamma.camera.mode', mode), [mode]);
  useEffect(() => store.set('gamma.camera.film', film), [film]);
  useEffect(() => store.set('gamma.camera.look', lookOn ? 'on' : 'off'), [lookOn]);
  useEffect(() => store.set('gamma.camera.grid', grid ? 'on' : 'off'), [grid]);

  // Kamera hidup selama layar terbuka; ganti arah = mulai ulang.
  useEffect(() => {
    const v = video.current;
    if (!v) return undefined;
    let alive = true;
    setLive(false);
    setError(null);
    backend.start(v, facing).then(
      () => { if (alive) setError(null); },
      (e: unknown) => { if (alive) setError(e instanceof CameraUnavailableError ? e.message : 'Couldn’t start the camera.'); },
    );
    return () => { alive = false; backend.stop(); };
  }, [backend, facing]);

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
    setFlash((n) => n + 1);
    try {
      onCaptured(await backend.capture(mode, { zoom, facing }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t take the photo.');
      setBusy(false);
    }
  };

  // Penggaris EV: geser vertikal, tik per 1/3 EV.
  const drag = useRef<{ y: number; ev: number } | null>(null);
  const onRulerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, ev };
  };
  const onRulerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = Math.max(-EV_MAX, Math.min(EV_MAX, Math.round((d.ev + (d.y - e.clientY) / EV_PX * EV_STEP) / EV_STEP) * EV_STEP));
    if (Math.abs(next - ev) > 1e-6) { haptic(); setEv(next); }
  };
  const evText = `${ev > 0 ? '+' : ev < 0 ? '−' : ''}${Math.abs(ev).toFixed(1)}`;
  const ticks = Array.from({ length: 2 * EV_MAX / EV_STEP + 1 }, (_, i) => -EV_MAX + i * EV_STEP);
  const supported = backend.modes.includes(mode);

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
        <span className="cam-format">{MODE_INFO[mode].format} · {MODE_INFO[mode].size}{supported ? '' : ` · ${backend.name}: JPEG`}</span>
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
          style={{ transform: `scale(${facing === 'front' ? -zoom : zoom}, ${zoom})` }}
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
        {flash > 0 && <span key={flash} className="cam-flash" aria-hidden="true" />}
        <div className="cam-finder-bar">
          <span className="cam-chip-spacer" aria-hidden="true" />
          <div className="cam-zooms" role="radiogroup" aria-label="Zoom">
            {backend.zooms.map((z) => (
              <button key={z} type="button" role="radio" aria-checked={zoom === z} className="cam-zoom" onClick={() => { haptic(); setZoom(z); }}>
                {zoom === z ? <>{z}<small>×</small></> : z}
              </button>
            ))}
          </div>
          <button type="button" className="cam-icon cam-flip" aria-label="Switch camera" onClick={() => { haptic(); setFacing((f) => (f === 'back' ? 'front' : 'back')); setZoom(1); }}>
            <Icon name="switchCamera" size={20} />
          </button>
        </div>
      </div>

      <div className="cam-plate">
        <button type="button" className="cam-last" aria-label="Last photo" disabled={!lastThumb} onClick={onOpenLast}>
          {lastThumb && <img src={lastThumb} alt="" draggable={false} />}
        </button>

        <div className="cam-left">
          <button type="button" className="cam-bracket-btn is-top" aria-label={`White balance: ${WB[wb]!.name}`} onClick={() => { haptic(); setWb((i) => (i + 1) % WB.length); }}>
            <Bracket shape="tl" />
            <b>{WB[wb]!.code}</b>
          </button>
          <button type="button" className="cam-bracket-btn is-bottom" aria-label={`Film: ${stockInfo(film).short}`} onClick={() => { haptic(); setFilm(FILMS[(FILMS.indexOf(film) + 1) % FILMS.length]!); }}>
            <Bracket shape="bl" />
            <b>{FILM_CODE[film] ?? 'FILM'}</b>
          </button>
        </div>

        <div className="cam-center">
          <motion.button
            type="button"
            className="cam-shutter"
            aria-label="Take photo"
            disabled={!live || busy}
            whileTap={{ scale: 0.92 }}
            onClick={() => void shoot()}
          >
            <span />
          </motion.button>
          <div className="cam-look" role="radiogroup" aria-label="Viewfinder look">
            <button type="button" role="radio" aria-checked={!lookOn} aria-label="Natural (no film look)" onClick={() => { haptic(); setLookOn(false); }}>
              <Icon name="camera" size={16} />
            </button>
            <button type="button" role="radio" aria-checked={lookOn} aria-label={`Film look: ${stockInfo(film).short}`} onClick={() => { haptic(); setLookOn(true); }}>
              F
            </button>
          </div>
        </div>

        <div className="cam-right" aria-label="Exposure mode: auto">
          <Bracket shape="r" />
          <b>A</b>
        </div>

        <div className="cam-readouts">
          <span><small>EV</small><b>{evText}</b></span>
          <span><small>SS</small><b>AUTO</b></span>
        </div>

        <div
          className="cam-ruler"
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
            if (e.key === 'ArrowUp') setEv((v) => Math.min(EV_MAX, v + EV_STEP));
            if (e.key === 'ArrowDown') setEv((v) => Math.max(-EV_MAX, v - EV_STEP));
          }}
        >
          {ticks.map((t) => (
            <i key={t} data-major={Math.abs(t - Math.round(t)) < 1e-6 || undefined} data-on={Math.abs(t - ev) < 1e-6 || undefined} />
          )).reverse()}
        </div>
      </div>
    </motion.div>
  );
}
