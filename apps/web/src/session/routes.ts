import * as oidc from 'openid-client';
import { dependencyUnavailable, problem, problemResponse } from '../media/kernel.ts';
import { assertPublicCacheReadAllowed } from '../security/page-cache.ts';
import { authClient, configured, unreachable, type SessionEnv } from './client.ts';
import { newCsrfToken } from './csrf.ts';
import {
  clearCookie,
  cookie,
  LOGIN_COOKIE,
  LOGIN_SECONDS,
  randomId,
  SESSION_COOKIE,
  SESSION_SECONDS,
  setCookie,
  validId,
} from './cookies.ts';

const invalid = () => problem(400, 'invalid_request', 'Invalid Request');
const redirect = (location: string, status = 303) => new Response(null, { status, headers: { location } });

function returnTarget(value: string | null, origin: string): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  try {
    const target = new URL(value, origin);
    const path = target.pathname + target.search + target.hash;
    return target.origin === origin && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
      ? path
      : '/';
  } catch {
    return '/';
  }
}

async function signIn(request: Request, env: SessionEnv): Promise<Response> {
  const url = new URL(request.url);
  const config = await authClient(env);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const location = oidc.buildAuthorizationUrl(config, {
    response_type: 'code',
    redirect_uri: `${url.origin}/auth/callback`,
    resource: env.API_RESOURCE,
    scope: [...new Set(['openid', 'offline_access', ...env.WEBSITE_SCOPES.split(/\s+/).filter(Boolean)])].join(' '),
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  const id = randomId();
  await env.SESSIONS.get(env.SESSIONS.idFromName(`login:${id}`)).create({
    kind: 'login',
    state,
    nonce,
    verifier,
    returnTo: returnTarget(url.searchParams.get('return_to'), url.origin),
    expiresAt: Date.now() + LOGIN_SECONDS * 1000,
  });
  const response = redirect(location.href, 302);
  response.headers.append('set-cookie', setCookie(LOGIN_COOKIE, id, LOGIN_SECONDS));
  return response;
}

async function callback(request: Request, env: SessionEnv): Promise<Response> {
  const id = cookie(request, LOGIN_COOKIE);
  if (!validId(id)) throw invalid();
  const transaction = await env.SESSIONS.get(env.SESSIONS.idFromName(`login:${id}`)).takeLogin();
  const url = new URL(request.url);
  if (
    !transaction ||
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.get('state') !== transaction.state
  )
    throw invalid();
  if (url.searchParams.has('error')) return redirect(transaction.returnTo);
  const config = await authClient(env);
  let tokens;
  try {
    tokens = await oidc.authorizationCodeGrant(
      config,
      url,
      {
        pkceCodeVerifier: transaction.verifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      },
      { resource: env.API_RESOURCE },
    );
  } catch (error) {
    throw unreachable(error) ? dependencyUnavailable() : invalid();
  }
  const claims = tokens.claims();
  if (!claims?.sub || !tokens.refresh_token || !tokens.id_token || !tokens.expires_in) throw invalid();
  const sessionId = randomId();
  await env.SESSIONS.get(env.SESSIONS.idFromName(sessionId)).create({
    kind: 'session',
    subject: claims.sub,
    accessToken: tokens.access_token,
    accessExpiresAt: Date.now() + tokens.expires_in * 1000,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    csrfToken: newCsrfToken(),
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  });
  const response = redirect(transaction.returnTo);
  response.headers.append('set-cookie', setCookie(SESSION_COOKIE, sessionId, SESSION_SECONDS));
  return response;
}

async function signOut(
  request: Request,
  env: SessionEnv,
  endedSession?: { idToken?: string | undefined },
): Promise<Response> {
  const id = cookie(request, SESSION_COOKIE);
  const ended =
    endedSession !== undefined
      ? endedSession.idToken
      : validId(id)
        ? await env.SESSIONS.get(env.SESSIONS.idFromName(id)).end()
        : undefined;
  const idToken = typeof ended === 'string' ? ended : undefined;
  let location = '/';
  if (idToken) {
    try {
      const config = await authClient(env);
      if (config.serverMetadata().end_session_endpoint)
        location = oidc.buildEndSessionUrl(config, {
          id_token_hint: idToken,
          client_id: env.WEBSITE_CLIENT_ID,
          post_logout_redirect_uri: `${new URL(request.url).origin}/`,
        }).href;
    } catch {
      // The local session has already ended even if discovery is unavailable.
    }
  }
  const response = redirect(location);
  response.headers.append('set-cookie', clearCookie(SESSION_COOKIE));
  return response;
}

export async function authRequest(
  request: Request,
  env: Partial<SessionEnv>,
  endedSession?: { idToken?: string | undefined },
): Promise<Response> {
  assertPublicCacheReadAllowed(request, 'Auth');
  const path = new URL(request.url).pathname;
  let response: Response;
  try {
    if (!configured(env)) throw dependencyUnavailable(503);
    const method = path === '/auth/sign-out' ? 'POST' : 'GET';
    if (request.method !== method) {
      response = problemResponse(problem(405, 'invalid_request', 'Invalid Request'), { allow: method });
    } else if (path === '/auth/sign-in') response = await signIn(request, env);
    else if (path === '/auth/callback') response = await callback(request, env);
    else if (path === '/auth/sign-out') response = await signOut(request, env, endedSession);
    else response = problemResponse(invalid());
  } catch (error) {
    response = problemResponse(error);
  }
  if (path === '/auth/callback') response.headers.append('set-cookie', clearCookie(LOGIN_COOKIE));
  response.headers.set('cache-control', 'private, no-store');
  return response;
}
