import { type NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, AGENT_COOKIE, cookieOptions, isSessionKey, REFRESH_COOKIE,
  rewriteCookieHeader, SESSION_COOKIES, SESSION_KEY_COOKIE,
  REFRESH_LIFETIME_SECONDS } from './features/auth/cookies.ts';
import { accountClient } from './features/auth/client.ts';
import { refreshSession } from './features/auth/refresh.ts';
import { type SessionCookie, sessionCookies } from './features/auth/session-state.ts';
import { isPublicPagePath, LOCALE_COOKIE, pathLocale, resolveLocale } from './i18n/locale.ts';

// Refreshes the session before any page, Server Action, route handler or BFF
// call reads it, so each request refreshes at most once and nothing
// downstream handles expiry. The rewritten Cookie header carries the new
// tokens to that code; Set-Cookie carries them to the browser.
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  if (isPublicPagePath(pathname) && !pathLocale(pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
    const locale = resolveLocale(request.cookies.get(LOCALE_COOKIE)?.value,
      request.headers.get('accept-language'));
    const destination = request.nextUrl.clone();
    destination.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
    return NextResponse.redirect(destination);
  }
  const client = accountClient();
  const outcome = client ? await refreshSession(request.cookies, client) : { kind: 'current' as const };
  const signedIn = Boolean(request.cookies.get(ACCESS_COOKIE)?.value
    || request.cookies.get(REFRESH_COOKIE)?.value);
  const sessionKey = outcome.kind !== 'ended' && signedIn
    && !isSessionKey(request.cookies.get(SESSION_KEY_COOKIE)?.value)
    ? crypto.randomUUID() : null;
  const renewedKey = sessionKey ?? (outcome.kind === 'refreshed'
    ? request.cookies.get(SESSION_KEY_COOKIE)?.value : null);
  const legacyAgent = outcome.kind !== 'ended' && Boolean(request.cookies.get(AGENT_COOKIE)?.value);
  const cookies: SessionCookie[] = outcome.kind === 'refreshed'
    ? sessionCookies(request.url, outcome.tokens, outcome.user)
    : outcome.kind === 'ended'
      ? SESSION_COOKIES.map(name => ({ name, value: '', options: cookieOptions(request.url, 0) }))
      : [];
  if (renewedKey) cookies.push({ name: SESSION_KEY_COOKIE, value: renewedKey,
    options: cookieOptions(request.url, REFRESH_LIFETIME_SECONDS) });
  if (legacyAgent) cookies.push({ name: AGENT_COOKIE, value: '',
    options: cookieOptions(request.url, 0) });
  const headers = new Headers(request.headers);
  if (isPublicPagePath(pathname) && pathLocale(pathname)) headers.set('x-rezics-page-url', request.nextUrl.origin + pathname);
  else headers.delete('x-rezics-page-url');
  headers.set('cookie', rewriteCookieHeader(request.headers.get('cookie'), Object.fromEntries(
    cookies.map(cookie => [cookie.name, cookie.value || null]))));
  const response = NextResponse.next({ request: { headers } });
  for (const cookie of cookies) response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

export const config = {
  // Static files and the routes that manage tokens themselves.
  matcher: ['/((?!assets/|_next/|favicon\\.ico|favicon\\.svg|auth/callback|sign-out).*)'],
};
