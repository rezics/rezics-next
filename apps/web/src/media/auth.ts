import { importJWK, SignJWT, type JWK } from 'jose';
import { dependencyUnavailable } from './kernel.ts';

export type MediaIdentity = { AUTH_ISSUER: string; MEDIA_CLIENT_ID: string; MEDIA_CLIENT_KEY: string };

export function viewerCredential(request: Request): string | null {
  // No cookie is read yet, so these routes carry no cross-site request risk today.
  // Replace this function when the accounts site session is available.
  return request.headers.get('authorization');
}

type Discovery = { issuer: string; token_endpoint: string };
type Token = { value: string; expiresAt: number };
// These caches belong to this isolate's Worker identity, never to a viewer.
let identity: MediaIdentity | undefined;
let discovery: Promise<Discovery> | undefined;
let token: Promise<Token> | undefined;

async function discover(issuer: string): Promise<Discovery> {
  const response = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { redirect: 'manual' });
  if (!response.ok) throw dependencyUnavailable();
  const document = await response.json() as Discovery;
  if (document.issuer !== issuer || typeof document.token_endpoint !== 'string') throw dependencyUnavailable();
  const endpoint = new URL(document.token_endpoint);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))
    throw dependencyUnavailable();
  return document;
}

async function issue(env: MediaIdentity): Promise<Token> {
  discovery ??= discover(env.AUTH_ISSUER).catch((error: unknown) => { discovery = undefined; throw error; });
  const document = await discovery;
  const jwk = JSON.parse(env.MEDIA_CLIENT_KEY) as JWK;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.kid) throw dependencyUnavailable();
  const key = await importJWK(jwk, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
    .setIssuer(env.MEDIA_CLIENT_ID).setSubject(env.MEDIA_CLIENT_ID).setAudience(document.issuer)
    .setIssuedAt(now).setExpirationTime(now + 120).setJti(crypto.randomUUID()).sign(key);
  const response = await fetch(document.token_endpoint, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'media:complete', client_id: env.MEDIA_CLIENT_ID,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }),
  });
  if (!response.ok) throw dependencyUnavailable();
  const body = await response.json() as { access_token: string; token_type: string; expires_in: number };
  if (typeof body.access_token !== 'string' || !body.access_token || body.token_type?.toLowerCase() !== 'bearer'
    || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw dependencyUnavailable();
  return { value: body.access_token, expiresAt: now + body.expires_in };
}

export async function workerToken(env: MediaIdentity): Promise<string> {
  try {
    if (!identity || identity.AUTH_ISSUER !== env.AUTH_ISSUER || identity.MEDIA_CLIENT_ID !== env.MEDIA_CLIENT_ID
      || identity.MEDIA_CLIENT_KEY !== env.MEDIA_CLIENT_KEY) {
      identity = { AUTH_ISSUER: env.AUTH_ISSUER, MEDIA_CLIENT_ID: env.MEDIA_CLIENT_ID, MEDIA_CLIENT_KEY: env.MEDIA_CLIENT_KEY };
      discovery = undefined;
      token = undefined;
    }
    if (token && (await token).expiresAt <= Date.now() / 1000 + 60) token = undefined;
    token ??= issue(env).catch((error: unknown) => { token = undefined; throw error; });
    return (await token).value;
  } catch {
    // Never expose an issuer response, assertion, access token or private key.
    throw dependencyUnavailable();
  }
}
