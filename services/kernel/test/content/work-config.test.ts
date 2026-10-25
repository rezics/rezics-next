import { expect, test } from 'bun:test';
import { ConfigError } from '../../src/commerce/config.ts';
import { readContentWorkConfig } from '../../src/content/work-config.ts';

const env = {
  CONTENT_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
  CONTENT_R2_BUCKET: 'content-media',
  CONTENT_R2_ACCESS_KEY_ID: 'private-access-id',
  CONTENT_R2_SECRET_ACCESS_KEY: 'private-secret',
  CONTENT_SOURCE_HOSTS: 'images.example.org,covers.example.net',
};

test('production R2 and exact HTTPS source hosts are explicit and bounded', () => {
  const config = readContentWorkConfig(env);
  expect(config.storage).toEqual({
    endpoint: env.CONTENT_R2_ENDPOINT,
    bucket: 'content-media',
    accessKeyId: 'private-access-id',
    secretAccessKey: 'private-secret',
    maxObjectBytes: 20 * 1024 * 1024,
    requestTimeoutMs: 30_000,
  });
  expect(config.sourceHosts).toEqual(['images.example.org', 'covers.example.net']);
  expect(Object.isFrozen(config)).toBe(true);
  expect(Object.isFrozen(config.sourceHosts)).toBe(true);
  expect(readContentWorkConfig({ ...env, DATABASE_URL: 'ignored', KERNEL_WORKER_POOL_SIZE: 'invalid' })).toEqual(
    config,
  );
});

const consent = {
  CONTENT_AUTH_CONSENT_URL: 'https://consent.example.test/internal/v1/consents:read',
  CF_ACCESS_CLIENT_ID: 'access-client-id',
  CF_ACCESS_CLIENT_SECRET: 'access-client-secret',
};

