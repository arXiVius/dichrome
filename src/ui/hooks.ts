import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { engine } from './engine/engine';
import type { EngineState } from './engine/engine';
import { projects } from './projects/projects';
import type { ProjectsState } from './projects/projects';
import { batch } from './batch';
import type { BatchState } from './batch';

export function useEngineState(): EngineState {
  return useSyncExternalStore(engine.subscribe, engine.getState);
}

/**
 * Render ulang hanya bila potongan state yang dipilih berubah (per referensi
 * atau `isEqual`). Selama seretan slider, `EngineState` berganti tiap frame
 * (~60×/s): komponen yang hanya butuh sebagian kecil state (toolbar, sibling
 * App, sheet) tidak ikut me-render ulang.
 *
 * `selector` boleh inline: identitasnya tidak memicu render ulang, hanya
 * hasil pemilihannya yang dibaca saat `getSnapshot` dipanggil React.
 */
export function useEngineSelector<T>(selector: (state: EngineState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  // Selector boleh inline; identitasnya tidak boleh memicu render ulang, tapi
  // HARUS dipakai versi terbaru: `getSnapshot` bisa dipanggil saat render.
  // Karena itu ref diperbarui saat render (bukan di effect -- effect jalan
  // sesudah paint, jadi satu frame bisa membaca selector lama).
  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);
  selectorRef.current = selector;
  isEqualRef.current = isEqual;
  // Cache per snapshot: `getSnapshot` wajib mengembalikan referensi yang sama
  // bila tidak ada perubahan (aturan `useSyncExternalStore`), dan tidak boleh
  // membuat objek baru tiap panggilan (bisa dipanggil berkali-kali per render).
  const cache = useRef<{ state: EngineState; value: T } | null>(null);
  const getSnapshot = useCallback((): T => {
    const state = engine.getState();
    const cached = cache.current;
    if (cached && cached.state === state) return cached.value;
    const value = selectorRef.current(state);
    if (cached && isEqualRef.current(cached.value, value)) {
      cache.current = { state, value: cached.value };
      return cached.value;
    }
    cache.current = { state, value };
    return value;
  }, []);
  return useSyncExternalStore(engine.subscribe, getSnapshot);
}

export function useProjects(): ProjectsState {
  return useSyncExternalStore(projects.subscribe, projects.getState);
}

export function useBatch(): BatchState {
  return useSyncExternalStore(batch.subscribe, batch.getState);
}

export interface SizeClass {
  /** `regular`: lebar ≥ 1080 dan tinggi ≥ 560 (iPad lanskap, desktop), atau HP lanskap. */
  width: 'compact' | 'regular';
  /** Compact dengan tinggi pendek (jendela desktop pendek): panel pindah ke samping. */
  landscape: boolean;
  /** HP diputar lanskap: tata letak PC dengan panel lebih sempit dan safe area. */
  phone: boolean;
}

/**
 * Batas tata letak regular. Dua panel samping memakan 648 px; di bawah ~1080
 * foto dan toolbar-nya tinggal sepotong, jadi layar selebar itu memakai
 * tata letak compact.
 */
const REGULAR_MIN_WIDTH = 1080;

/** Tinggi maksimum layar HP dalam posisi lanskap (iPhone Pro Max: 430). */
const PHONE_LANDSCAPE_MAX_HEIGHT = 560;

function readSizeClass(): SizeClass {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Layar sentuh yang diputar lanskap dan pendek = HP: pakai tata letak PC.
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const phone = coarse && w > h && h < PHONE_LANDSCAPE_MAX_HEIGHT;
  const regular = phone || (w >= REGULAR_MIN_WIDTH && h >= 560);
  return { width: regular ? 'regular' : 'compact', landscape: !regular && w > h && h < 520, phone };
}

export function useSizeClass(): SizeClass {
  const [size, setSize] = useState(readSizeClass);
  useEffect(() => {
    const onResize = () => setSize((prev) => {
      const next = readSizeClass();
      return prev.width === next.width && prev.landscape === next.landscape && prev.phone === next.phone ? prev : next;
    });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/**
 * `image/heic` sengaja TIDAK didaftarkan: tanpanya iOS mengonversi foto HEIC
 * dari Photos menjadi JPEG (dengan Orientation dan profil Display P3), yang
 * lewat decoder `io/` bit-identik. HEIC yang tetap masuk (seret-lepas, Files)
 * dibaca lewat `engine/browserDecode.ts`.
 */
export const ACCEPTED_FILES =
  'image/jpeg,image/png,image/tiff,image/x-exr,image/webp,image/avif,.jpg,.jpeg,.png,.tif,.tiff,.exr,.dng,.cr2,.cr3,.crw,.nef,.nrw,.arw,.srf,.sr2,.raf,.orf,.rw2,.rwl,.pef,.srw,.3fr,.iiq,.x3f,.mrw,.erf,.kdc,.dcr,.mos';

/** Pemilih berkas tersembunyi; `pick()` membukanya dari gestur pengguna. */
export function useFilePicker(onFile: (file: File) => void): { pick: () => void; input: HTMLInputElement | null; ref: (el: HTMLInputElement | null) => void } {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pick = useCallback(() => inputRef.current?.click(), []);
  const ref = useCallback(
    (el: HTMLInputElement | null) => {
      if (inputRef.current) inputRef.current.onchange = null;
      inputRef.current = el;
      if (el) {
        el.onchange = () => {
          const file = el.files?.[0];
          el.value = '';
          if (file) onFile(file);
        };
      }
    },
    [onFile],
  );
  return { pick, input: inputRef.current, ref };
}

/** Lebar elemen, diperbarui lewat ResizeObserver. */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.offsetWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// ---------------------------------------------------------------------------
// Dialog: Escape menutup dari mana saja dan Tab tetap di dalam dialog. Hanya
// dialog teratas yang menanggapi (mis. Alert galat di atas sheet Ekspor).

const dialogStack: object[] = [];

/** Ada dialog terbuka: pintasan keyboard editor diam. */
export function dialogOpen(): boolean {
  return dialogStack.length > 0;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]';

export function useDialogKeys(ref: React.RefObject<HTMLElement | null>, onEscape: () => void, manageTab = true, enabled = true): void {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });
  useEffect(() => {
    if (!enabled) return;
    const token = {};
    dialogStack.push(token);
    const onKeyDown = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root || dialogStack[dialogStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        escape.current();
        return;
      }
      if (e.key !== 'Tab' || !manageTab) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        root.focus();
      } else if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      dialogStack.splice(dialogStack.indexOf(token), 1);
    };
  }, [ref, manageTab, enabled]);
}
