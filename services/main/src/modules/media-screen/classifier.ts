import { fileURLToPath } from 'node:url';
import { SCREEN_LIMITS, screenVerdict, type Scores } from './policy.ts';

export interface ImageClassifier { classify(bytes: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<Scores> }

/** Each decode and inference has its own OS process. Native decoder crashes,
 * timeouts and aborts cannot terminate Main or leave an inference running. */
export class LocalImageClassifier implements ImageClassifier {
  constructor(private readonly timeoutMs: number = SCREEN_LIMITS.timeoutMs) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SCREEN_LIMITS.timeoutMs) throw new Error('invalid screen deadline');
  }
  classify(bytes: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<Scores> {
    return classifyInProcess(bytes, mediaType, this.timeoutMs, signal);
  }
}

/** Internal process boundary; the entry point is injectable only for fatal-exit
 * and unresponsive-child tests. It is never read from a request or configuration. */
export async function classifyInProcess(bytes: Uint8Array, mediaType: string, timeoutMs: number,
  signal?: AbortSignal, entryPoint = new URL('./classifier-process.ts', import.meta.url)): Promise<Scores> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SCREEN_LIMITS.timeoutMs) throw new Error('invalid screen deadline');
  signal?.throwIfAborted();
  if (!bytes.byteLength || bytes.byteLength > SCREEN_LIMITS.bytes) throw new Error('screen byte bound exceeded');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) throw new Error('invalid screen media type');
  let scores: Scores | undefined;
  let invalid = false;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--smol', fileURLToPath(entryPoint), mediaType], {
    // No Main credentials or model download configuration enter the decoder.
    env: {}, stdin: bytes, stdout: 'ignore', stderr: 'ignore',
    ipc(message: unknown) {
      try {
        if (scores) throw new Error('duplicate screen result');
        screenVerdict(message as Scores);
        scores = message as Scores;
      } catch { invalid = true; child.kill('SIGKILL'); }
    },
  });
  let expired = false;
  const kill = () => { child.kill('SIGKILL'); };
  const timer = setTimeout(() => { expired = true; kill(); }, timeoutMs);
  signal?.addEventListener('abort', kill, { once: true });
  // Abort may arrive between the initial check and listener registration.
  if (signal?.aborted) kill();
  try {
    const exit = await child.exited;
    if (expired || signal?.aborted || exit !== 0 || invalid || !scores) throw new Error('local classifier unavailable');
    return scores;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
    if (child.exitCode === null) kill();
    await child.exited;
  }
}
