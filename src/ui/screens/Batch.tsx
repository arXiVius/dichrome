/**
 * Export All: satu layar penuh di atas editor, dipakai dari All Projects.
 * Tiap foto dirender pada ukurannya sendiri dengan resep yang tersimpan di
 * proyek itu, lalu semuanya dikemas menjadi satu ZIP. Layar ini tetap
 * terpasang saat engine membuka/menutup foto di belakangnya (lihat
 * `ui/batch.ts`), jadi progres tidak ikut hilang ketika Recent berganti ke
 * tampilan foto.
 */
import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { PressButton, Segmented, Slider } from '../components/controls';
import { Spinner } from '../components/Overlays';
import { batch, batchCompleted } from '../batch';
import type { BatchItemState } from '../batch';
import { engine } from '../engine/engine';
import { useBatch, useDialogKeys, useEngineSelector } from '../hooks';
import { activateModal } from '../modalFocus';
import { DEFAULT_QUALITY, FORMAT_INFO } from '../model/exportFormats';
import type { ExportFormat } from '../../session/session';
import { formatBytes, prefersShareSheet, saveViaDownload, saveViaShare } from '../share';

/** Format cadangan bila probing worker belum/tidak tersedia (encoder kita sendiri). */
const FALLBACK_FORMATS: ExportFormat[] = ['png8', 'png16', 'tiff16', 'jpeg'];

const LONG_EDGES = [
  { value: '2048', label: '2048' },
  { value: '4096', label: '4096' },
  { value: '8192', label: '8192' },
  { value: 'null', label: 'Source' },
] as const;

function statusText(item: BatchItemState): string {
  switch (item.status) {
    case 'pending': return 'Waiting';
    case 'opening': return 'Opening…';
    case 'developing': return item.detail ? `Developing… · ${item.detail}` : 'Developing…';
    case 'encoding': return 'Encoding…';
    case 'done': return formatBytes(item.bytes ?? 0);
    case 'skipped': return item.detail ?? 'Skipped';
    case 'failed': return item.error ?? 'Failed';
  }
}

function StatusIcon({ item }: { item: BatchItemState }) {
  if (item.status === 'done') return <Icon name="check" size={16} color="var(--blue)" strokeWidth={2.8} />;
  if (item.status === 'failed') return <Icon name="warning" size={16} color="var(--red-text)" />;
  if (item.status === 'skipped') return <Icon name="info" size={16} color="var(--label-2)" />;
  if (item.status === 'pending') return <span style={{ width: 16, height: 16 }} aria-hidden="true" />;
  return <Spinner size={16} />;
}

function isActive(item: BatchItemState): boolean {
  return item.status === 'opening' || item.status === 'developing' || item.status === 'encoding';
}

