import { authPost, failureMessage } from './api';
import { signIn, type SignInResult } from './sign-in';
import { m } from './paraglide/messages.js';

export type SignupBody = {
  key: string;
  handle: string;
  email: string;
  password: string;
  turnstile_token: string;
};

export type SignupFailure =
  | { field: 'password'; message: string }
  | { field: 'handle'; message: string }
  | { field: 'form'; message: string; conflict: boolean };

export type SignupSubmission = { ok: true; signIn: SignInResult } | { ok: false; failure: SignupFailure };

export function createSignupKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function passwordAccepted(password: string): boolean {
  const length = Array.from(password).length;
  return length >= 8 && length <= 128;
}

// Matches the kernel's handle contract; the server applies the same normalization on signup.
export function normalizeSignupHandle(handle: string): string | null {
  const normalized = handle.toLowerCase();
  // Require the entire input: JavaScript's $ can also match before a final line terminator.
  return /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.exec(normalized)?.[0] === normalized ? normalized : null;
}

export async function submitSignup(input: SignupBody): Promise<SignupSubmission> {
  if (!passwordAccepted(input.password)) {
    return { ok: false, failure: { field: 'password', message: m.auth_signup_password_invalid() } };
  }
  const result = await authPost<{ accountId: string }>('/signup', input);
  // The shared client treats only HTTP 200 as success. Registration answers 201 and issues no session.
  if (result.ok || (!result.ok && result.status === 201))
    return { ok: true, signIn: await signIn(input.email, input.password) };
  return { ok: false, failure: explainSignup(result.status, result.code, result.retryAfter) };
}

export function explainSignup(status: number, code: string, retryAfter: string | null): SignupFailure {
  if (status === 409 && code === 'handle_unavailable') {
    return { field: 'handle', message: m.auth_signup_handle_unavailable() };
  }
  if (status === 409) return { field: 'form', message: m.auth_signup_conflict(), conflict: true };
  if (status === 400 && code === 'registration_denied') {
    return { field: 'form', message: m.auth_signup_denied(), conflict: false };
  }
  if (status === 429)
    return { field: 'form', message: failureMessage(429, 'rate_limited', retryAfter), conflict: false };
  return { field: 'form', message: failureMessage(503, 'unavailable', null), conflict: false };
}

export function explainSignIn(result: Exclude<SignInResult, { ok: true }>): string {
  if (result.reason === 'credentials') return failureMessage(401, 'authentication_denied', null);
  if (result.reason === 'rate-limited') return failureMessage(429, 'rate_limited', result.retryAfter);
  return failureMessage(503, 'unavailable', null);
}
