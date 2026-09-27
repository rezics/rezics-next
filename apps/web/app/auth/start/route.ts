import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { serviceOrigin } from '../../../features/api/origins.ts';
import { accountClient } from '../../../features/auth/client.ts';
import { cookieOptions, OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE } from '../../../features/auth/cookies.ts';
import { appCallback, safeReturnPath } from '../../../features/auth/paths.ts';
import { MAIN_SITE_SCOPE } from '../../../features/auth/scopes.ts';
import { pathLocale, resolveLocale, LOCALE_COOKIE } from '../../../i18n/locale.ts';
import { cookies } from 'next/headers';

/** Starts authorization-code + PKCE in the browser on the Accounts origin. */
export async function GET(request: Request) {
  const input = new URL(request.url);
  const next = safeReturnPath(input.searchParams.get('next'));
  const client = accountClient();
  if (!client) return new Response('Web OAuth client is not configured', { status: 503 });
  const accountOrigin = serviceOrigin('ACCOUNT_ORIGIN');
  const locale = pathLocale(next) ?? resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value,
    request.headers.get('accept-language'));
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const authorize = new URL('/api/auth/oauth2/authorize', accountOrigin);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.clientId,
    redirect_uri: appCallback(request.url), scope: MAIN_SITE_SCOPE, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource: client.resource, ui_locales: locale })) {
    authorize.searchParams.set(key, value);
  }
  if (input.searchParams.get('create') === '1') authorize.searchParams.set('prompt', 'create');
  const response = NextResponse.redirect(authorize);
  // Account's verification link lasts 30 minutes; the PKCE state must last as long.
  const options = cookieOptions(request.url, 1800);
  response.cookies.set(OAUTH_STATE_COOKIE, state, options);
  response.cookies.set(OAUTH_VERIFIER_COOKIE, verifier, options);
  response.cookies.set(OAUTH_NEXT_COOKIE, next, options);
  return response;
}
