import { SCREEN_LIMITS, type Scores } from './policy.ts';

export interface ImageClassifier { classify(bytes: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<Scores> }
/** CPU inference stays off Main's event loop. Each bounded invocation terminates
 * its isolate, including on timeout, so a stalled model cannot keep consuming work. */
export class LocalImageClassifier implements ImageClassifier {
  constructor(private readonly timeoutMs: number = SCREEN_LIMITS.timeoutMs) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SCREEN_LIMITS.timeoutMs) throw new Error('invalid screen deadline');
  }
  async classify(bytes: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<Scores> {
    signal?.throwIfAborted();
    if (!bytes.byteLength || bytes.byteLength > SCREEN_LIMITS.bytes) throw new Error('screen byte bound exceeded');
    const worker = new Worker(new URL('./classifier-worker.ts', import.meta.url).href, { smol: true, ref: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: ((error: Error) => void) | undefined;
    const abort = () => {
      worker.terminate();
      if (timer) clearTimeout(timer);
      rejectAbort?.(new Error('screen cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise<Scores>((resolve, reject) => {
        rejectAbort = reject;
        timer = setTimeout(() => reject(new Error('screen deadline exceeded')), this.timeoutMs);
        worker.onmessage = (event: MessageEvent<{ scores?: Scores; error?: string }>) => {
          clearTimeout(timer);
          if (event.data.scores) resolve(event.data.scores);
          else reject(new Error('local classifier unavailable'));
        };
        worker.onerror = () => { clearTimeout(timer); reject(new Error('local classifier unavailable')); };
        worker.postMessage({ bytes, mediaType });
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    }
  }
}
