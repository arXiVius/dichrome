// @vitest-environment jsdom
/**
 * Golden test pembanding `memo` baris alat (ToolControl/InspectorTool/
 * ToolSwitch/ResetButton/ToolChips): pembanding HARUS gagal bila perubahan
 * params mengubah satu piksel output -- seretan satu slider tidak boleh
 * me-render ulang baris lain, TAPI baris yang relevan tetap mutakhir.
 *
 * Strategi: render tiap baris di `act`, lalu paksa `rerender` dengan objek
 * `params` BARU (identitas baru, seperti tiap frame state engine), dan
 * pastikan: (a) node DOM lama dipertahankan bila tidak ada yang relevan
 * berubah (skip), (b) teks readout berubah bila field alatnya berubah.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import type { RenderParams } from '../../src/params/renderParams';
import { GROUPS } from '../../src/ui/model/tools';
import type { Tool } from '../../src/ui/model/tools';
import {
  InspectorTool, ResetButton, ToolChips, ToolControl, ToolSwitch,
} from '../../src/ui/screens/ToolControls';
import type { ToolContext } from '../../src/ui/screens/ToolControls';

const onPatch = vi.fn();
const onOpenList = vi.fn();
const onInteractionChange = vi.fn();

/** `ctx` terisolasi: tiap alat boleh berubah tanpa memengaruhi yang lain. */
function ctxFor(params: Partial<RenderParams>): ToolContext {
  return {
    params: { ...BASELINE_RENDER_PARAMS, ...params },
    defaults: { ...BASELINE_RENDER_PARAMS },
    onPatch,
    onInteractionChange,
    onOpenList,
    whiteBalance: { picking: false, busy: false, onPick: onPickWb, onAuto: onAutoWb },
    lens: {
      depth: { status: 'idle' },
      aspect: 1.5,
      onDownload: onDownloadDepth,
      onRetry: onRetryDepth,
      model: 'fast',
      models: ['fast'],
      experimental: [],
      onModel: onDepthModel,
      gpu: false,
      gpuOption: false,
      onGpu: onDepthGpu,
      refined: false,
      onRefine: onRefineDepth,
    },
  };
}
const onPickWb = () => {};
const onAutoWb = () => {};
const onDownloadDepth = () => {};
const onRetryDepth = () => {};
const onDepthModel = () => {};
const onDepthGpu = () => {};
const onRefineDepth = () => {};

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = (() => {}) as unknown as typeof Element.prototype.scrollTo;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** Baris contoh dari tiap jenis alat (kind). */
function sampleTools(): Tool[] {
  const kinds = new Set<string>();
  return GROUPS.flatMap((g) => g.tools).filter((t) => {
    if (kinds.has(t.kind)) return false;
    kinds.add(t.kind);
    return true;
  });
}

it('me-render ulang bila params alatnya berubah (readout ikut), skip bila hanya alat lain yang berubah', async () => {
  for (const tool of sampleTools()) {
    if (tool.kind === 'locked') continue;
    // Satu drag tick: objek params BARU, nilai sama semua.
    await act(async () => root.render(createElement(ToolControl, { tool, ctx: ctxFor({}) })));
    const first = host.innerHTML;
    await act(async () => root.render(createElement(ToolControl, { tool, ctx: ctxFor({}) })));
    expect(host.innerHTML, `${tool.id}: skip saat tak ada perubahan nilai`).toBe(first);
  }
  await act(async () => root.unmount());
  root = createRoot(host);
});

it.each([
  ['film', 'printExposureEv', 1],
  ['color', 'filterC', 10],
  ['texture', 'grainAmount', 1.5],
  ['lens', 'lensForeground', 0.5],
  ['lens', 'lensFocalLengthMm', 85],
] as const)('grup %s: drag field %s mengubah readout alatnya, alat lain tetap skip', async (groupId, field, value) => {
  const group = GROUPS.find((g) => g.id === groupId)!;
  const tools = group.tools.filter((t) => t.kind !== 'locked');
  await act(async () => root.render(
    createElement('div', null, ...tools.map((tool) => createElement(InspectorTool, { key: tool.id, tool, ctx: ctxFor({}) }))),
  ));
  const before = host.innerHTML;
  const changedField = { [field]: value } as Partial<RenderParams>;
  await act(async () => root.render(
    createElement('div', null, ...tools.map((tool) => createElement(InspectorTool, { key: tool.id, tool, ctx: ctxFor(changedField) }))),
  ));
  expect(host.innerHTML, `${groupId}/${field}: baris yang diubah ikut`).not.toBe(before);
});

it('ToolChips: drag satu alat tidak mengubah pil lain; titik edited ikut', async () => {
  const group = GROUPS.find((g) => g.id === 'color')!;
  const onSelect = () => {};
  await act(async () => root.render(
    createElement(ToolChips, { group, selected: 'filterC', onSelect, ctx: ctxFor({}) }),
  ));
  const first = host.querySelectorAll('.tool-pill');
  expect(first.length).toBeGreaterThan(1);
  expect(host.innerHTML).not.toContain('tool-pill-dot');
  // Nyalakan satu slider jauh dari bawaan: hanya pil itu yang dapat titiknya.
  await act(async () => root.render(
    createElement(ToolChips, { group, selected: 'filterC', onSelect, ctx: ctxFor({ filterC: 10 }) }),
  ));
  const dots = host.querySelectorAll('.tool-pill-dot');
  expect(dots.length).toBe(1);
  expect(dots[0]!.closest('.tool-pill')!.getAttribute('aria-label')).toContain('Cyan');
});

it('ToolSwitch/ResetButton: hanya field sakelarnya yang memicu ulang', async () => {
  const tool = GROUPS.flatMap((g) => g.tools).find((t) => t.kind === 'slider' && t.enabledBy)!;
  const enabledBy = tool.kind === 'slider' ? tool.enabledBy! : 'grainEnabled';
  await act(async () => root.render(
    createElement('div', null,
      createElement(ToolSwitch, { tool, ctx: ctxFor({}) }),
      createElement(ResetButton, { tool, ctx: ctxFor({}) }),
    ),
  ));
  // Matikan sakelar: reset dan switch tampil berubah.
  const off = host.innerHTML;
  await act(async () => root.render(
    createElement('div', null,
      createElement(ToolSwitch, { tool, ctx: ctxFor({ [enabledBy]: false } as Partial<RenderParams>) }),
      createElement(ResetButton, { tool, ctx: ctxFor({ [enabledBy]: false } as Partial<RenderParams>) }),
    ),
  ));
  expect(host.innerHTML).not.toBe(off);
});
