import { authPost } from './api';

// Keep the provisional Auth contract together until the issuer contract is confirmed.
export const SIGN_IN_CLIENT_ID = 'login';
export const SIGN_IN_SCOPE: string[] = [];
export const AUTHORIZATION_DROPPED_PARAMETERS = ['sig', 'exp', 'prompt'] as const;

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: 'credentials' | 'unavailable' }
  | { ok: false; reason: 'rate-limited'; retryAfter: string | null };

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const result = await authPost('/signin', {
    email,
    password,
    client_id: SIGN_IN_CLIENT_ID,
    scope: SIGN_IN_SCOPE,
  });
  if (result.ok) return { ok: true };
  if (result.status === 401 && result.code === 'authentication_denied') return { ok: false, reason: 'credentials' };
  if (result.status === 429 && result.code === 'rate_limited')
    return { ok: false, reason: 'rate-limited', retryAfter: result.retryAfter };
  return { ok: false, reason: 'unavailable' };
}

export function signInTarget(query: string, origin: string): string {
  const parameters = new URLSearchParams(query);
  for (const name of AUTHORIZATION_DROPPED_PARAMETERS) parameters.delete(name);
  const target = new URL(parameters.size ? '/authorize' : '/security', origin);
  target.search = parameters.toString();
  return target.href;
}
