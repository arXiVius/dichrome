/**
 * Sisi worker RPC `Session`. `serveSession` bebas lingkungan (diuji di Node
 * dengan `MessageChannel`); entry browser-nya `worker.ts`, yang memuat modul
 * ini secara dinamis (lihat alasannya di sana).
 *
 * Panggilan dilayani BERURUTAN sesuai kedatangan, kecuali `render`,
 * `exportCube`, `renderExport`, `exportImage`, dan `decode` yang asinkron: dimulai berurutan
 * tapi boleh selesai tidak berurutan (antrean terbaru-menang ada di `Session`
 * sendiri). `decode` tidak butuh `init`.
 */

import type { DecodedImage } from '../io/decoded';
import { decodeImage } from '../io';
import type { MessagePortLike, RpcError, RpcRequest, RpcResponse, SessionInit, SessionLike, SessionMethod } from './protocol';
import { cloneTypedArrays, transferablesOf } from './protocol';
import { Session } from './session';

/**
 * Method yang hasilnya SEGAR: dibangkitkan per panggilan dan tidak pernah
 * disimpan `Session`, jadi aman DITRANSFER langsung tanpa salinan (hemat
 * satu memcpy seukuran hasil per panggilan -- `stageOpen`/`applyRemoval`
 * bisa belasan MB: frame original + guide + pratinjau).
 *
 * Metode yang TIDAK tercantum (mis. `render`, yang mengembalikan objek dari
 * cache `#cache`/`#previewCache`) tetap lewat `cloneTypedArrays`: transfer
 * tanpa salinan akan me-detach buffer milik Session dan merusak cache-nya.
 * Kebijakannya sengaja allowlist -- metode baru yang menghasilkan larik
 * ter-cache ikut disalin dengan aman sampai didaftarkan di sini.
 *
 * Semua hasil di atas hanya berisi objek/larik SEGAR; `getParams`/
 * `getDiagnostics`/`lastFullSize`/`renderExport`/`exportProgress`/
 * `exportFormats`/`whiteBalance`/`exportCube` tanpa larik pun aman
 * di-straight-clone (tanpa salinan manual ganda).
 */
const FRESH_RESULTS = new Set<SessionMethod | 'decode' | 'init'>([
  'applyRemoval', 'undoRemoval', 'stageOpen', 'prepareRemoval', 'refineSource', 'whiteBalance',
  'getParams', 'getDiagnostics', 'lastFullSize', 'renderExport', 'exportProgress', 'exportFormats',
  'exportCube', 'prewarm', 'commitOpen', 'finishOpen', 'discardOpen', 'setParams', 'open', 'close',
  'setDepthMap', 'releaseExport', 'dispose',
]);

export interface ServeOptions {
  /** Decoder untuk RPC `decode`; bawaan `io/decodeImage` (test menyuntik `wasmBinary` LibRaw). */
  decode?: (bytes: Uint8Array, name?: string) => Promise<DecodedImage>;
  /** Pesan yang tiba sebelum server terpasang (ditampung entry); dilayani lebih dulu, berurutan. */
  backlog?: ReadonlyArray<{ data?: unknown }>;
}

export function serveSession(
  port: MessagePortLike,
  factory: (init: SessionInit) => Promise<SessionLike>,
  options: ServeOptions = {},
): void {
  const decode = options.decode ?? ((bytes: Uint8Array, name?: string) => decodeImage(bytes, name));
  let session: Promise<SessionLike> | undefined;

  const reply = (response: RpcResponse, transfer: Transferable[] = []): void => {
    port.postMessage(response, transfer);
  };

  const handle = (event: { data?: unknown }): void => {
    const request = event.data as RpcRequest;
    void (async () => {
      try {
        let result: unknown;
        if (request.method === 'decode') {
          // Gambar hasil decode milik penerima saja: DITRANSFER, tidak disalin
          // (bisa ratusan MB untuk RAW besar).
          const image = await decode(...request.args);
          reply({ id: request.id, ok: true, result: image }, transferablesOf(image));
          return;
        }
        if (request.method === 'init') {
          session = factory(request.args[0] as SessionInit);
          await session;
        } else {
          if (!session) throw new Error(`RPC "${request.method}" sebelum "init".`);
          const target = await session;
          const method = target[request.method] as (...args: unknown[]) => unknown;
          result = await method.apply(target, request.args);
        }
        // Berkas ekspor tidak disimpan Session, jadi langsung DITRANSFER tanpa
        // salinan (dulu satu salinan seukuran berkas per encode). Hasil SEGAR
        // (allowlist di atas) juga langsung ditransfer; hasil yang di-cache
        // Session tetap disalin dulu supaya cache tidak ter-detach.
        const fresh = request.method === 'exportImage' || FRESH_RESULTS.has(request.method as SessionMethod);
        const copy = fresh ? result : cloneTypedArrays(result);
        reply({ id: request.id, ok: true, result: copy }, transferablesOf(copy));
      } catch (e) {
        reply({ id: request.id, ok: false, error: serializeError(e) });
      }
    })();
  };
  port.addEventListener('message', handle);
  for (const event of options.backlog ?? []) handle(event);
  port.start?.();
}

function serializeError(e: unknown): RpcError {
  if (e instanceof Error) {
    const data: Record<string, unknown> = {};
    for (const key of ['field', 'value', 'baseline', 'format', 'reason'] as const) {
      if (key in e) data[key] = (e as unknown as Record<string, unknown>)[key];
    }
    return { name: e.name, message: e.message, data };
  }
  return { name: 'Error', message: String(e) };
}

/** Pasang server `Session` di scope Dedicated Worker (dipanggil `worker.ts`). */
export function startWorker(scope: MessagePortLike, backlog: ReadonlyArray<{ data?: unknown }>): void {
  serveSession(scope, (init) => Session.create({ assetsBaseUrl: init.assetsBaseUrl,
    onDeviceLost: (error) => scope.postMessage({ id: 0, ok: false, error: serializeError(error) }),
  }), { backlog });
}
