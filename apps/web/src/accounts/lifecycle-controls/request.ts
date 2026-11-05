import { readWithin } from '../management/read-deadline';
import type { Outcome, Page } from './data';

// Match account management's ten-second native read convention. Each native phase
// gets its own bound; the BFF envelope allows all three plus delivery overhead.
export const LIFECYCLE_WAIT_MS = 10_000;
const COMMAND_WAIT_MS = 3 * LIFECYCLE_WAIT_MS + 5_000;
export { readWithin };

export async function reviewRequest(read: (signal: AbortSignal) => Promise<Page>, caller?: AbortSignal): Promise<Page> {
  try {
    return await readWithin(read, caller, LIFECYCLE_WAIT_MS);
  } catch {
    return { status: 'unavailable' };
  }
}

export async function commandRequest(
  change: (signal: AbortSignal) => Promise<Outcome>,
  caller?: AbortSignal,
): Promise<Outcome> {
  try {
    return await readWithin(change, caller, COMMAND_WAIT_MS);
  } catch {
    // Cancellation cannot establish whether the native command took effect.
    return { status: 'uncertain', current: { status: 'unavailable' } };
  }
}
