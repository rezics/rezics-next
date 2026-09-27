import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { serviceOrigin } from '../../../features/api/origins.ts';
import { exchangeCode, readAccountUser } from '../../../features/auth/account.ts';
import { initialSessionAgent } from '../../../features/auth/acting-identity.ts';
import { accountClient } from '../../../features/auth/client.ts';
import { accountCookieHeader, AGENT_COOKIE, clearCookies, OAUTH_COOKIES, OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE } from '../../../features/auth/cookies.ts';
import { appCallback, safeReturnPath, signInPath } from '../../../features/auth/paths.ts';
import { discoverActingContexts } from '../../../features/auth/session.ts';
import { sessionCookies, tokenSubject, writeCookies,
  writeSessionAgent } from '../../../features/auth/session-state.ts';

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
  // A new session starts with the saved default or the only eligible Agent;
  // otherwise the person chooses before continuing.
  const discovery = await discoverActingContexts(issued.tokens.accessToken);
  const agent = discovery ? initialSessionAgent(discovery) : null;
  const response = NextResponse.redirect(new URL(agent ? next
    : `/identity?next=${encodeURIComponent(next)}`, url.origin));
  clearCookies(response.cookies, request.url, [...OAUTH_COOKIES, ...agent ? [] : [AGENT_COOKIE]]);
  writeCookies(response.cookies, sessionCookies(request.url, issued.tokens, user));
  if (agent) writeSessionAgent(response.cookies, request.url, agent);
  return response;
}
