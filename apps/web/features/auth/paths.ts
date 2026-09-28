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
