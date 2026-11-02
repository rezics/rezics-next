import { searchRetryAt } from '../../search/search-recovery-retry';
import type { Section } from './overview';

/** Native Retry-After text from outer or leaf headers. Search captures the absolute deadline once. */
export function relationRetryAfter(headers: unknown): string | undefined {
  if (headers == null) return;
  try {
    const value = new Headers(headers as HeadersInit).get('retry-after');
    return value?.trim() ? value : undefined;
  } catch {
    return;
  }
}

export function admitRelationRetryAt(hint: string | null | undefined, now = Date.now()): number | undefined {
  return searchRetryAt(hint ?? null, now);
}

export function relationRetryBlocks(retryAt: number | undefined, now = Date.now()): boolean {
  return retryAt !== undefined && retryAt > now;
}

export function sectionFailure(status?: number, retryAfter?: string): Extract<Section, { ok: false }> {
  return { ok: false, status, ...(retryAfter ? { retryAfter } : {}) };
}

export function relationRetryAfterFromCause(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return;
  const record = cause as Record<string, unknown>;
  if (typeof record.retryAfter === 'string') return record.retryAfter.trim() ? record.retryAfter : undefined;
  return relationRetryAfter(record.headers);
}
