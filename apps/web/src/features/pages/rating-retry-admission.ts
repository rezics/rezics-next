import { searchRetryAt } from '../../search/search-recovery-retry';

/** Admit native Retry-After text. A minimum delay, never a schedule. */
export function admitRatingRetryAfter(headers: unknown, now = Date.now()): string | undefined {
  if (headers === undefined || headers === null) return;
  try {
    const hint = new Headers(headers as HeadersInit).get('retry-after');
    if (hint === null) return;
    return searchRetryAt(hint, now) === undefined ? undefined : hint;
  } catch {
    return;
  }
}

/** Capture one absolute deadline from admitted native Retry-After. Re-reads do not recapture. */
export function ratingRetryAt(retryAfter: string | undefined, now = Date.now()): number | undefined {
  return searchRetryAt(retryAfter ?? null, now);
}

/** Native rating retry is withheld until the captured deadline. */
export function admitRatingRetry(retryAt: number | undefined, now = Date.now()): boolean {
  return retryAt === undefined || retryAt <= now;
}
