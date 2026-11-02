import { searchRetryAt } from '../../search/search-recovery-retry';

/** Capture one absolute inspection deadline from native Retry-After seconds. */
export function curationInspectionRetryAt(retryAfter: number | undefined, now = Date.now()): number | undefined {
  if (retryAfter === undefined || !Number.isFinite(retryAfter) || retryAfter < 0) return;
  return searchRetryAt(String(Math.ceil(retryAfter)), now);
}

/** Inspection remains manual; this only admits it once the native deadline has passed. */
export function admitCurationInspection(retryAt: number | undefined, now = Date.now()): boolean {
  return retryAt === undefined || retryAt <= now;
}
