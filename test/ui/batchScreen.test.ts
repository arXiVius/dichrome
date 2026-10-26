// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import type { ProjectCard } from '../../src/ui/projects/projects';

const worker = vi.hoisted(() => ({ exportFormats: vi.fn() }));
const engineState = vi.hoisted(() => ({ current: { engine: 'connecting' as string } }));

vi.mock('../../src/ui/engine/engine', () => ({
  engine: {
    getState: () => engineState.current,
    subscribe: () => () => {},
    exportFormats: worker.exportFormats,
  },
}));

vi.mock('../../src/ui/projects/projects', () => {
  const cards: ProjectCard[] = ['a', 'b'].map((id) => ({
    id, name: `Photo ${id}`, fileName: `${id}.jpg`, updatedAt: 1,
    params: BASELINE_RENDER_PARAMS, width: 4000, height: 3000, missing: false,
  }));
  return { projects: { getState: () => ({ loaded: true, list: cards }) } };
});

vi.mock('../../src/ui/components/controls', async () => {
  const { createElement: h } = await import('react');
  return {
    PressButton: ({ children, ...props }: { children: unknown; disabled?: boolean; onClick?: () => void }) =>
      h('button', props, children as never),
    Segmented: ({ label, items, onChange }: {
      label: string; items: readonly { value: string; label: string }[]; value: string;
      onChange: (value: string) => void;
    }) => h('div', { 'aria-label': label }, items.map((item) =>
      h('button', { key: item.value, onClick: () => onChange(item.value) }, item.label))),
    Slider: () => h('div'),
  };
});

import { BatchScreen } from '../../src/ui/screens/Batch';
import { batch } from '../../src/ui/batch';

let host: HTMLDivElement;
let root: Root | undefined;

const text = () => host.textContent ?? '';
const button = (label: string): HTMLButtonElement => {
  const found = Array.from(host.querySelectorAll('button')).find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button "${label}" in: ${text()}`);
  return found;
};

async function renderScreen() {
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(BatchScreen));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  vi.useFakeTimers();
  worker.exportFormats.mockReset();
  engineState.current.engine = 'connecting';
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  batch.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  host.remove();
});

describe('Export All — probing format', () => {
  it('falls back to the built-in encoders when probing never answers', async () => {
    // Regresi: dulu layar hanya mengecek format bila engine 'ready', dan
    // tanpa jawaban daftar format kosong selamanya — layar berhenti di
    // "Checking what this browser can encode…" dan tombol Ekspor mati.
    worker.exportFormats.mockReturnValue(new Promise(() => {}));
    act(() => { batch.open(); });
    await renderScreen();

    expect(text()).toContain('Checking what this browser can encode');
    expect(button('Export 2 photos').disabled).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });

    expect(text()).not.toContain('Checking what this browser can encode');
    expect(text()).toContain('PNG 8-bit');
    expect(text()).toContain('TIFF 16-bit');
    expect(button('Export 2 photos').disabled).toBe(false);
  });

  it('shows whatever the browser actually probed', async () => {
    worker.exportFormats.mockResolvedValue(['png8', 'jpeg']);
    act(() => { batch.open(); });
    await renderScreen();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(text()).toContain('PNG 8-bit');
    expect(text()).toContain('JPEG');
    expect(text()).not.toContain('WebP');
    expect(text()).toContain('Quality');
    expect(button('Export 2 photos').disabled).toBe(false);
  });

  it('probes even while the engine is still connecting', async () => {
    engineState.current.engine = 'connecting';
    worker.exportFormats.mockResolvedValue(['png8']);
    act(() => { batch.open(); });
    await renderScreen();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(worker.exportFormats).toHaveBeenCalled();
    expect(text()).toContain('PNG 8-bit');
  });
});
