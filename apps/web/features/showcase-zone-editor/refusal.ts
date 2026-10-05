// What saving a Zone's showcase came to, sorted by what a person can do about it. Main's problem
// codes (services/main/src/routes/zones.ts `routeError`, `PUT /v1/zones/{id}/configuration`) carry
// the reason; this only gives each kind its own words. Refusals of one campaign image go through
// the Work art editor's `refusalOf`: they are the same media refusals.

export type ConfigurationRefusal =
  | 'sign-in'
  /** No authority to edit this Zone. */
  | 'denied'
  /** The Zone can no longer be read as this identity, or is gone. */
  | 'gone'
  /** The Zone changed since the person started: reload, never overwrite. */
  | 'conflict'
  /** Main refused the document; `detail` is its own reason. */
  | 'invalid'
  /** The same key was used for a different save. */
  | 'repeat'
  | 'limited'
  /** Main has not finished applying it; saving the same thing again replays it. */
  | 'pending'
  | 'unavailable';

export type ConfigurationSave =
  | { status: 'done'; revision: string; replayed: boolean }
  | { status: 'refused'; refusal: ConfigurationRefusal; code: string | null; detail: string | null; retryAfter?: number };

export function configurationRefusalOf(error: { status: number; value?: unknown }, retryAfter: number | null = null): ConfigurationSave {
  const value = typeof error.value === 'object' && error.value !== null ? error.value as Record<string, unknown> : {};
  const code = typeof value.code === 'string' ? value.code : null;
  const detail = typeof value.detail === 'string' && value.detail ? value.detail
    : typeof value.title === 'string' && value.title ? value.title : null;
  const refusal: ConfigurationRefusal = error.status === 401 ? 'sign-in'
    : error.status === 403 ? 'denied'
      : error.status === 404 ? 'gone'
        : error.status === 429 ? 'limited'
          : error.status === 409 ? (code === 'stale_zone_head' || code === 'zone_conflict' ? 'conflict' : 'repeat')
            : error.status === 400 || error.status === 413 || error.status === 422 ? 'invalid' : 'unavailable';
  return { status: 'refused', refusal, code, detail, ...(retryAfter ? { retryAfter } : {}) };
}

/** A save's answer: the new revision, a pending operation, or Main's refusal. */
export function configurationSaveOf(answer: { data: unknown; error: { status: number; value?: unknown } | null; headers?: unknown }): ConfigurationSave {
  if (answer.error) return configurationRefusalOf(answer.error, retryAfterOf(answer.headers));
  const data = typeof answer.data === 'object' && answer.data !== null ? answer.data as Record<string, unknown> : {};
  if (typeof data.revision === 'string') return { status: 'done', revision: data.revision, replayed: data.replayed === true };
  return { status: 'refused', refusal: 'operationId' in data ? 'pending' : 'unavailable', code: null, detail: null };
}

export const retryAfterOf = (headers: unknown) => {
  const value = headers instanceof Headers ? headers.get('retry-after')
    : typeof headers === 'object' && headers !== null ? (headers as Record<string, unknown>)['retry-after'] : null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};
