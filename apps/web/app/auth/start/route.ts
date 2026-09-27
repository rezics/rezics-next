import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { serviceOrigin } from '../../../features/api/origins.ts';
import { readAccountUser } from '../../../features/auth/account.ts';
import { accountClient } from '../../../features/auth/client.ts';
import { cookieOptions, OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE } from '../../../features/auth/cookies.ts';
import { appCallback, safeReturnPath, signInPath } from '../../../features/auth/paths.ts';
import { MAIN_SITE_SCOPE } from '../../../features/auth/scopes.ts';

/** Starts an authorization-code + PKCE request for the Account session the
 * browser already has, and follows Account to the callback or its consent page. */
export async function GET(request: Request) {
  const input = new URL(request.url);
  const next = safeReturnPath(input.searchParams.get('next'));
  const client = accountClient();
  if (!client) return new Response('Web OAuth client is not configured', { status: 503 });
  const accountOrigin = serviceOrigin('ACCOUNT_ORIGIN');
  const cookie = request.headers.get('cookie') ?? '';
  if (!await readAccountUser(accountOrigin, cookie)) {
    return NextResponse.redirect(new URL(signInPath(next), input));
  }
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const authorize = new URL('/api/auth/oauth2/authorize', accountOrigin);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.clientId,
    redirect_uri: appCallback(request.url), scope: MAIN_SITE_SCOPE, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource: client.resource })) {
    authorize.searchParams.set(key, value);
  }
  let authorized: Response;
  try {
    authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual', cache: 'no-store' });
  } catch { return new Response('Account authorization is unavailable', { status: 503 }); }
  await authorized.body?.cancel();
  const location = authorized.headers.get('location');
  if (authorized.status !== 302 || !location) {
    return new Response(`Account refused the authorization request (HTTP ${authorized.status})`,
      { status: 503 });
  }
  const destination = new URL(location, accountOrigin);
  const toCallback = destination.origin === input.origin && destination.pathname === '/auth/callback';
  // Account's own pages: its sign-in page when the Account session lapsed
  // meanwhile (sign in here again), otherwise consent or another step the
  // person completes at Account before it redirects to the callback.
  if (!toCallback && destination.origin !== accountOrigin) {
    return new Response('Account redirected to an unexpected origin', { status: 503 });
  }
  if (!toCallback && destination.pathname === '/sign-in') {
    return NextResponse.redirect(new URL(signInPath(next), input));
  }
  const response = NextResponse.redirect(destination);
  const options = cookieOptions(request.url, 600);
  response.cookies.set(OAUTH_STATE_COOKIE, state, options);
  response.cookies.set(OAUTH_VERIFIER_COOKIE, verifier, options);
  response.cookies.set(OAUTH_NEXT_COOKIE, next, options);
  return response;
}
