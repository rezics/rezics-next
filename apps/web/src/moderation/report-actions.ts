export type ReportActionFailure = 'conflict' | 'forbidden' | 'sign-in' | 'unavailable' | 'error';
export type ReportActionResult = { ok: true } | { ok: false; state: ReportActionFailure };

/** Only public native status/code categories cross the server-function boundary. */
export function reportActionResult(status: number, error: unknown): ReportActionResult {
  if (!error && status >= 200 && status < 300) return { ok: true };
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (status === 409 || status === 412 || (status === 422 && code === 'idempotency_conflict'))
    return { ok: false, state: 'conflict' };
  if (status === 403) return { ok: false, state: 'forbidden' };
  if (status === 401) return { ok: false, state: 'sign-in' };
  if (status === 404) return { ok: false, state: 'unavailable' };
  throw new Error('The moderation action could not be completed');
}
