import { searchRetryAt } from './search-recovery-retry';
import type { RecentRetryAdmission, RecentRetryDeadline } from './recent-contract';
export type { RecentRetryAdmission, RecentRetryDeadline };

export function admitRecentRetryDeadline(
  hint: string | null | undefined,
  now: number,
): RecentRetryDeadline | undefined {
  return searchRetryAt(hint ?? null, now);
}

export function admitRecentRetryHeaders(
  headers: HeadersInit | undefined,
  now: number,
): RecentRetryDeadline | undefined {
  if (headers === undefined) return;
  try {
    return admitRecentRetryDeadline(new Headers(headers).get('retry-after'), now);
  } catch {
    return;
  }
}

export function recentRetryDeadlineBlocks(deadline: RecentRetryDeadline | undefined, now: number): boolean {
  return deadline !== undefined && deadline > now;
}
