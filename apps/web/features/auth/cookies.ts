// Session cookies. Tokens live only in httpOnly cookies: browser JavaScript
// never sees them, and every Main call goes through the server (the BFF proxy
// or server-side Eden calls), which reads them after `proxy.ts` refreshed them.

/** Main access token (JWT, five minutes). Expires early so a refresh happens before Main would refuse it. */
export const ACCESS_COOKIE = 'rezics_access';
/** Rotating Account refresh token; its absence means signed out. */
export const REFRESH_COOKIE = 'rezics_refresh';
/** Signed-in user shown by the site and the session's expiry; display only, never authority. */
export const SESSION_COOKIE = 'rezics_session';
/** The session Agent IRI. Studio reads this name; the value is re-checked for every command. */
export const AGENT_COOKIE = 'rezics_subject';

export const OAUTH_STATE_COOKIE = 'rezics_oauth_state';
export const OAUTH_VERIFIER_COOKIE = 'rezics_oauth_verifier';
export const OAUTH_NEXT_COOKIE = 'rezics_oauth_next';

export const SESSION_COOKIES = [ACCESS_COOKIE, REFRESH_COOKIE, SESSION_COOKIE, AGENT_COOKIE] as const;
export const OAUTH_COOKIES = [OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_NEXT_COOKIE] as const;

/** Account's refresh-token lifetime (the provider default); each rotation restarts it. */
export const REFRESH_LIFETIME_SECONDS = 60 * 60 * 24 * 30;
/** Refresh this long before the access token expires, so a call never races expiry. */
const ACCESS_EXPIRY_MARGIN_SECONDS = 30;

export interface CookieOptions {
  httpOnly: true; sameSite: 'lax'; secure: boolean; path: '/'; maxAge?: number;
}

/** The subset of Next's `ResponseCookies` the session layer writes through. */
export interface CookieWriter {
  set(name: string, value: string, options: CookieOptions): unknown;
}

export function cookieOptions(requestUrl: string, maxAge?: number): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: new URL(requestUrl).protocol === 'https:',
    path: '/', ...(maxAge === undefined ? {} : { maxAge }) };
}

/** Deletes with the same attributes the cookie was set with, so the browser matches it. */
export function clearCookies(writer: CookieWriter, requestUrl: string,
  names: readonly string[] = SESSION_COOKIES): void {
  for (const name of names) writer.set(name, '', cookieOptions(requestUrl, 0));
}

export function accessMaxAge(expiresIn: number): number {
  const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 300) : 300;
  return Math.max(1, lifetime - Math.min(ACCESS_EXPIRY_MARGIN_SECONDS, Math.floor(lifetime / 5)));
}

/** Rewrites a `Cookie` request header, so code after `proxy.ts` sees the refreshed session. */
export function rewriteCookieHeader(header: string | null,
  changes: Readonly<Record<string, string | null>>): string {
  const kept = (header ?? '').split(';').map(part => part.trim()).filter(Boolean)
    .filter(part => !Object.hasOwn(changes, part.slice(0, Math.max(0, part.indexOf('=')))));
  for (const [name, value] of Object.entries(changes)) if (value !== null) kept.push(`${name}=${value}`);
  return kept.join('; ');
}
