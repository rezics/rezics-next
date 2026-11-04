import { observeLogin, loginResultPhase, type LoginPhaseObserver } from './login-return';
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

export async function signIn(email: string, password: string, onPhase?: LoginPhaseObserver): Promise<SignInResult> {
  observeLogin(onPhase, 'dispatched');
  const result = signInResult(
    await authPost('/signin', {
      email,
      password,
      client_id: SIGN_IN_CLIENT_ID,
      scope: SIGN_IN_SCOPE,
    }),
  );
  observeLogin(onPhase, loginResultPhase(result));
  return result;
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

export function signInTarget(query: string, origin?: string): string {
  const parameters = new URLSearchParams(query);
  const returnTo = parameters.get('return_to');
  for (const name of AUTHORIZATION_DROPPED_PARAMETERS) parameters.delete(name);
  // This is a local Auth-page navigation hint, never an OAuth authorization parameter.
  parameters.delete('account_operation');
  const localTarget = (path: string) => {
    const target = new URL(path, origin ?? 'https://auth.invalid');
    return origin ? target.href : `${target.pathname}${target.search}`;
  };
  if (parameters.size) {
    return localTarget(`/authorize?${parameters.toString()}`);
  }
  // Consent recovery is a fixed local page with exactly its two review inputs.
  // Rebuild the query so URL syntax inside either value cannot change the target.
  if (returnTo?.startsWith('/consent?') && !returnTo.includes('#')) {
    const request = new URLSearchParams(returnTo.slice('/consent?'.length));
    if (request.size === 2 && request.get('client_id') && request.has('scope')) {
      return localTarget(
        `/consent?${new URLSearchParams({
          client_id: request.get('client_id')!,
          scope: request.get('scope')!,
        })}`,
      );
    }
  }
  // Only a listed path is honoured, so return_to can never name another origin or an arbitrary page.
  return localTarget(STEP_UP_RETURN_PATHS.find((path) => path === returnTo) ?? DEFAULT_RETURN_PATH);
}
