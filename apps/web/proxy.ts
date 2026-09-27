import { type NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, AGENT_COOKIE, cookieOptions, isSessionKey, REFRESH_COOKIE,
  rewriteCookieHeader, SESSION_COOKIES, SESSION_KEY_COOKIE,
  REFRESH_LIFETIME_SECONDS } from './features/auth/cookies.ts';
import { accountClient } from './features/auth/client.ts';
import { refreshSession } from './features/auth/refresh.ts';
import { type SessionCookie, sessionCookies } from './features/auth/session-state.ts';

// Refreshes the session before any page, Server Action, route handler or BFF
// call reads it, so each request refreshes at most once and nothing
// downstream handles expiry. The rewritten Cookie header carries the new
// tokens to that code; Set-Cookie carries them to the browser.
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const client = accountClient();
  if (!client) return NextResponse.next();
  const outcome = await refreshSession(request.cookies, client);
  const signedIn = Boolean(request.cookies.get(ACCESS_COOKIE)?.value
    || request.cookies.get(REFRESH_COOKIE)?.value);
  const sessionKey = outcome.kind !== 'ended' && signedIn
    && !isSessionKey(request.cookies.get(SESSION_KEY_COOKIE)?.value)
    ? crypto.randomUUID() : null;
  const renewedKey = sessionKey ?? (outcome.kind === 'refreshed'
    ? request.cookies.get(SESSION_KEY_COOKIE)?.value : null);
  const legacyAgent = outcome.kind !== 'ended' && Boolean(request.cookies.get(AGENT_COOKIE)?.value);
  if (outcome.kind === 'current' && !sessionKey && !legacyAgent) return NextResponse.next();
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