export function BatchScreen() {
  const state = useBatch();
  const engineStatus = useEngineSelector((s) => s.engine);
  const ref = useRef<HTMLDivElement>(null);
  const exportable = state.items.filter((item) => !item.missing);
  const completed = batchCompleted(state);
  const shareable = prefersShareSheet();
  const info = FORMAT_INFO[state.format];
  const activeItem = state.items.find(isActive);

  useDialogKeys(ref, () => {
    if (state.phase === 'running') batch.cancel();
    else batch.close();
  });
  useEffect(() => {
    if (ref.current) return activateModal(ref.current);
  }, []);

  // Format ditawarkan hanya bila browser ini benar-benar menghasilkannya,
  // sama seperti lembar Ekspor satu foto. Tapi layar ini TIDAK BOLEH
  // menggantung pada probing (dulu: menunggu `engineStatus === 'ready'`, dan
  // bila status tidak pernah siap -- engine dipulihkan/di-pause di latar --
  // daftar format kosong selamanya dan layar berhenti di "Checking…").
  // Jadi: probing dijalankan apa adanya, jawaban yang gagal/lambat jatuh ke
  // encoder sendiri (PNG/TIFF/JPEG selalu ada), dan hasil probing yang tiba
  // belakangan tetap meng-upgrade daftar -- effect berjalan ulang tiap kali
  // status berubah, jadi probing diulang saat engine benar-benar siap.
  useEffect(() => {
    let live = true;
    let probed = false;
    const fallback = () => { if (live && !probed) batch.setFormats(FALLBACK_FORMATS); };
    const timer = window.setTimeout(fallback, 1500);
    const settle = (formats: ExportFormat[]) => {
      if (!live) return;
      probed = true;
      batch.setFormats(formats);
    };
    try {
      engine.exportFormats().then(settle, fallback);
    } catch {
      fallback();
    }
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [engineStatus]);

  const saveZip = () => {
    if (!state.zip) return;
    const file = new File([state.zip.blob], state.zip.name, { type: 'application/zip' });
    if (shareable) {
      // Dipanggil sinkron dari ketukan (syarat iOS); batal = tidak ada aksi.
      void saveViaShare(file).catch(() => saveViaDownload(file));
    } else {
      saveViaDownload(file);
    }
  };

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Export all photos"
      aria-busy={state.phase === 'running' || undefined}
      className="batch-screen"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
    >
      <header className="batch-bar">
        <span className="t-headline" style={{ flexShrink: 0 }}>Export All</span>
        <span className="t-footnote secondary" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {state.phase === 'running'
            ? `${completed} of ${exportable.length}`
            : `${exportable.length} ${exportable.length === 1 ? 'photo' : 'photos'} · each with its own saved settings`}
        </span>
        {state.phase !== 'running' && (
          <PressButton className="icon-btn" aria-label="Close" onClick={() => batch.close()}>
            <Icon name="close" size={18} strokeWidth={2.4} />
          </PressButton>
        )}
      </header>

      <div className="batch-body scroll-y">
        {state.phase === 'setup' && (
          <>
            <p className="t-footnote secondary" style={{ margin: 0 }}>
              Every photo is developed again from its original with the film, paper, crop and object removal saved on it.
              {state.items.some((item) => item.missing) && ` ${state.items.filter((item) => item.missing).length} without a saved original will be skipped.`}
            </p>

            <section className="list-section">
              <h3 className="list-header">Format</h3>
              {state.formats.length === 0 ? (
                <p className="t-footnote secondary" style={{ margin: 0 }}>Checking what this browser can encode…</p>
              ) : (
                <div className="list" role="radiogroup" aria-label="Format">
                  {state.formats.map((format) => (
                    <button
                      key={format}
                      type="button"
                      role="radio"
                      aria-checked={format === state.format}
                      className="row"
                      style={{ minHeight: 52 }}
                      onClick={() => batch.setFormat(format)}
                    >
                      <span className="row-body">
                        <span className="row-text">
                          <span className="t-body">{FORMAT_INFO[format].name}</span>
                          <span className="t-subhead secondary">{FORMAT_INFO[format].hint}</span>
                        </span>
                        {format === state.format && <Icon name="check" size={20} color="var(--blue)" strokeWidth={2.8} />}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {info.lossy && (
              <section className="list-section">
                <h3 className="list-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Quality</span>
                  <span className="num">{state.quality}</span>
                </h3>
                <Slider
                  label="Quality"
                  value={state.quality}
                  min={1}
                  max={100}
                  step={1}
                  defaultValue={DEFAULT_QUALITY}
                  valueText={`${state.quality}`}
                  onChange={(value) => batch.setQuality(value)}
                />
              </section>
            )}

            <section className="list-section">
              <h3 className="list-header">Long edge</h3>
              <Segmented
                label="Long edge"
                items={LONG_EDGES}
                value={state.longEdge === null ? 'null' : String(state.longEdge)}
                onChange={(value) => batch.setLongEdge(value === 'null' ? null : Number(value))}
              />
              <p className="list-footer t-footnote">
                Photos smaller than this are exported at their own size; nothing is enlarged. Grain, halation and diffusion
                are physical sizes, so each photo is developed at its own pixel pitch rather than resized.
                {state.longEdge === null && exportable.length > 6 && ' Source keeps every original pixel and uses a lot of memory for a large batch.'}
              </p>
            </section>

            {state.message && <p className="t-footnote secondary" role="status" style={{ margin: 0 }}>{state.message}</p>}
          </>
        )}

        {state.phase !== 'setup' && (
          <>
            <div
              className="batch-progress"
              role="progressbar"
              aria-label="Batch progress"
              aria-valuemin={0}
              aria-valuemax={exportable.length}
              aria-valuenow={Math.min(completed, exportable.length)}
            >
              <span style={{ width: `${exportable.length === 0 ? 0 : Math.min(100, Math.round((100 * completed) / exportable.length))}%` }} />
            </div>

            {state.phase === 'running' && state.message && (
              <p className="t-footnote secondary" role="status" style={{ margin: 0 }}>{state.message}</p>
            )}

            <div className="batch-list">
              {state.items.map((item) => (
                <div key={item.id} className="batch-status" data-status={item.status}>
                  <StatusIcon item={item} />
                  <span className="batch-name" title={item.name}>{item.name}</span>
                  <span
                    className="t-footnote tabular"
                    style={{
                      color: item.status === 'failed' ? 'var(--red-text)' : 'var(--label-2)',
                      flexShrink: 0,
                      textAlign: 'right',
                      maxWidth: '48%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={statusText(item)}
                  >
                    {statusText(item)}
                  </span>
                </div>
              ))}
            </div>

            {state.phase === 'done' && state.message && (
              <p className="t-footnote secondary" role="status" style={{ margin: 0 }}>{state.message}</p>
            )}
            {state.phase === 'done' && state.zip && (
              <p className="t-footnote secondary tabular" style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={state.zip.name}>
                {state.zip.name} · {formatBytes(state.zip.bytes)}
              </p>
            )}
          </>
        )}
      </div>

      <footer className="batch-actions">
        {state.phase === 'setup' && (
          <PressButton
            className="capsule prominent large"
            style={{ flex: 1 }}
            disabled={exportable.length === 0 || state.formats.length === 0}
            onClick={() => void batch.run()}
          >
            {exportable.length === 0 ? 'No photos to export' : `Export ${exportable.length} ${exportable.length === 1 ? 'photo' : 'photos'}`}
          </PressButton>
        )}

        {state.phase === 'running' && (
          <PressButton className="capsule large" style={{ flex: 1 }} onClick={() => batch.cancel()}>
            {state.cancelled ? 'Stopping after this photo…' : 'Cancel'}
          </PressButton>
        )}

        {state.phase === 'done' && (
          <>
            <PressButton className="capsule bordered large" onClick={() => batch.close()}>
              Done
            </PressButton>
            {state.zip && (
              <PressButton className="capsule prominent large" style={{ flex: 1 }} onClick={saveZip}>
                <Icon name="share" size={16} strokeWidth={2.2} />
                {shareable ? 'Save ZIP' : `Download ZIP · ${formatBytes(state.zip.bytes)}`}
              </PressButton>
            )}
          </>
        )}
      </footer>

      {state.phase === 'running' && activeItem && (
        <span className="sr-only" role="status" aria-live="polite">
          {activeItem.name}: {statusText(activeItem)}
        </span>
      )}
    </motion.div>
  );
}
