import { isIP } from 'node:net';
import { ConfigError } from '../commerce/config.ts';
import type { R2StorageOptions } from './r2-storage.ts';

export type ContentWorkConfig = Readonly<{
  storage: Readonly<Omit<R2StorageOptions, 'fetch'>>;
  sourceHosts: readonly string[];
}>;

/** Host configuration only. Errors identify a variable, never its value. */
export function readContentWorkConfig(env: Readonly<Record<string, string | undefined>>): ContentWorkConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (!value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new ConfigError(key);
    return value;
  };
  const endpoint = required('CONTENT_R2_ENDPOINT');
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
  const bucket = required('CONTENT_R2_BUCKET');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new ConfigError('CONTENT_R2_BUCKET');
  const accessKeyId = required('CONTENT_R2_ACCESS_KEY_ID');
  const secretAccessKey = required('CONTENT_R2_SECRET_ACCESS_KEY');
  const hosts = required('CONTENT_SOURCE_HOSTS').split(',');
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
  return Object.freeze({
    storage: Object.freeze({
      endpoint: url.origin,
      bucket,
      accessKeyId,
      secretAccessKey,
      maxObjectBytes: 20 * 1024 * 1024,
      requestTimeoutMs: 30_000,
    }),
    sourceHosts: Object.freeze(hosts),
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
