import { plainProviderCode, type SignInFailure } from './paths.ts';

export type CallbackCheck =
  | { kind: 'proceed'; code: string; verifier: string }
  /** Only the person declining at Account is consent recovery. */
  | { kind: 'denied' }
  | { kind: 'failed'; reason: SignInFailure; providerCode?: string };

/** What the callback URL says before any token exchange: the issuer and state
 * are verified first, then the provider's own `error`, so a foreign or replayed
 * response is never treated as the person's choice. */
export function checkCallback(url: URL, issuer: string, expectedState: string | undefined,
  verifier: string | undefined): CallbackCheck {
  if (url.searchParams.get('iss') !== issuer) return { kind: 'failed', reason: 'issuer' };
  const state = url.searchParams.get('state');
  if (!state || !expectedState || state !== expectedState || !verifier) {
    return { kind: 'failed', reason: 'state' };
  }
  const error = url.searchParams.get('error');
  if (error === 'access_denied') return { kind: 'denied' };
  if (error) {
    const providerCode = plainProviderCode(error);
    return { kind: 'failed', reason: 'provider', ...providerCode ? { providerCode } : {} };
  }
  const code = url.searchParams.get('code');
  return code ? { kind: 'proceed', code, verifier } : { kind: 'failed', reason: 'code' };
}
