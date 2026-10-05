import { SeedApiError, type SeedApi } from './api.ts';
import { isIdempotencyConflict } from './realms-step.ts';
import type { WorkReceipt } from './state.ts';

/**
 * Kinds that became administrator-created had their Works made again under the administrator's principal, so a
 * long-lived stack holds two Works per plan item: the earlier one, made by the author, which carries the Contribution,
 * its publication, selection and replies, and the new one, which is empty and not public. Keys bind the Work, so the
 * earlier Contribution's key conflicts on the new Work. That conflict is the evidence that an earlier Work exists:
 * the author's own creation key replays it, and it stays the plan's Work instead of a second public copy.
 * `bodies` are the creation intents, newest first, as the Work's seed recorded them over time.
 */
export async function replayEarlierWork(api: SeedApi, bodies: readonly Record<string, unknown>[],
  token: string, key: string): Promise<WorkReceipt | null> {
  for (const body of bodies) {
    try {
      const receipt = await api.post<WorkReceipt>('/v1/works', body, token, key);
      return receipt.replayed ? receipt : null;
    } catch (error) {
      if (!(error instanceof SeedApiError)) throw error;
      if (!isIdempotencyConflict(error)) return null;
    }
  }
  return null;
}

/** Runs `write` on `target`; if its keys conflict because an earlier Work holds them, runs it on that Work. */
export async function onEarlierWork<T>(target: WorkReceipt, earlier: () => Promise<WorkReceipt | null>,
  write: (work: WorkReceipt) => Promise<T>): Promise<{ work: WorkReceipt; result: T }> {
  try { return { work: target, result: await write(target) }; }
  catch (error) {
    if (!isIdempotencyConflict(error)) throw error;
    const work = await earlier();
    if (!work || work.work === target.work) throw error;
    return { work, result: await write(work) };
  }
}
