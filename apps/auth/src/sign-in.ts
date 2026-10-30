import { authPost, type AuthPostResult } from './api';
import { accountOperationProfile, type AccountOperationStepUpKind } from './account-operation-step-up';

// Keep the provisional Auth contract together until the issuer contract is confirmed.
export const SIGN_IN_CLIENT_ID = 'login';
export const SIGN_IN_SCOPE: string[] = [];
export const AUTHORIZATION_DROPPED_PARAMETERS = ['sig', 'exp', 'prompt', 'return_to'] as const;
// Auth pages that step-up may return to when there is no authorization request.
export const STEP_UP_RETURN_PATHS = ['/security', '/account/delete', '/organizations/new'] as const;
const DEFAULT_RETURN_PATH = '/security';

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: 'credentials' | 'unavailable' }
  | { ok: false; reason: 'rate-limited'; retryAfter: string | null };

export async function signIn(email: string, password: string): Promise<SignInResult> {
  return signInResult(
    await authPost('/signin', {
      email,
      password,
      client_id: SIGN_IN_CLIENT_ID,
      scope: SIGN_IN_SCOPE,
    }),
  );
}

/** Reauthenticate for one fixed account operation profile. Callers cannot supply client IDs or scopes. */
export async function signInForAccountOperation(
  email: string,
  password: string,
  kind: AccountOperationStepUpKind,
): Promise<SignInResult> {
  const profile = accountOperationProfile(kind);
  return signInResult(await authPost('/signin', { email, password, ...profile }));
}

// `/signin` and `/signin/passkey` answer alike, so both reduce to the same result.
export function signInResult(result: AuthPostResult): SignInResult {
  if (result.ok) return { ok: true };
  if (result.status === 401 && result.code === 'authentication_denied') return { ok: false, reason: 'credentials' };
  if (result.status === 429 && result.code === 'rate_limited')
    return { ok: false, reason: 'rate-limited', retryAfter: result.retryAfter };
  return { ok: false, reason: 'unavailable' };
}

export function signInTarget(query: string, origin: string): string {
  const parameters = new URLSearchParams(query);
  const returnTo = parameters.get('return_to');
  for (const name of AUTHORIZATION_DROPPED_PARAMETERS) parameters.delete(name);
  // This is a local Auth-page navigation hint, never an OAuth authorization parameter.
  parameters.delete('account_operation');
  if (parameters.size) {
    const target = new URL('/authorize', origin);
    target.search = parameters.toString();
    return target.href;
  }
  // Only a listed path is honoured, so return_to can never name another origin or an arbitrary page.
  return new URL(STEP_UP_RETURN_PATHS.find((path) => path === returnTo) ?? DEFAULT_RETURN_PATH, origin).href;
}
