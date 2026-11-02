import { searchRetryAt } from './search-recovery-retry';

/** Absolute native retry instant; a minimum delay, never a request schedule. */
export type RecentRetryDeadline = number;
export type RecentRetryAdmission = { retryAt?: RecentRetryDeadline };

export function admitRecentRetryDeadline(
  hint: string | null | undefined,
  now = Date.now(),
): RecentRetryDeadline | undefined {
  return searchRetryAt(hint ?? null, now);
}

export function admitRecentRetryHeaders(
  headers: HeadersInit | undefined,
  now = Date.now(),
): RecentRetryDeadline | undefined {
  if (headers === undefined) return;
  try {
    return admitRecentRetryDeadline(new Headers(headers).get('retry-after'), now);
  } catch {
    return;
  }
}

export function recentRetryDeadlineBlocks(deadline: RecentRetryDeadline | undefined, now = Date.now()): boolean {
  return deadline !== undefined && deadline > now;
}
