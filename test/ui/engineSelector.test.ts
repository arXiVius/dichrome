// @vitest-environment jsdom
/**
 * `useEngineSelector`: render ulang hanya bila potongan yang dipilih berubah,
 * dan NILAI yang dibaca selalu yang terbaru (bukan cache basi). Ini penjaga
 * bahwa penghematan render tidak mengubah apa yang dilihat pengguna.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const store = vi.hoisted(() => {
  interface State { engine: string; phase: string; params: { exposure: number } }
  let state: State = { engine: 'connecting', phase: 'idle', params: { exposure: 0 } };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    set: (patch: Partial<State>) => {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
  };
});

vi.mock('../../src/ui/engine/engine', () => ({ engine: store }));

import { useEngineSelector } from '../../src/ui/hooks';

let root: Root;
let host: HTMLDivElement;
let renders = 0;
let seen = '';

/** Komponen uji: satu selector, hitung render, tampilkan nilainya. */
function Probe({ field }: { field: 'engine' | 'phase' | 'params' }) {
  const value = useEngineSelector((s) => s[field]);
  renders += 1;
  seen = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return createElement('span', null, seen);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  renders = 0;
  seen = '';
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('render ulang hanya saat potongan yang dipilih berubah', async () => {
  await act(async () => root.render(createElement(Probe, { field: 'engine' })));
  expect(seen).toBe('connecting');
  const base = renders;
  // Perubahan yang tidak terkait: state berubah, potongan tidak.
  await act(async () => store.set({ params: { exposure: 1 } }));
  expect(renders).toBe(base);
  expect(seen).toBe('connecting');
  // Potongan berubah: render ulang dengan nilai baru.
  await act(async () => store.set({ engine: 'ready' }));
  expect(renders).toBe(base + 1);
  expect(seen).toBe('ready');
});

it('nilai yang dibaca selalu yang terbaru (selector tak basi)', async () => {
  await act(async () => root.render(createElement(Probe, { field: 'phase' })));
  expect(seen).toBe('idle');
  await act(async () => store.set({ phase: 'opening' }));
  expect(seen).toBe('opening');
  await act(async () => store.set({ phase: 'editing' }));
  expect(seen).toBe('editing');
});

it('objek hasil selector tetap referensial sama saat isinya tak berubah', async () => {
  const seenRef: unknown[] = [];
  function ObjProbe() {
    const value = useEngineSelector((s) => s.params);
    seenRef.push(value);
    return createElement('span', null, 'x');
  }
  await act(async () => root.render(createElement(ObjProbe)));
  const first = seenRef[0];
  await act(async () => store.set({ engine: 'ready' }));
  // Potongan `params` tak berubah -> objek yang sama (tak ada render ulang).
  expect(seenRef.length).toBe(1);
  expect(seenRef[0]).toBe(first);
});
