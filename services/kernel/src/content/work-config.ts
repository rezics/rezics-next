import { isIP } from 'node:net';
import { ConfigError } from '../commerce/config.ts';
import type { R2StorageOptions } from './r2-storage.ts';

export type ContentStorageConfig = Readonly<Omit<R2StorageOptions, 'fetch'>>;

export type ContentConsentConfig = Readonly<{
  url: string;
  serviceTokenId: string;
  serviceTokenSecret: string;
}>;

export type ContentWorkGroupName = 'storage' | 'sources' | 'consent';

export type ContentWorkGroup = Readonly<{
  name: ContentWorkGroupName;
  variables: readonly string[];
}>;

export type ContentWorkConfig = Readonly<{
  storage: ContentStorageConfig | null;
  sourceHosts: readonly string[];
  consent: ContentConsentConfig | null;
  absentGroups: readonly ContentWorkGroup[];
}>;

type Environment = Readonly<Record<string, string | undefined>>;

const STORAGE_VARIABLES = Object.freeze([
  'CONTENT_R2_ENDPOINT',
  'CONTENT_R2_BUCKET',
  'CONTENT_R2_ACCESS_KEY_ID',
  'CONTENT_R2_SECRET_ACCESS_KEY',
] as const);

const SOURCE_VARIABLES = Object.freeze(['CONTENT_SOURCE_HOSTS'] as const);

const CONSENT_VARIABLES = Object.freeze([
  'CONTENT_AUTH_CONSENT_URL',
  'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET',
] as const);

const NO_HOSTS = Object.freeze<readonly string[]>([]);

/** Host configuration only. Each group is absent or complete. Errors name a variable, never its value. */
export function readContentWorkConfig(env: Environment): ContentWorkConfig {
  const storage = readStorage(env);
  const sourceHosts = readSourceHosts(env);
  const consent = readConsent(env);
  const absentGroups = [
    storage === null ? absentGroup('storage', STORAGE_VARIABLES) : null,
    sourceHosts === null ? absentGroup('sources', SOURCE_VARIABLES) : null,
    consent === null ? absentGroup('consent', CONSENT_VARIABLES) : null,
  ].filter((group): group is ContentWorkGroup => group !== null);
  return Object.freeze({
    storage,
    sourceHosts: sourceHosts ?? NO_HOSTS,
    consent,
    absentGroups: Object.freeze(absentGroups),
  });
}

function absentGroup(name: ContentWorkGroupName, variables: readonly string[]): ContentWorkGroup {
  return Object.freeze({ name, variables });
}

function groupPresent(env: Environment, variables: readonly string[]): boolean {
  return variables.some((variable) => env[variable] !== undefined);
}

/** Storage and source values use the historical non-blank, non-control check. */
function storageValue(env: Environment, variable: string): string {
  const value = env[variable];
  if (!value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new ConfigError(variable);
  return value;
}

/** Consent values keep the historical visible-ASCII bound. */
function consentValue(env: Environment, variable: string): string {
  const value = env[variable];
  if (!value || !/^[\x21-\x7e]{1,1024}$/.test(value)) throw new ConfigError(variable);
  return value;
}

function readStorage(env: Environment): ContentStorageConfig | null {
  if (!groupPresent(env, STORAGE_VARIABLES)) return null;
  const endpoint = storageValue(env, 'CONTENT_R2_ENDPOINT');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigError('CONTENT_R2_ENDPOINT');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(url.hostname)
  )
    throw new ConfigError('CONTENT_R2_ENDPOINT');
  const bucket = storageValue(env, 'CONTENT_R2_BUCKET');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new ConfigError('CONTENT_R2_BUCKET');
  return Object.freeze({
    endpoint: url.origin,
    bucket,
    accessKeyId: storageValue(env, 'CONTENT_R2_ACCESS_KEY_ID'),
    secretAccessKey: storageValue(env, 'CONTENT_R2_SECRET_ACCESS_KEY'),
    maxObjectBytes: 20 * 1024 * 1024,
    requestTimeoutMs: 30_000,
  });
}

function readSourceHosts(env: Environment): readonly string[] | null {
  if (!groupPresent(env, SOURCE_VARIABLES)) return null;
  const hosts = storageValue(env, 'CONTENT_SOURCE_HOSTS').split(',');
  if (
    hosts.length > 100 ||
    new Set(hosts).size !== hosts.length ||
    hosts.some(
      (host) =>
        host.length > 253 ||
        isIP(host) !== 0 ||
        !host.includes('.') ||
        !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        !canonicalDnsHost(host),
    )
  )
    throw new ConfigError('CONTENT_SOURCE_HOSTS');
  return Object.freeze(hosts);
}

function readConsent(env: Environment): ContentConsentConfig | null {
  if (!groupPresent(env, CONSENT_VARIABLES)) return null;
  const url = consentValue(env, 'CONTENT_AUTH_CONSENT_URL');
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.pathname !== '/internal/v1/consents:read' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error();
  } catch {
    throw new ConfigError('CONTENT_AUTH_CONSENT_URL');
  }
  return Object.freeze({
    url,
    serviceTokenId: consentValue(env, 'CF_ACCESS_CLIENT_ID'),
    serviceTokenSecret: consentValue(env, 'CF_ACCESS_CLIENT_SECRET'),
  });
}

function canonicalDnsHost(host: string): boolean {
  try {
    const parsed = new URL(`https://${host}`);
    return parsed.hostname === host && isIP(parsed.hostname) === 0;
  } catch {
    return false;
  }
}
