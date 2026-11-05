import { readWithin } from '../management/read-deadline';
import type { AccessState, Identity, WriteResult } from './data';
import type { TransferResult } from './owner-transfer';

// Match account management. Bound headers AND decoding, even if a transport ignores abort.
export const ACCESS_WAIT_MS = 10_000;
export const reviewWithin = <T>(read: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal) =>
  readWithin(read, caller, ACCESS_WAIT_MS);

// BFF envelopes include every sequential native phase plus delivery overhead.
export async function reviewRequest(read: (signal: AbortSignal) => Promise<AccessState>, caller?: AbortSignal) {
  try {
    return await readWithin(read, caller, ACCESS_WAIT_MS + 5_000);
  } catch {
    return { status: 'unavailable' as const };
  }
}

export function recipientRequest(read: (signal: AbortSignal) => Promise<Identity | null>, caller?: AbortSignal) {
  return readWithin(read, caller, 2 * ACCESS_WAIT_MS + 5_000);
}

export async function grantRequest(write: (signal: AbortSignal) => Promise<WriteResult>, caller?: AbortSignal) {
  try {
    return await readWithin(write, caller, 2 * ACCESS_WAIT_MS + 5_000);
  } catch {
    // Aborting a dispatched write does not establish that it had no effect.
    return { status: 'uncertain' as const };
  }
}

export async function transferRequest(write: (signal: AbortSignal) => Promise<TransferResult>, caller?: AbortSignal) {
  try {
    return await readWithin(write, caller, 3 * ACCESS_WAIT_MS + 5_000);
  } catch {
    return { status: 'uncertain' as const, current: { status: 'unavailable' as const } };
  }
}
