import * as oidc from 'openid-client';
import { dependencyUnavailable } from '../media/kernel.ts';
import type { SessionStore } from './store.ts';

export type SessionEnv = {
  AUTH_ISSUER: string;
  WEBSITE_CLIENT_ID: string;
  WEBSITE_CLIENT_KEY: string;
  SESSIONS: DurableObjectNamespace<SessionStore>;
};

export function configured(env: Partial<SessionEnv>): env is SessionEnv {
  return Boolean(env.AUTH_ISSUER && env.WEBSITE_CLIENT_ID && env.WEBSITE_CLIENT_KEY && env.SESSIONS);
}

class UnreachableIssuer extends Error {}

export function unreachable(error: unknown): boolean {
  if (error instanceof UnreachableIssuer) return true;
  return error instanceof Error && error.cause !== undefined && unreachable(error.cause);
}

function loopback(url: URL): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

// Cache the import and discovery together. Rejected attempts must be retryable.
const clients = new Map<string, Promise<oidc.Configuration>>();
export function authClient(env: SessionEnv): Promise<oidc.Configuration> {
  const values = JSON.stringify([env.AUTH_ISSUER, env.WEBSITE_CLIENT_ID, env.WEBSITE_CLIENT_KEY]);
  let pending = clients.get(values);
  if (!pending) {
    pending = discover(env).catch(() => {
      clients.delete(values);
      throw dependencyUnavailable();
    });
    clients.set(values, pending);
  }
  return pending;
}

async function discover(env: SessionEnv): Promise<oidc.Configuration> {
  const issuer = new URL(env.AUTH_ISSUER);
  if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && loopback(issuer)))
    throw dependencyUnavailable();
  const jwk = JSON.parse(env.WEBSITE_CLIENT_KEY) as JsonWebKey & { kid?: string };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.kid || (jwk.alg && jwk.alg !== 'ES256'))
    throw dependencyUnavailable();
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return oidc.discovery(issuer, env.WEBSITE_CLIENT_ID, {
    token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'ES256',
    id_token_signed_response_alg: 'ES256',
  }, oidc.PrivateKeyJwt({ key, kid: jwk.kid }), {
    execute: issuer.protocol === 'http:'
      ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks]
      : [oidc.enableNonRepudiationChecks],
    [oidc.customFetch]: async (input, init) => {
      const url = new URL(input);
      // The insecure library option must never permit a non-loopback HTTP endpoint.
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url)))
        throw new UnreachableIssuer();
      try {
        const response = await fetch(input, { ...init, body: init.body instanceof Uint8Array ? new Uint8Array(init.body).buffer : init.body ?? null, redirect: 'manual' });
        if (response.status >= 500) throw new UnreachableIssuer();
        return response;
      } catch {
        throw new UnreachableIssuer();
      }
    },
  });
}
