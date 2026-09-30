import { safeReturnPath as accountReturnPath } from '../../../accounts/features/api/oauth-query.ts';

export function safeReturnPath(value: string | null | undefined, fallback = '/studio'): string {
  return accountReturnPath(value, fallback);
}

export function appCallback(requestUrl: string): string {
  return new URL('/auth/callback', requestUrl).toString();
}

export function signInPath(next: string | null | undefined): string {
  return `/auth/start?next=${encodeURIComponent(safeReturnPath(next))}`;
}

/** Why a sign-in callback failed; the failure page names each one. */
export const signInFailures = ['state', 'issuer', 'code', 'exchange', 'config', 'session',
  'provider', 'unknown'] as const;
export type SignInFailure = (typeof signInFailures)[number];

export function isSignInFailure(value: unknown): value is SignInFailure {
  return (signInFailures as readonly unknown[]).includes(value);
}

/** An OAuth `error` code as the provider sent it, shown only when it is plain. */
export function plainProviderCode(value: string | null | undefined): string | null {
  return value && /^[a-z][a-z_]{0,39}$/.test(value) ? value : null;
}
