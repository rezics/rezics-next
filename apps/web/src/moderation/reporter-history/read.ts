import {
  reporterHistoryPage,
  reporterHistoryQuery,
  type ReporterHistoryPage,
  type ReporterHistoryQuery,
} from './model';
export type ReporterHistoryResult =
  | { state: 'loaded'; page: ReporterHistoryPage; nativeSourceFingerprint: string }
  | { state: 'denied' | 'expired' | 'unavailable' };

/** Named minimal local consumer seam: one mounted own read, no account selector,
 * target hydration, moderator endpoint, fabricated provenance or installed typing claim. */
export async function loadReporterHistory(
  origin: string,
  authorization: string,
  operands: ReporterHistoryQuery,
  send: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ReporterHistoryResult> {
  const query = reporterHistoryQuery(operands);
  const url = new URL('/v1/reports/me', origin);
  if (query.cursor !== undefined) url.searchParams.set('cursor', query.cursor);
  if (query.reportId !== undefined) url.searchParams.set('reportId', query.reportId);
  try {
    signal?.throwIfAborted();
    const response = await send(url, {
      method: 'GET',
      headers: { authorization },
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if ([401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      return { state: 'denied' };
    }
    if (!response.ok) {
      const problem: unknown = await response.json();
      if (
        (response.status === 400 || response.status === 409) &&
        problem &&
        typeof problem === 'object' &&
        'code' in problem &&
        (problem.code === 'invalid_cursor' || problem.code === 'stale_cursor')
      )
        return { state: 'expired' };
      return { state: 'unavailable' };
    }
    const nativeSession = response.headers.get('rezics-session-token');
    if (!nativeSession) {
      await response.body?.cancel();
      return { state: 'unavailable' };
    }
    const page = reporterHistoryPage(await response.json(), query);
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
