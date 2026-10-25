// Keep the provisional Auth contract together until the issuer contract is confirmed.
export const SIGN_IN_CLIENT_ID = 'login';
export const SIGN_IN_SCOPE: string[] = [];
export const AUTHORIZATION_DROPPED_PARAMETERS = ['sig', 'exp'] as const;

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: 'credentials' | 'unavailable' }
  | { ok: false; reason: 'rate-limited'; retryAfter: string | null };

export async function signIn(email: string, password: string): Promise<SignInResult> {
  try {
    const response = await fetch('/signin', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: SIGN_IN_CLIENT_ID, scope: SIGN_IN_SCOPE }),
    });
    // Auth's body is never a navigation source or a user-visible error message.
    if (response.status === 200) return { ok: true };
    if (response.status === 401) return { ok: false, reason: 'credentials' };
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfter: retryAfter && /^\d+$/.test(retryAfter) ? retryAfter : null,
      };
    }
  } catch {
    // Network failures and redirects use the same retryable message as an unavailable issuer.
  }
  return { ok: false, reason: 'unavailable' };
}

export function signInTarget(query: string, origin: string): string {
  const parameters = new URLSearchParams(query);
  for (const name of AUTHORIZATION_DROPPED_PARAMETERS) parameters.delete(name);
  const target = new URL(parameters.size ? '/authorize' : '/security', origin);
  target.search = parameters.toString();
  return target.href;
}
