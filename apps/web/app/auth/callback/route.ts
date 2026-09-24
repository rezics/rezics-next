import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { appCallback, safeReturnPath } from '../../../features/auth/paths.ts';
import { serviceOrigin } from '../../../features/api/origins.ts';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const jar = await cookies();
  const expectedState = jar.get('rezics_oauth_state')?.value;
  const verifier = jar.get('rezics_oauth_verifier')?.value;
  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return new Response('Authorization state is invalid or expired', { status: 400 });
  }
  const clientId = process.env.WEB_OAUTH_CLIENT_ID;
  const resource = process.env.MAIN_RESOURCE;
  if (!clientId || !resource) return new Response('Web OAuth client is not configured', { status: 503 });
  const token = await fetch(new URL('/api/auth/oauth2/token', serviceOrigin('ACCOUNT_ORIGIN')), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
      code, redirect_uri: appCallback(request.url), code_verifier: verifier, resource }),
    cache: 'no-store',
  });
  if (!token.ok) return new Response('Account token exchange failed', { status: 503 });
  const issued = await token.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!issued.access_token) return new Response('Account did not issue an access token', { status: 503 });
  const next = safeReturnPath(jar.get('rezics_oauth_next')?.value);
  const destination = jar.get('rezics_subject')?.value ? next : `/identity?next=${encodeURIComponent(next)}`;
  const response = NextResponse.redirect(new URL(destination, url.origin));
  for (const name of ['rezics_oauth_state', 'rezics_oauth_verifier', 'rezics_oauth_next']) {
    response.cookies.delete(name);
  }
  const cookie = { httpOnly: true, sameSite: 'lax' as const, secure: url.protocol === 'https:', path: '/' };
  response.cookies.set('rezics_access', issued.access_token, { ...cookie,
    maxAge: Math.max(1, Math.min(issued.expires_in ?? 300, 300)) });
  if (issued.refresh_token) response.cookies.set('rezics_refresh', issued.refresh_token,
    { ...cookie, maxAge: 60 * 60 * 24 * 30 });
  return response;
}
