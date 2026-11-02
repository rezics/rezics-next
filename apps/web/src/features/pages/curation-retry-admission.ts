import { searchRetryAt } from '../../search/search-recovery-retry';

/** Capture one absolute deadline from a native Retry-After seconds hint. Re-reads do not recapture. */
export function publicationRetryAt(retryAfter: number | undefined, now = Date.now()): number | undefined {
  if (retryAfter === undefined || !Number.isFinite(retryAfter) || retryAfter < 0) return;
  return searchRetryAt(String(Math.ceil(retryAfter)), now);
}

/** Publication retry is withheld until the captured native deadline. Inspect stays independent. */
export function admitPublicationRetry(retryAt: number | undefined, now = Date.now()): boolean {
  return retryAt === undefined || retryAt <= now;
}
