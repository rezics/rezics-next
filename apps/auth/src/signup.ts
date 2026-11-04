import { authPost, failureMessage } from './api';
import type { SignInResult } from './sign-in';
import { m } from './paraglide/messages.js';

export type SignupBody = {
  key: string;
  handle: string;
  email: string;
  password: string;
  turnstile_token: string;
};

export type SignupFailure =
  | { kind: 'local-password'; field: 'password'; message: string }
  | {
      kind: 'request-rejected';
      status: 400;
      code: 'registration_denied';
      retryAfter: null;
      message: string;
    }
  | {
      kind: 'handle-unavailable';
      status: 409;
      code: 'handle_unavailable';
      retryAfter: null;
      message: string;
    }
  | { kind: 'conflict'; status: 409; code: string; retryAfter: null; message: string }
  | { kind: 'rate-limited'; status: 429; code: string; retryAfter: string | null; message: string }
  | { kind: 'uncertain'; status: number; code: string; retryAfter: string | null; message: string };

export type SignupSubmission = { ok: true } | { ok: false; failure: SignupFailure };
export type SignupPasswordLimits = { minLength: number; maxLength: number };

export function createSignupKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function passwordAccepted(password: string, limits: SignupPasswordLimits): boolean {
  return password.length >= limits.minLength && password.length <= limits.maxLength;
}

// Matches the kernel's handle contract; the server applies the same normalization on signup.
export function normalizeSignupHandle(handle: string): string | null {
  const normalized = handle.toLowerCase();
  // Require the entire input: JavaScript's $ can also match before a final line terminator.
  return /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.exec(normalized)?.[0] === normalized ? normalized : null;
}

export async function submitSignup(input: SignupBody, limits: SignupPasswordLimits): Promise<SignupSubmission> {
  if (!passwordAccepted(input.password, limits)) {
    return {
      ok: false,
      failure: {
        kind: 'local-password',
        field: 'password',
        message: m.auth_signup_password_invalid({
          minimum: String(limits.minLength),
          maximum: String(limits.maxLength),
        }),
      },
    };
  }
  const result = await authPost<{ accountId: string }>('/signup', input);
  // The shared client treats only HTTP 200 as success. Registration answers 201 and issues no session.
  if (result.ok || (!result.ok && result.status === 201)) return { ok: true };
  return { ok: false, failure: explainSignup(result.status, result.code, result.retryAfter) };
}

export function explainSignup(status: number, code: string, retryAfter: string | null): SignupFailure {
  if (status === 400 && code === 'registration_denied') {
    return {
      kind: 'request-rejected',
      status,
      code,
      retryAfter: null,
      message: m.auth_signup_denied(),
    };
  }
  if (status === 409 && code === 'handle_unavailable') {
    return { kind: 'handle-unavailable', status, code, retryAfter: null, message: m.auth_signup_handle_unavailable() };
  }
  if (status === 409) return { kind: 'conflict', status, code, retryAfter: null, message: m.auth_signup_conflict() };
  if (status === 429)
    return { kind: 'rate-limited', status, code, retryAfter, message: failureMessage(429, 'rate_limited', retryAfter) };
  return { kind: 'uncertain', status, code, retryAfter, message: failureMessage(503, 'unavailable', null) };
}

export function explainSignIn(result: Exclude<SignInResult, { ok: true }>): string {
  if (result.reason === 'credentials') return failureMessage(401, 'authentication_denied', null);
  if (result.reason === 'rate-limited') return failureMessage(429, 'rate_limited', result.retryAfter);
  return failureMessage(503, 'unavailable', null);
}
