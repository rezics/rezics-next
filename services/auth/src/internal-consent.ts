import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Pool } from 'pg';
import { createCurrentConsentReader, validConsentInput } from './current-consent.ts';

const path = '/internal/v1/consents:read';
function trustedUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid consent trust configuration');
  return url;
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
async function bodyOf(request: Request): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' ||
    Number(request.headers.get('content-length') ?? 0) > 16384
  )
    throw new Error('Denied');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Denied');
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 3000);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error('Denied');
      chunks.push(value);
    }
    if (expired) throw new Error('Denied');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

/** Private Auth listener only. Compose on a dedicated private socket/listener
 * reachable solely through Cloudflare Tunnel, with NO public hostname or mount
 * on AuthService.handler. Configure Access Service Auth policy for the kernel
 * worker's existing service token. Supply that application's issuer, certs URL,
 * AUD and Client ID allowlist from trusted deployment configuration. Bind e.g.
 * Bun.serve({ hostname: '127.0.0.1', port: privatePort, fetch: handler }) behind
 * the Tunnel; keep the Auth-owned pool and listener in the existing Auth host.
 * Production URLs use HTTPS; exact loopback HTTP supports isolated test JWKS.
 * Access, not provider JWTs/cookies, supplies Cf-Access-Jwt-Assertion.
 */
export function createInternalConsentHandler(config: {
  database: Pool;
  issuer: string;
  jwksUrl: string;
  audience: string;
  allowedServiceTokenIds: readonly string[];
}): (request: Request) => Promise<Response> {
  const { database, issuer, audience } = config;
  const issuerUrl = trustedUrl(issuer);
  const jwksUrl = trustedUrl(config.jwksUrl);
  if (
    issuerUrl.origin !== issuer ||
    !database ||
    typeof audience !== 'string' ||
    !/^[\x21-\x7e]{1,256}$/.test(audience) ||
    !Array.isArray(config.allowedServiceTokenIds) ||
    !config.allowedServiceTokenIds.length ||
    config.allowedServiceTokenIds.length > 64 ||
    config.allowedServiceTokenIds.some((id) => typeof id !== 'string' || !/^[\x21-\x7e]{1,256}\.access$/.test(id))
  )
    throw new Error('Invalid consent trust configuration');
  const identities = new Set(config.allowedServiceTokenIds);
  const keys = createRemoteJWKSet(jwksUrl, { timeoutDuration: 3000 });
  const { readCurrentConsent } = createCurrentConsentReader({ database });
  return async (request) => {
    let input: { actorAccountId: string; clientId: string };
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== path || url.search) throw new Error('Denied');
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token || token.length > 16384) throw new Error('Denied');
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp'],
        clockTolerance: 0,
      });
      // Cloudflare's service JWT has an empty subject; common_name is the
      // service token Client ID. A human JWT or org cookie cannot supply it.
      if (
        payload.type !== 'app' ||
        payload.sub !== '' ||
        typeof payload.common_name !== 'string' ||
        !identities.has(payload.common_name) ||
        payload.email !== undefined ||
        !Array.isArray(payload.aud) ||
        payload.aud.length !== 1 ||
        payload.aud[0] !== audience ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! > Math.floor(Date.now() / 1000) ||
        payload.exp! <= payload.iat!
      )
        throw new Error('Denied');
      const body = await bodyOf(request);
      if (!validConsentInput(body)) throw new Error('Denied');
      input = body;
    } catch {
      return json({ error: 'denied' }, 403);
    }
    try {
      return json(await readCurrentConsent(input));
    } catch {
      return json({ error: 'unavailable' }, 503);
    }
  };
}
