import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import { Batch } from '../../src/ui/batch';
import type { BatchEngine, BatchProjects } from '../../src/ui/batch';
import type { ProjectCard, ProjectsState } from '../../src/ui/projects/projects';

const card = (id: string, name: string, missing = false): ProjectCard => ({
  id, name, fileName: `${name}.jpg`, updatedAt: 1,
  params: BASELINE_RENDER_PARAMS, width: 4000, height: 3000, missing,
});

interface EngineCalls {
  opened: string[];
  rendered: { longEdge: number | undefined; width: number; height: number; target?: string }[];
  exported: string[];
  closed: number;
  released: number;
  dismissed: number;
}

function fakeEngine(options: {
  openResult?: (name: string) => boolean;
  onExport?: (name: string) => void;
} = {}): { engine: BatchEngine; calls: EngineCalls } {
  const calls: EngineCalls = { opened: [], rendered: [], exported: [], closed: 0, released: 0, dismissed: 0 };
  let file = 'project.jpg';
  const engine: BatchEngine = {
    get imageSize() { return { width: 4000, height: 3000 }; },
    async openFile(input) { file = input.name; calls.opened.push(input.name); return options.openResult?.(input.name) ?? true; },
    async renderExport(longEdge, requested, renderOptions) {
      calls.rendered.push({ longEdge, width: requested.width, height: requested.height, target: renderOptions.target });
      renderOptions.onProgress?.({ done: 0, total: 2 });
      return requested;
    },
    async exportImage(format) {
      calls.exported.push(format);
      options.onExport?.(file);
      return new File([new Uint8Array([1, 2, 3])], `out.${format}`);
    },
    releaseExport() { calls.released += 1; },
    closePhoto() { calls.closed += 1; },
    dismissError() { calls.dismissed += 1; },
  };
  return { engine, calls };
}

function fakeProjects(cards: ProjectCard[], currentId?: string): { projects: BatchProjects; opened: string[]; closed: () => number } {
  let state: ProjectsState = { loaded: true, list: cards, ...(currentId ? { currentId } : {}) };
  const opened: string[] = [];
  let closeCount = 0;
  const sources = new Map(cards.map((c) => [c.id, {
    file: new File([new Uint8Array([c.id.charCodeAt(0)])], `${c.id}.jpg`),
    params: BASELINE_RENDER_PARAMS,
    removals: [],
  }]));
  const projects: BatchProjects = {
    getState: () => state,
    async close() { closeCount += 1; state = { ...state, currentId: undefined }; },
    async open(id) { opened.push(id); state = { ...state, currentId: id }; return true; },
    async source(id) { return sources.get(id); },
  };
  return { projects, opened, closed: () => closeCount };
}

const names = async (blob: Blob): Promise<string[]> =>
  Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer())));

describe('batch ekspor', () => {
  it('renders every project at its own recipe and packs one ZIP', async () => {
    const { projects, opened, closed } = fakeProjects([card('a', 'One'), card('b', 'Two')], 'open-project');
    const { engine, calls } = fakeEngine();
    const run = new Batch(engine, projects);
    run.open();
    expect(run.getState().phase).toBe('setup');

    await run.run();

    const state = run.getState();
    expect(state.phase).toBe('done');
    expect(state.items.map((i) => i.status)).toEqual(['done', 'done']);
    expect(state.items.every((i) => (i.bytes ?? 0) > 0)).toBe(true);
    expect(calls.opened).toEqual(['a.jpg', 'b.jpg']);
    expect(calls.rendered).toHaveLength(2);
    expect(calls.rendered[0]!.target).toBe('rgb8');
    expect(calls.exported).toEqual(['jpeg', 'jpeg']);
    expect(calls.closed).toBe(1);
    expect(calls.released).toBe(2);
    expect(state.zip).toBeDefined();
    expect((await names(state.zip!.blob)).length).toBe(2);
    // Proyek yang terbuka sebelum batch dibuka lagi setelah selesai.
    expect(closed()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual(['open-project']);
    // Layar tetap terbuka supaya hasil dan tombol unduh terlihat.
    expect(run.getState().open).toBe(true);
  });

  it('skips a project without a saved original and keeps going after a failure', async () => {
    const { projects } = fakeProjects([card('a', 'One'), card('b', 'Gone'), card('c', 'Three')]);
    const { engine, calls } = fakeEngine({ openResult: (name) => name !== 'c.jpg' });
    const run = new Batch(engine, projects);
    run.open();
    // 'b' tidak punya berkas asli tersimpan.
    const originalSource = projects.source;
    projects.source = async (id) => (id === 'b' ? undefined : originalSource(id));

    await run.run();

    const state = run.getState();
    expect(state.items.map((i) => i.status)).toEqual(['done', 'skipped', 'failed']);
    expect(state.items[2]!.error).toContain('could not be opened');
    expect(state.phase).toBe('done');
    expect(await names(state.zip!.blob)).toHaveLength(1);
    expect(calls.dismissed).toBe(1);
  });

  it('stops after the photo in flight when cancelled', async () => {
    const { projects } = fakeProjects([card('a', 'One'), card('b', 'Two')]);
    const { engine, calls } = fakeEngine({ onExport: () => run.cancel() });
    const run = new Batch(engine, projects);
    run.open();

    await run.run();

    const state = run.getState();
    expect(calls.opened).toEqual(['a.jpg']);
    expect(state.items.map((i) => i.status)).toEqual(['done', 'pending']);
    expect(state.cancelled).toBe(true);
    expect(state.message).toContain('Cancelled');
    expect(await names(state.zip!.blob)).toHaveLength(1);
  });

  it('gives same-named projects separate ZIP entries', async () => {
    const { projects } = fakeProjects([card('a', 'Same'), card('b', 'Same')]);
    const { engine } = fakeEngine();
    const run = new Batch(engine, projects);
    run.open();

    await run.run();

    const entries = await names(run.getState().zip!.blob);
    expect(entries).toHaveLength(2);
    expect(entries[0]).not.toBe(entries[1]);
    expect(entries.some((name) => / \(2\)\.jpg$/.test(name))).toBe(true);
  });

  it('reports nothing to do when every project lost its original', async () => {
    const { projects } = fakeProjects([card('a', 'One', true)]);
    const { engine, calls } = fakeEngine();
    const run = new Batch(engine, projects);
    run.open();

    await run.run();

    expect(run.getState().phase).toBe('done');
    expect(run.getState().message).toContain('No photos');
    expect(calls.opened).toEqual([]);
  });
});