test('each group is all or nothing and a partial group names its first missing variable', () => {
  const empty = readContentWorkConfig({});
  expect(empty.storage).toBeNull();
  expect(empty.sourceHosts).toEqual([]);
  expect(empty.consent).toBeNull();
  expect(Object.isFrozen(empty)).toBe(true);
  expect(Object.isFrozen(empty.sourceHosts)).toBe(true);
  expect(Object.isFrozen(empty.absentGroups)).toBe(true);
  expect(empty.absentGroups).toEqual([
    {
      name: 'storage',
      variables: [
        'CONTENT_R2_ENDPOINT',
        'CONTENT_R2_BUCKET',
        'CONTENT_R2_ACCESS_KEY_ID',
        'CONTENT_R2_SECRET_ACCESS_KEY',
      ],
    },
    { name: 'sources', variables: ['CONTENT_SOURCE_HOSTS'] },
    {
      name: 'consent',
      variables: ['CONTENT_AUTH_CONSENT_URL', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'],
    },
  ]);

  const sourcesOnly = readContentWorkConfig({ CONTENT_SOURCE_HOSTS: 'images.example.org' });
  expect(sourcesOnly.storage).toBeNull();
  expect(sourcesOnly.consent).toBeNull();
  expect(sourcesOnly.sourceHosts).toEqual(['images.example.org']);
  expect(sourcesOnly.absentGroups.map((group) => group.name)).toEqual(['storage', 'consent']);

  const consentOnly = readContentWorkConfig(consent);
  expect(consentOnly.storage).toBeNull();
  expect(consentOnly.sourceHosts).toEqual([]);
  expect(consentOnly.consent).toEqual({
    url: consent.CONTENT_AUTH_CONSENT_URL,
    serviceTokenId: consent.CF_ACCESS_CLIENT_ID,
    serviceTokenSecret: consent.CF_ACCESS_CLIENT_SECRET,
  });
  expect(consentOnly.absentGroups.map((group) => group.name)).toEqual(['storage', 'sources']);

  const storageAndSources = readContentWorkConfig(env);
  expect(storageAndSources.consent).toBeNull();
  expect(storageAndSources.absentGroups.map((group) => group.name)).toEqual(['consent']);

  const complete = readContentWorkConfig({ ...env, ...consent });
  expect(complete.absentGroups).toEqual([]);
  expect(complete.consent).toEqual(consentOnly.consent);

  expect(() => readContentWorkConfig({ CONTENT_R2_BUCKET: 'content-media' })).toThrow('CONTENT_R2_ENDPOINT');
  expect(() =>
    readContentWorkConfig({
      CONTENT_R2_ENDPOINT: env.CONTENT_R2_ENDPOINT,
      CONTENT_R2_ACCESS_KEY_ID: env.CONTENT_R2_ACCESS_KEY_ID,
      CONTENT_R2_SECRET_ACCESS_KEY: env.CONTENT_R2_SECRET_ACCESS_KEY,
    }),
  ).toThrow('CONTENT_R2_BUCKET');
  expect(() =>
    readContentWorkConfig({
      CONTENT_R2_ENDPOINT: env.CONTENT_R2_ENDPOINT,
      CONTENT_R2_BUCKET: env.CONTENT_R2_BUCKET,
      CONTENT_R2_SECRET_ACCESS_KEY: env.CONTENT_R2_SECRET_ACCESS_KEY,
    }),
  ).toThrow('CONTENT_R2_ACCESS_KEY_ID');
  expect(() =>
    readContentWorkConfig({
      CONTENT_R2_ENDPOINT: env.CONTENT_R2_ENDPOINT,
      CONTENT_R2_BUCKET: env.CONTENT_R2_BUCKET,
      CONTENT_R2_ACCESS_KEY_ID: env.CONTENT_R2_ACCESS_KEY_ID,
    }),
  ).toThrow('CONTENT_R2_SECRET_ACCESS_KEY');
  expect(() => readContentWorkConfig({ CF_ACCESS_CLIENT_ID: consent.CF_ACCESS_CLIENT_ID })).toThrow(
    'CONTENT_AUTH_CONSENT_URL',
  );
  expect(() =>
    readContentWorkConfig({
      CONTENT_AUTH_CONSENT_URL: consent.CONTENT_AUTH_CONSENT_URL,
      CF_ACCESS_CLIENT_SECRET: consent.CF_ACCESS_CLIENT_SECRET,
    }),
  ).toThrow('CF_ACCESS_CLIENT_ID');
  expect(() =>
    readContentWorkConfig({
      CONTENT_AUTH_CONSENT_URL: consent.CONTENT_AUTH_CONSENT_URL,
      CF_ACCESS_CLIENT_ID: consent.CF_ACCESS_CLIENT_ID,
    }),
  ).toThrow('CF_ACCESS_CLIENT_SECRET');

  for (const key of [
    'CONTENT_R2_ENDPOINT',
    'CONTENT_R2_BUCKET',
    'CONTENT_R2_ACCESS_KEY_ID',
    'CONTENT_R2_SECRET_ACCESS_KEY',
  ] as const) {
    expect(() => readContentWorkConfig({ ...env, [key]: '' })).toThrow(key);
  }
  expect(() => readContentWorkConfig({ ...env, CONTENT_SOURCE_HOSTS: '' })).toThrow('CONTENT_SOURCE_HOSTS');
  for (const key of Object.keys(consent) as (keyof typeof consent)[]) {
    expect(() => readContentWorkConfig({ ...env, ...consent, [key]: '' })).toThrow(key);
  }

  let endpointFailure: unknown;
  try {
    readContentWorkConfig({ ...env, CONTENT_R2_ENDPOINT: 'https://private-access-id:private-secret@example.org' });
  } catch (error) {
    endpointFailure = error;
  }
  expect(endpointFailure).toBeInstanceOf(ConfigError);
  expect(String(endpointFailure)).toContain('CONTENT_R2_ENDPOINT');
  expect(String(endpointFailure)).not.toContain('private-access-id');
  expect(String(endpointFailure)).not.toContain('private-secret');

  let consentFailure: unknown;
  try {
    readContentWorkConfig({
      ...consent,
      CONTENT_AUTH_CONSENT_URL: 'https://consent-user-secret:hidden@consent.example.test/internal/v1/consents:read',
    });
  } catch (error) {
    consentFailure = error;
  }
  expect(consentFailure).toBeInstanceOf(ConfigError);
  expect(String(consentFailure)).toContain('CONTENT_AUTH_CONSENT_URL');
  expect(String(consentFailure)).not.toContain('consent-user-secret');
  expect(String(consentFailure)).not.toContain('hidden');
});

test('R2 rejects non-R2 origins, plaintext, paths and URL credentials', () => {
  for (const endpoint of [
    'http://127.0.0.1',
    'https://example.org',
    `${env.CONTENT_R2_ENDPOINT}/bucket`,
    `${env.CONTENT_R2_ENDPOINT}?secret=private-secret`,
    env.CONTENT_R2_ENDPOINT.replace('https://', 'https://user:private-secret@'),
  ]) {
    expect(() => readContentWorkConfig({ ...env, CONTENT_R2_ENDPOINT: endpoint })).toThrow('CONTENT_R2_ENDPOINT');
  }
  for (const bucket of ['ab', 'ContainsUppercase', '../other', 'media/bucket'])
    expect(() => readContentWorkConfig({ ...env, CONTENT_R2_BUCKET: bucket })).toThrow('CONTENT_R2_BUCKET');
});

test('source allowlist accepts exact DNS names only and never wildcard or network authority', () => {
  for (const hosts of [
    '*',
    '*.example.org',
    'https://example.org',
    'example.org:443',
    'user@example.org',
    '127.0.0.1',
    '[::1]',
    'example.org/path',
    'example.org,',
    'example.org,example.org',
    ' example.org',
    'Example.org',
    'example.org.',
    Array.from({ length: 129 }, (_, i) => `h${i}.example.org`).join(','),
  ]) {
    expect(() => readContentWorkConfig({ ...env, CONTENT_SOURCE_HOSTS: hosts })).toThrow('CONTENT_SOURCE_HOSTS');
  }
});
