import {
  isRecoveryAcknowledgement,
  isRecoveryNativeError,
  recoveryResponseByteBounds,
  type RecoveryAcknowledgement,
} from '@rezics/auth-contract';
import { failureMessage, type AuthPostResult } from './api';
import { privateAuthRead } from './private-auth-read';
import { readJsonBounded } from './private-auth-json';

// Only the mounted attempt owns this submission. Never store it or use it as
// native success/cancellation evidence. The token and password bind one effect.
export type RecoverySubmission = Readonly<{ account_id: string; token: string; new_password: string }>;
export type RecoveryStartSubmission = Readonly<{ email: string }>;
export type RecoveryCommandResult = AuthPostResult<RecoveryAcknowledgement>;

const unavailable = (): RecoveryCommandResult => ({
  ok: false,
  status: 503,
  code: 'unavailable',
  retryAfter: null,
});
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const compatibleFixtureCodes = {
  start: { 400: ['invalid_request'], 429: ['rate_limited'], 503: ['unavailable'] },
  complete: {
    400: ['invalid_password'],
    401: ['invalid_recovery'],
    429: ['rate_limited'],
    503: ['unavailable'],
  },
} as const;

function compatibleFailure(phase: 'start' | 'complete', status: number, value: unknown): string | null {
  if (isRecoveryNativeError(value, status) && (phase === 'complete' || status !== 401)) return 'authentication_denied';
  if (!record(value) || Object.keys(value).length !== 1 || typeof value.code !== 'string') return null;
  const codes = compatibleFixtureCodes[phase][status as keyof (typeof compatibleFixtureCodes)[typeof phase]];
  return codes?.includes(value.code as never) ? value.code : null;
}

async function submitRecovery(
  phase: 'start' | 'complete',
  submission: RecoveryStartSubmission | RecoverySubmission,
): Promise<RecoveryCommandResult> {
  try {
    return await privateAuthRead(async (signal) => {
      const response = await fetch(`/recovery/${phase}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
        signal,
      });
      const value = await readJsonBounded(
        response,
        response.status === 200 ? recoveryResponseByteBounds.acknowledgement : recoveryResponseByteBounds.nativeError,
        signal,
      );
      if (response.status === 200) return isRecoveryAcknowledgement(value) ? { ok: true, body: value } : unavailable();
      const code = compatibleFailure(phase, response.status, value);
      if (!code) return unavailable();
      const retryAfter = response.headers.get('Retry-After');
      return {
        ok: false,
        status: response.status,
        code,
        retryAfter: response.status === 429 && retryAfter && /^\d+$/.test(retryAfter) ? retryAfter : null,
      };
    });
  } catch {
    // Once dispatched, transport, stream and decoding errors do not establish refusal.
    return unavailable();
  }
}

export function startRecovery(submission: RecoveryStartSubmission): Promise<RecoveryCommandResult> {
  return submitRecovery('start', submission);
}

export function completeRecovery(submission: RecoverySubmission): Promise<RecoveryCommandResult> {
  return submitRecovery('complete', submission);
}

export function recoverySubmission(accountId: string, token: string, password: string): RecoverySubmission {
  return Object.freeze({ account_id: accountId, token, new_password: password });
}

export function definitiveRecoveryRefusal(result: Exclude<AuthPostResult, { ok: true }>): boolean {
  return (
    (result.status === 400 && ['invalid_request', 'invalid_password', 'authentication_denied'].includes(result.code)) ||
    (result.status === 401 && ['invalid_recovery', 'authentication_denied'].includes(result.code)) ||
    (result.status === 429 && ['authentication_denied', 'rate_limited'].includes(result.code))
  );
}

export function recoveryFailure(
  result: Exclude<AuthPostResult, { ok: true }>,
  phase: 'start' | 'complete' = 'complete',
): string {
  // The real native handler uses authentication_denied for both validation
  // refusals; the browser HTTP fixtures also exercise the more specific codes.
  const code =
    result.status === 429 && result.code === 'authentication_denied'
      ? 'rate_limited'
      : result.code === 'authentication_denied'
        ? result.status === 400 && phase === 'complete'
          ? 'invalid_password'
          : result.status === 401
            ? 'invalid_recovery'
            : result.code
        : result.code;
  return failureMessage(result.status, code, result.retryAfter);
}
