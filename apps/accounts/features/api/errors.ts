// Account and Better Auth report failures as { code, message } or OAuth-style
// { error, error_description }. The UI needs a small set of outcomes, never the
// raw server text, so no message reveals whether an account exists.
export type FailureKind = 'invalid-credentials' | 'email-not-verified' | 'rate-limited'
  | 'not-enabled' | 'password-too-short' | 'password-too-long' | 'invalid-token'
  | 'expired-request' | 'unauthenticated' | 'stale' | 'conflict' | 'unavailable' | 'failed';

interface Failure { ok: false; kind: FailureKind; status: number }
export type Result<T> = { ok: true; data: T } | Failure;

const byCode: Record<string, FailureKind> = {
  INVALID_EMAIL_OR_PASSWORD: 'invalid-credentials',
  INVALID_PASSWORD: 'invalid-credentials',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'invalid-credentials',
  EMAIL_NOT_VERIFIED: 'email-not-verified',
  PASSWORD_TOO_SHORT: 'password-too-short',
  PASSWORD_TOO_LONG: 'password-too-long',
  INVALID_TOKEN: 'invalid-token',
  TOKEN_EXPIRED: 'invalid-token',
  RESET_PASSWORD_DISABLED: 'not-enabled',
  VERIFICATION_EMAIL_NOT_ENABLED: 'not-enabled',
  CHANGE_EMAIL_DISABLED: 'not-enabled',
  EMAIL_PASSWORD_SIGN_UP_DISABLED: 'not-enabled',
  // Sensitive reads and changes need a session signed in within the last day.
  SESSION_EXPIRED: 'stale',
  SESSION_NOT_FRESH: 'stale',
};

export function classifyFailure(status: number, body: unknown): FailureKind {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code : undefined;
  const error = typeof record.error === 'string' ? record.error : undefined;
  const message = typeof record.message === 'string' ? record.message : '';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'unavailable';
  if (code && byCode[code]) return byCode[code];
  if (error === 'invalid_signature' || error === 'invalid_request' && status === 400) return 'expired-request';
  if (/isn't enabled|is disabled/i.test(message)) return 'not-enabled';
  if (status === 404) return 'not-enabled';
  if (status === 401) return 'unauthenticated';
  if (status === 409 || code === 'CONFLICT') return 'conflict';
  return 'failed';
}
