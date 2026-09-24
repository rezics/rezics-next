import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { appCallback, safeReturnPath, signInPath } from '../../../features/auth/paths.ts';
import { serviceOrigin } from '../../../features/api/origins.ts';

export async function GET(request: Request) {
  const input = new URL(request.url);
  const accountOrigin = serviceOrigin('ACCOUNT_ORIGIN');
  const clientId = process.env.WEB_OAUTH_CLIENT_ID;
  const resource = process.env.MAIN_RESOURCE;
  if (!clientId || !resource) return new Response('Web OAuth client is not configured', { status: 503 });
  const session = await fetch(new URL('/api/auth/get-session', accountOrigin), {
    headers: { cookie: request.headers.get('cookie') ?? '' }, cache: 'no-store',
  });
  const current = await session.json().catch(() => null) as { user?: { id?: string } } | null;
  if (!current?.user?.id) return NextResponse.redirect(new URL(signInPath(input.searchParams.get('next')), input));
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callback = appCallback(request.url);
  const authorize = new URL('/api/auth/oauth2/authorize', accountOrigin);
  const values = { response_type: 'code', client_id: clientId, redirect_uri: callback,
    scope: 'openid work:create', state,
    code_challenge: challenge, code_challenge_method: 'S256', resource };
  for (const [key, value] of Object.entries(values)) authorize.searchParams.set(key, value);
  const authorized = await fetch(authorize, { headers: { cookie: request.headers.get('cookie') ?? '' },
    redirect: 'manual', cache: 'no-store' });
  const location = authorized.headers.get('location');
  if (authorized.status !== 302 || !location) {
    return new Response('Account authorization is unavailable', { status: 503 });
  }
  const destination = new URL(location, accountOrigin);
  if (destination.origin !== input.origin || destination.pathname !== '/auth/callback') {
    return new Response('Account authorization requires a supported consent step', { status: 503 });
  }
  const response = NextResponse.redirect(destination);
  const cookie = { httpOnly: true, sameSite: 'lax' as const, secure: input.protocol === 'https:',
    path: '/', maxAge: 600 };
  response.cookies.set('rezics_oauth_state', state, cookie);
  response.cookies.set('rezics_oauth_verifier', verifier, cookie);
  response.cookies.set('rezics_oauth_next', safeReturnPath(input.searchParams.get('next')), cookie);
  return response;
}
