/**
 * Label riwayat Undo (tekan lama tombol Undo): tiap langkah dinamai menurut
 * alat yang diubahnya, dengan nilai sesudahnya -- "Exposure  +0.3",
 * "Film  Portra 800". Beberapa alat sekaligus (Reset, Swap): "Exposure, Grain".
 * Crop & Rotate juga satu langkah: "Crop  4:5 · 2.4°".
 */
import type { RenderParams } from '../../params/renderParams';
import type { Crop } from '../../io/geometry';
import { GROUPS, valueText } from './tools';
import type { Tool } from './tools';
import { stockInfo } from './stocks';

/** Field yang diatur sebuah alat. */
function fieldsOf(tool: Tool): readonly string[] {
  switch (tool.kind) {
    case 'slider': return tool.enabledBy ? [tool.field, tool.enabledBy] : [tool.field];
    case 'diffusion': return [tool.enabledBy, tool.familyField, tool.strengthField];
    case 'whiteBalance': return tool.fields;
    case 'locked': return [];
    default: return [tool.field];
  }
}

const TOOLS: readonly Tool[] = GROUPS.flatMap((g) => g.tools);

export interface HistoryLabel { label: string; value?: string }

export function describeChange(from: RenderParams, to: RenderParams): HistoryLabel {
  const changed = (Object.keys(to) as Array<keyof RenderParams>).filter((k) => from[k] !== to[k]);
  if (changed.length === 0) return { label: 'No change' };
  const names: string[] = [];
  let value: string | undefined;
  const add = (name: string, v: string) => {
    if (names.includes(name)) return;
    names.push(name);
    value = names.length === 1 ? v : undefined;
  };
  for (const key of changed) {
    if (key === 'film' || key === 'filmEnabled') add('Film', to.filmEnabled ? stockInfo(to.film).short : 'Off');
    else if (key === 'paper') add('Paper', stockInfo(to.paper).short);
    else {
      const tool = TOOLS.find((t) => fieldsOf(t).includes(key));
      if (tool) add(tool.title, valueText(tool, to));
    }
  }
  if (names.length === 0) return { label: 'Adjustment' };
  return names.length <= 2 ? { label: names.join(', '), value } : { label: `${names.slice(0, 2).join(', ')} +${names.length - 2}` };
}

/** Nilai crop untuk riwayat: rasio, luruskan, putar, cermin ("4:5 · 2.4° · 90°"). */
export function cropText(crop: Crop | undefined): string {
  if (!crop) return 'Off';
  const parts: string[] = [crop.aspect === 'free' ? 'Free' : crop.aspect === 'original' ? 'Original' : crop.aspect];
  if (Math.abs(crop.angle) >= 0.05) parts.push(`${crop.angle.toFixed(1)}°`);
  if (crop.quarter) parts.push(`${crop.quarter * 90}°`);
  if (crop.flip) parts.push('Flipped');
  return parts.join(' · ');
}

/** Satu langkah riwayat (resep + crop); crop yang berubah diberi label "Crop". */
export function describeStep(from: { params: RenderParams; crop?: Crop }, to: { params: RenderParams; crop?: Crop }): HistoryLabel {
  if (from.crop !== to.crop && from.params === to.params) return { label: 'Crop', value: cropText(to.crop) };
  return describeChange(from.params, to.params);
}
