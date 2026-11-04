import { failureMessage, type AuthPostResult } from './api';

// Only the mounted attempt owns this submission. Never store it or use it as
// native success/cancellation evidence. The token and password bind one effect.
export type RecoverySubmission = Readonly<{ account_id: string; token: string; new_password: string }>;

export function recoverySubmission(accountId: string, token: string, password: string): RecoverySubmission {
  return Object.freeze({ account_id: accountId, token, new_password: password });
}

export function definitiveRecoveryRefusal(result: Exclude<AuthPostResult, { ok: true }>): boolean {
  return (
    (result.status === 400 && ['invalid_request', 'invalid_password', 'authentication_denied'].includes(result.code)) ||
    (result.status === 401 && ['invalid_recovery', 'authentication_denied'].includes(result.code)) ||
    (result.status === 429 && result.code === 'rate_limited')
  );
}

export function recoveryFailure(result: Exclude<AuthPostResult, { ok: true }>): string {
  // The real native handler uses authentication_denied for both validation
  // refusals; the browser HTTP fixtures also exercise the more specific codes.
  const code = result.code === 'authentication_denied'
    ? result.status === 400 ? 'invalid_password' : result.status === 401 ? 'invalid_recovery' : result.code
    : result.code;
  return failureMessage(result.status, code, result.retryAfter);
}
