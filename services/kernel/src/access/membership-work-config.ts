import { ConfigError } from '../commerce/config.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { AuthenticationConfig } from './authenticate.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

type Environment = Readonly<Record<string, string | undefined>>;
export const MEMBERSHIP_WORK_DEADLINE_MS = 30_000;
export type MembershipWorkConfig = { routeKey: Buffer; referenceKeys: KeyRing; auth: AuthenticationConfig };

export function readMembershipRouteKey(env: Environment): Buffer {
  const encoded = env.KERNEL_ROUTE_KEY ?? '';
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded) throw new ConfigError('KERNEL_ROUTE_KEY');
  return key;
}

function referenceKeys(env: Environment): KeyRing {
  // HTTP already deploys this purpose-separated seal ring. Share its rotation
  // with the caller instead of requiring a second deployment secret.
  if (env.KERNEL_SESSION_KEYS !== undefined) {
    try {
      const encoded = env.KERNEL_SESSION_KEYS;
      if (!encoded || Buffer.byteLength(encoded) > 8192) throw new Error();
      const entries = encoded.split(',');
      if (entries.length > 4) throw new Error();
      const keys = new Map<number, Uint8Array>();
      for (const entry of entries) {
        const match = /^(0|[1-9]\d{0,2}):([A-Za-z0-9_-]+)$/.exec(entry);
        if (!match || Number(match[1]) > 255 || keys.has(Number(match[1]))) throw new Error();
        const key = Buffer.from(match[2]!, 'base64url');
        if (key.length < 32 || key.toString('base64url') !== match[2]) throw new Error();
        keys.set(Number(match[1]), key);
      }
      return { current: keys.keys().next().value!, keys };
    } catch {
      throw new ConfigError('KERNEL_SESSION_KEYS');
    }
  }
  const variable = 'KERNEL_WORKFLOW_REFERENCE_KEYS';
  try {
    const encoded = env[variable];
    if (!encoded || Buffer.byteLength(encoded) > 8192) throw new Error();
    const value = JSON.parse(encoded);
    // JSON.parse silently overwrites duplicate properties, including escaped
    // spellings. Inspect complete string tokens before accepting this key ring.
    const properties = new Set<string>();
    for (const token of encoded.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      if (
        !encoded
          .slice(token.index + token[0].length)
          .trimStart()
          .startsWith(':')
      )
        continue;
      const property = JSON.parse(token[0]) as string;
      if (properties.has(property)) throw new Error();
      properties.add(property);
    }
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'current,keys' ||
      !Number.isInteger(value.current) ||
      value.current < 0 ||
      value.current > 255 ||
      !value.keys ||
      typeof value.keys !== 'object' ||
      Array.isArray(value.keys)
    )
      throw new Error();
    const entries = Object.entries(value.keys);
    if (entries.length < 1 || entries.length > 4) throw new Error();
    const keys = new Map<number, Uint8Array>();
    for (const [kid, encodedKey] of entries) {
      if (!/^(0|[1-9]\d{0,2})$/.test(kid) || Number(kid) > 255 || typeof encodedKey !== 'string') throw new Error();
      const key = Buffer.from(encodedKey, 'base64url');
      if (key.length < 32 || key.toString('base64url') !== encodedKey) throw new Error();
      keys.set(Number(kid), key);
    }
    if (!keys.has(value.current)) throw new Error();
    return { current: value.current, keys };
  } catch {
    throw new ConfigError(variable);
  }
}

function url(env: Environment, variable: string): URL {
  try {
    const value = env[variable];
    if (!value || value.trim() !== value) throw new Error();
    return new URL(value);
  } catch {
    throw new ConfigError(variable);
  }
}

function loopbackHttpOrigin(value: string, variable: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(variable);
  }
  if (
    parsed.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  )
    throw new ConfigError(variable);
  return parsed.origin;
}

function requestedHref(url: string | URL): string {
  return typeof url === 'string' ? url : url.href;
}

/**
 * Local stacks keep AUTH_JWKS_URL on the issuer origin. Native Auth is only the
 * loopback transport for that exact public document; other URLs are not forwarded.
 */
export function localJwksTransport(env: Environment, auth: AuthenticationConfig): AuthenticationConfig {
  const native = env.REZICS_LOCAL_STACK_NATIVE_ORIGIN;
  if (native === undefined || native === '') return auth;
  let issuer: URL;
  try {
    issuer = new URL(auth.issuer);
  } catch {
    return auth;
  }
  if (issuer.protocol !== 'http:' || !LOOPBACK_HOSTS.has(issuer.hostname)) return auth;
  const origin = loopbackHttpOrigin(native, 'REZICS_LOCAL_STACK_NATIVE_ORIGIN');
  const target = `${origin}/.well-known/jwks.json`;
  if (target === auth.jwksUrl) return auth;
  const transport = auth.fetch ?? globalThis.fetch;
  return {
    ...auth,
    fetch: async (url, init) => {
      if (requestedHref(url) !== auth.jwksUrl)
        throw new TypeError('Local JWKS transport serves only the configured issuer JWKS URL');
      return transport(target, init);
    },
  };
}

/** Registration reads only the supplied deployment environment, once. */
export function readMembershipWorkConfig(env: Environment): MembershipWorkConfig {
  const routeKey = readMembershipRouteKey(env);
  const keys = referenceKeys(env);
  const issuer = url(env, 'AUTH_ISSUER');
  const local = issuer.protocol === 'http:' && LOOPBACK_HOSTS.has(issuer.hostname);
  if ((issuer.protocol !== 'https:' && !local) || issuer.origin !== env.AUTH_ISSUER)
    throw new ConfigError('AUTH_ISSUER');
  const audience = url(env, 'AUTH_AUDIENCE');
  if (audience.protocol !== 'https:' || audience.username || audience.password || audience.hash)
    throw new ConfigError('AUTH_AUDIENCE');
  const jwks = url(env, 'AUTH_JWKS_URL');
  if (
    jwks.protocol !== issuer.protocol ||
    jwks.origin !== issuer.origin ||
    jwks.href !== env.AUTH_JWKS_URL ||
    jwks.username ||
    jwks.password ||
    /[?#]/.test(env.AUTH_JWKS_URL!)
  )
    throw new ConfigError('AUTH_JWKS_URL');
  return {
    routeKey,
    referenceKeys: keys,
    auth: localJwksTransport(env, {
      issuer: env.AUTH_ISSUER!,
      audience: env.AUTH_AUDIENCE!,
      jwksUrl: env.AUTH_JWKS_URL!,
    }),
  };
}
