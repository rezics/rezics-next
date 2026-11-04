import { m } from './paraglide/messages.js';

export const RECOVERY_COMPLETE_NOTICE_KEY = 'auth.recovery.complete';
// Match Auth's existing five-second issuer transport bound, including JSON consumption.
export const AUTH_POST_TIMEOUT_MS = 5000;

export type AuthPostResult<Body = unknown> =
  | { ok: true; body: Body }
  | { ok: false; status: number; code: string; retryAfter: string | null; effectStatus?: 'not_applied' };

export async function authPost<Body = unknown>(path: string, body: unknown): Promise<AuthPostResult<Body>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AuthPostResult<Body>>((resolve) => {
    timer = setTimeout(() => {
      // Settle waiting even if the transport does not honour abort. Native work may still finish.
      resolve({ ok: false, status: 503, code: 'timeout', retryAfter: null });
      controller.abort();
    }, AUTH_POST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([post<Body>(path, body, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function post<Body>(path: string, body: unknown, signal: AbortSignal): Promise<AuthPostResult<Body>> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 200) return { ok: true, body: (await response.json()) as Body };

    const errorBody: unknown = await response.json().catch(() => null);
    const errorCode =
      errorBody && typeof errorBody === 'object'
        ? 'code' in errorBody && typeof errorBody.code === 'string'
          ? errorBody.code
          : 'error' in errorBody && typeof errorBody.error === 'string'
            ? errorBody.error
            : ''
        : '';
    const effectStatus =
      errorBody &&
      typeof errorBody === 'object' &&
      'effect_status' in errorBody &&
      errorBody.effect_status === 'not_applied'
        ? 'not_applied'
        : undefined;
    const header = response.headers.get('Retry-After');
    return {
      ok: false,
      status: response.status,
      code: errorCode,
      retryAfter: header && /^\d+$/.test(header) ? header : null,
      ...(effectStatus ? { effectStatus } : {}),
    };
  } catch {
    return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
  }
}

export function failureMessage(status: number, code: string, retryAfter: string | null): string {
  if (status === 400 && code === 'invalid_request') return m.auth_recovery_input_invalid();
  if (status === 400 && code === 'invalid_password') return m.auth_recovery_password_invalid();
  if (status === 401 && code === 'authentication_denied') return m.auth_login_invalid_credentials();
  if (status === 401 && code === 'invalid_recovery') return m.auth_recovery_link_invalid();
  if (status === 429 && code === 'rate_limited') {
    return retryAfter === null ? m.auth_failure_rate_limited() : m.auth_failure_retry_after({ seconds: retryAfter });
  }
  if (status === 503 && code === 'unavailable') return m.auth_failure_unavailable();
  return m.auth_failure_unavailable();
}
