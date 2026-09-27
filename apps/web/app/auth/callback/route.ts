import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { mainApiWithToken } from '../../../features/api/main.ts';
import { serviceOrigin } from '../../../features/api/origins.ts';
import { exchangeCode, readAccountUser } from '../../../features/auth/account.ts';
import { accountClient } from '../../../features/auth/client.ts';
import { accountCookieHeader, AGENT_COOKIE, clearCookies, OAUTH_COOKIES, OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE } from '../../../features/auth/cookies.ts';
import { appCallback, safeReturnPath, signInPath } from '../../../features/auth/paths.ts';
import { readMainSessionAgent } from '../../../features/auth/session.ts';
import { sessionCookies, tokenSubject, writeCookies,
  writeSessionKey } from '../../../features/auth/session-state.ts';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const jar = await cookies();
  const expectedState = jar.get(OAUTH_STATE_COOKIE)?.value;
  const verifier = jar.get(OAUTH_VERIFIER_COOKIE)?.value;
  if (!state || !expectedState || state !== expectedState || !verifier) {
    return new Response('Authorization state is invalid or expired', { status: 400 });
  }
  const next = safeReturnPath(jar.get(OAUTH_NEXT_COOKIE)?.value);
  if (!code) {
    // Account answered this request without a code: the person declined
    // consent or Account refused. Nothing was granted; offer sign-in again.
    const declined = NextResponse.redirect(new URL(`${signInPath(next)}&error=declined`, url.origin));
    clearCookies(declined.cookies, request.url, OAUTH_COOKIES);
    return declined;
  }
  const client = accountClient();
  if (!client) return new Response('Web OAuth client is not configured', { status: 503 });
  const issued = await exchangeCode(client, { code, verifier, redirectUri: appCallback(request.url) });
  if (issued.status === 'rejected') {
    return new Response('Authorization code is invalid or expired', { status: 400 });
  }
  if (issued.status !== 'issued') return new Response('Account token exchange failed', { status: 503 });
  // Who is signed in comes from the token; the Account session supplies the
  // name and email the site shows, and must be the same person.
  const subject = tokenSubject(issued.tokens.accessToken);
  const user = await readAccountUser(serviceOrigin('ACCOUNT_ORIGIN'),
    accountCookieHeader(request.headers.get('cookie')));
  if (!subject || !user || user.id !== subject) {
    return new Response('Account session does not match the issued token', { status: 503 });
  }
  // Main owns this new session's choice. Its account-wide main-Agent preference
  // supplies the initial candidate, which is saved only if still eligible.
  const sessionKey = crypto.randomUUID();
  const agentState = await readMainSessionAgent(issued.tokens.accessToken, sessionKey);
  const candidate = agentState?.initialActingSubject;
  const selected = candidate ? await mainApiWithToken(issued.tokens.accessToken)
    .v1.me['session-agent'].put({ actingSubject: candidate, expectedRevision: null }, {
      headers: { 'x-session-key': sessionKey, 'idempotency-key': crypto.randomUUID() },
    }).then(result => !result.error).catch(() => false) : false;
  const agent = selected ? candidate : null;
  const response = NextResponse.redirect(new URL(agent ? next
    : `/identity?next=${encodeURIComponent(next)}`, url.origin));
  clearCookies(response.cookies, request.url, [...OAUTH_COOKIES, AGENT_COOKIE]);
  writeCookies(response.cookies, sessionCookies(request.url, issued.tokens, user));
  writeSessionKey(response.cookies, request.url, sessionKey);
  return response;
}
