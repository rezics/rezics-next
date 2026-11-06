import { isIP } from 'node:net';
import { ConfigError } from '../commerce/config.ts';
import { createTurnstileVerifier } from './turnstile.ts';
import type { ContentRuntime } from './runtime.ts';
import { readContentEditionConsent } from './edition-sale-consent.ts';

type Environment = Readonly<Record<string, string | undefined>>;

function validDnsHost(value: string, allowLocalhost = false): boolean {
  if (
    value.length > 253 ||
    value !== value.toLowerCase() ||
    value.trim() !== value ||
    /[\s\x00-\x1f\x7f]/.test(value) ||
    isIP(value) !== 0
  )
    return false;
  if (allowLocalhost && value === 'localhost') return true;
  if (!value.includes('.')) return false;
  if (!value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value && url.pathname === '/' && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sourceHosts(value: string): readonly string[] {
  const hosts = value.split(',');
  if (
    hosts.length < 1 ||
    hosts.length > 100 ||
    new Set(hosts).size !== hosts.length ||
    hosts.some((host) => !validDnsHost(host))
  )
    throw new ConfigError('CONTENT_SOURCE_HOSTS');
  return Object.freeze(hosts);
}

function turnstile(env: Environment) {
  const secret = env.CONTENT_TURNSTILE_SECRET;
  const hostname = env.CONTENT_TURNSTILE_HOSTNAME;
  if (secret === undefined && hostname === undefined) {
    // Anonymous report admission stays closed until a provider secret and host
    // are configured; the absence is carried as no verifier, not as an outage.
    return undefined;
  }
  if (secret === undefined) throw new ConfigError('CONTENT_TURNSTILE_SECRET');
  if (!/^[\x21-\x7e]{1,4096}$/.test(secret)) throw new ConfigError('CONTENT_TURNSTILE_SECRET');
  if (hostname === undefined) throw new ConfigError('CONTENT_TURNSTILE_HOSTNAME');
  if (!validDnsHost(hostname, true)) throw new ConfigError('CONTENT_TURNSTILE_HOSTNAME');
  return createTurnstileVerifier({ secret, hostname, action: 'report' });
}

/** Trusted HTTP composition. Worker storage credentials are deliberately not read here. */
export function readContentConfig(env: Environment): ContentRuntime {
  const anonymousVerifier = turnstile(env);
  const verifier = anonymousVerifier === undefined ? {} : { anonymousVerifier };
  const consent = readContentEditionConsent(env);
  const readConsent = consent === undefined ? {} : { readConsent: consent };
  if (env.CONTENT_SOURCE_HOSTS === undefined) return Object.freeze({ ...verifier, ...readConsent });
  if (!env.CONTENT_SOURCE_HOSTS) throw new ConfigError('CONTENT_SOURCE_HOSTS');
  return Object.freeze({
    fetchConfig: Object.freeze({ allowedHosts: sourceHosts(env.CONTENT_SOURCE_HOSTS) }),
    ...verifier,
    ...readConsent,
  });
}
