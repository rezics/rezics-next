import type { KernelClient } from '@rezics/client';
import { SESSION_HEADER } from '@rezics/client';
import {
  reporterHistoryPage,
  reporterHistoryQuery,
  type ReporterHistoryPage,
  type ReporterHistoryQuery,
} from './model';
export type ReporterHistoryResult =
  | { state: 'loaded'; page: ReporterHistoryPage; nativeSourceFingerprint: string }
  | { state: 'denied' | 'expired' | 'unavailable' };

/** One mounted generated-client own read, with no account selector, target hydration or moderator endpoint. */
export async function loadReporterHistory(
  client: Pick<KernelClient, 'reports'>,
  operands: ReporterHistoryQuery,
  signal?: AbortSignal,
): Promise<ReporterHistoryResult> {
  const query = reporterHistoryQuery(operands);
  try {
    signal?.throwIfAborted();
    const response = await client.reports.me.get({
      query,
      fetch: { cache: 'no-store', ...(signal ? { signal } : {}) },
    });
    if (response.error) {
      if ([401, 403, 404].includes(response.status))
        return { state: 'denied' };
      const value: unknown = response.error.value;
      const code = value && typeof value === 'object' && 'code' in value ? value.code : undefined;
      if (
        (response.status === 400 || response.status === 409) &&
        (code === 'invalid_cursor' || code === 'stale_cursor')
      )
        return { state: 'expired' };
      return { state: 'unavailable' };
    }
    if (!response.data) return { state: 'unavailable' };
    const nativeSession = response.response.headers.get(SESSION_HEADER);
    if (!nativeSession) return { state: 'unavailable' };
    const page = reporterHistoryPage(response.data, query);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(['reporter-history-source', nativeSession])),
    );
    signal?.throwIfAborted();
    return {
      state: 'loaded',
      page,
      nativeSourceFingerprint: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      ),
    };
  } catch {
    return { state: 'unavailable' };
  }
}
