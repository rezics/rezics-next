// Account and Better Auth report failures as { code, message } or OAuth-style
// { error, error_description }. The UI needs a small set of outcomes, never the
// raw server text, so no message reveals whether an account exists.
export type FailureKind = 'invalid-credentials' | 'email-not-verified' | 'rate-limited'
  | 'not-enabled' | 'password-too-short' | 'password-too-long' | 'invalid-token'
  | 'expired-request' | 'unauthenticated' | 'stale' | 'conflict' | 'unavailable' | 'failed'
  // A sensitive change needs the person to confirm it's them first.
  | 'step-up-required'
  // Removing this would leave no way to sign in.
  | 'last-method'
  | 'invalid-code'
  // The browser's passkey prompt was dismissed, timed out or is unsupported.
  | 'cancelled'
  // Registration declarations and content qualification.
  | 'minimum-age-confirmation-required' | 'invalid-birth-date' | 'birth-date-required' | 'age-ineligible' | 'market-restricted' | 'market-unavailable'
  | 'policy-acceptance-required';

interface Failure { ok: false; kind: FailureKind; status: number; minimumAge?: number }
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
  STEP_UP_REQUIRED: 'step-up-required',
  INVALID_CODE: 'invalid-code',
  INVALID_BACKUP_CODE: 'invalid-code',
  // The two-factor challenge from the password step has expired.
  INVALID_TWO_FACTOR_COOKIE: 'stale',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'rate-limited',
  ACCOUNT_TEMPORARILY_LOCKED: 'rate-limited',
  PASSKEY_NOT_FOUND: 'invalid-credentials',
  AUTHENTICATION_FAILED: 'invalid-credentials',
  USER_VERIFICATION_REQUIRED: 'invalid-credentials',
  CHALLENGE_NOT_FOUND: 'stale',
};

// The Account service's own routes answer `{ error: <code> }`.
const byError: Record<string, FailureKind> = {
  step_up_required: 'step-up-required',
  last_sign_in_method: 'last-method',
  stale_request: 'stale',
  stale_credential_session: 'stale',
  unauthenticated: 'unauthenticated',
};

// Account's sign-up admission answers `{ reason, minimumAge }` (market-policy.ts).
const byReason: Record<string, FailureKind> = {
  minimum_age_confirmation_required: 'minimum-age-confirmation-required',
  invalid_birth_date: 'invalid-birth-date',
  birth_date_required: 'birth-date-required',
  age_ineligible: 'age-ineligible',
  market_restricted: 'market-restricted',
  market_unavailable: 'market-unavailable',
  policy_acceptance_required: 'policy-acceptance-required',
};

/** The minimum age accompanying Account's registration declaration requirement. */
export function refusedMinimumAge(body: unknown): number | undefined {
  const age = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).minimumAge : undefined;
  return typeof age === 'number' && Number.isInteger(age) ? age : undefined;
}

export function classifyFailure(status: number, body: unknown): FailureKind {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code : undefined;
  const error = typeof record.error === 'string' ? record.error : undefined;
  const message = typeof record.message === 'string' ? record.message : '';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'unavailable';
  const reason = typeof record.reason === 'string' ? record.reason : error;
  if (reason && byReason[reason]) return byReason[reason];
  if (code && byCode[code]) return byCode[code];
  if (error && byError[error]) return byError[error];
  if (error === 'invalid_signature' || error === 'invalid_request' && status === 400) return 'expired-request';
  if (/isn't enabled|is disabled/i.test(message)) return 'not-enabled';
  if (status === 404) return 'not-enabled';
  if (status === 401) return 'unauthenticated';
  if (status === 409 || code === 'CONFLICT') return 'conflict';
  return 'failed';
}
