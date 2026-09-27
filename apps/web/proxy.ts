import { type NextRequest, NextResponse } from 'next/server';
import { cookieOptions, rewriteCookieHeader, SESSION_COOKIES } from './features/auth/cookies.ts';
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
  if (outcome.kind === 'current') return NextResponse.next();
  const cookies: SessionCookie[] = outcome.kind === 'refreshed'
    ? sessionCookies(request.url, outcome.tokens, outcome.user)
    : SESSION_COOKIES.map(name => ({ name, value: '', options: cookieOptions(request.url, 0) }));
  const headers = new Headers(request.headers);
  headers.set('cookie', rewriteCookieHeader(request.headers.get('cookie'), Object.fromEntries(
    cookies.map(cookie => [cookie.name, cookie.value || null]))));
  const response = NextResponse.next({ request: { headers } });
  for (const cookie of cookies) response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

export const config = {
  // Static files and the routes that manage tokens themselves.
  matcher: ['/((?!assets/|_next/|favicon\\.ico|auth/callback|sign-out).*)'],
};
