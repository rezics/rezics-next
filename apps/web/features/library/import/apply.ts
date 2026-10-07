import { ImportError, type ApplyIntent, type ApplyProgress, type ImportApi } from '../import-api.ts';
import { abortable, pauseForImport } from './lifetime.ts';

export const APPLY_POLL_WINDOW_MS = 30_000;
export const APPLY_POLL_LIMIT = 16;

/** Submit once, then read the server-owned job. A local deadline leaves its last truthful progress intact. */
export async function pollLibraryApply(api: Pick<ImportApi, 'apply' | 'status'>, id: string, intent: ApplyIntent, {
  onProgress, active, wait = pauseForImport, signal, checkOnly = false, resume = false,
}: {
  onProgress: (progress: ApplyProgress) => void;
  active: () => boolean;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  checkOnly?: boolean;
  resume?: boolean;
}): Promise<ApplyProgress | null> {
  if (!active() || signal?.aborted) return null;
  const deadline = AbortSignal.timeout(APPLY_POLL_WINDOW_MS);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let latest: ApplyProgress | null = null, waited = 0;
  try {
    for (let poll = 0; poll < APPLY_POLL_LIMIT && active(); poll++) {
      bounded.throwIfAborted();
      const progress = await abortable((poll > 0 || checkOnly) && api.status
        ? api.status(id, { signal: bounded }) : api.apply(id, intent, { signal: bounded, resume }), bounded);
      if (!active() || signal?.aborted) return null;
      latest = progress;
      onProgress(progress);
      if (!progress.pending || progress.state === 'failed' || progress.state === 'stalled') return progress;
      const delay = Math.min(1000 * 2 ** poll, 5000);
      if (waited + delay >= APPLY_POLL_WINDOW_MS || poll + 1 === APPLY_POLL_LIMIT) return latest;
      await abortable(wait(delay, bounded), bounded);
      waited += delay;
    }
  } catch (failure) {
    if (!active() || signal?.aborted) return null;
    if (deadline.aborted || failure instanceof ImportError && (failure.failure === 'admission' || failure.failure === 'pending')) {
      if (latest) return latest;
      throw failure;
    }
    throw failure;
  }
  return active() ? latest : null;
}
