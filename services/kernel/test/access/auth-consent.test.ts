import { MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPE_OCTETS } from '@rezics/auth-contract';
import { expect, test } from 'bun:test';
import { createAuthConsentReader, readAuthConsentConfig } from '../../src/access/auth-consent.ts';
import { ConfigError } from '../../src/commerce/config.ts';
import { AccessUnavailableError } from '../../src/access/index.ts';

const url = 'https://auth.private.test/internal/v1/consents:read';
const config = { url, serviceTokenId: 'worker.access', serviceTokenSecret: 'private-secret' };
const input = { actorAccountId: 'person', clientId: 'client', deadline: Date.now() + 10000 };
const consent = { actorAccountId: 'person', clientId: 'client', scopes: ['read'] };
test('exact HTTPS POST uses only server URL and credentials', async () => {
  let calls = 0;
  const read = createAuthConsentReader({
    ...config,
    async fetch(target, init) {
      calls++;
      expect(target).toBe(url);
      expect(init.redirect).toBe('error');
      expect(init.method).toBe('POST');
      expect(init.cache).toBe('no-store');
      expect(new Headers(init.headers).get('CF-Access-Client-Secret')).toBe('private-secret');
      expect(JSON.parse(init.body as string)).toEqual({ actorAccountId: 'person', clientId: 'client' });
      return Response.json(consent);
    },
  });
  expect(await read(input)).toEqual(consent);
  expect(await read(input)).toEqual(consent);
  expect(calls).toBe(2);
});
test('missing/forged/malformed/oversized/error responses fail closed', async () => {
  for (const value of [
    null,
    {},
    [],
    { ...consent, actorAccountId: 'other' },
    { ...consent, clientId: 'other' },
    { ...consent, email: 'private@example.test' },
    { ...consent, scopes: ['bad scope'] },
    { ...consent, scopes: Array(MAX_CONSENTED_SCOPES + 1).fill('read') },
    { ...consent, scopes: ['x'.repeat(129)] },
  ]) {
    expect(await createAuthConsentReader({ ...config, fetch: async () => Response.json(value) })(input)).toBeNull();
  }
  for (const response of [
    new Response('x'.repeat(MAX_CONSENTED_SCOPE_OCTETS + 2 * MAX_CONSENTED_SCOPES + 4 * 1024 + 129)),
    new Response('not JSON'),
    new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    new Response('secret', { status: 503 }),
  ])
    expect(await createAuthConsentReader({ ...config, fetch: async () => response })(input)).toBeNull();
  expect(
    await createAuthConsentReader({
      ...config,
      fetch: async () => {
        throw new Error('private-secret');
      },
    })(input),
  ).toBeNull();
});
test('deadline bounds fetch and body, including transports which ignore abort', async () => {
  for (const [fetch, timesOut] of [
    [async () => new Promise<Response>(() => {}), true],
    [async () => new Response(new ReadableStream({ start() {} })), false],
  ] as const) {
    const read = createAuthConsentReader({ ...config, fetch });
    const result = read({ ...input, deadline: Date.now() + 20 });
    if (timesOut) await expect(result).rejects.toBeInstanceOf(AccessUnavailableError);
    else expect(await result).toBeNull();
  }
  let calls = 0;
  const read = createAuthConsentReader({
    ...config,
    fetch: async () => {
      calls++;
      return Response.json(consent);
    },
  });
  for (const invalid of [
    { ...input, deadline: NaN },
    { ...input, clientId: '' },
    { ...input, actorAccountId: 'x'.repeat(1025) },
    { ...input, firstParty: true },
  ])
    expect(await read(invalid)).toBeNull();
  await expect(read({ ...input, deadline: 0 })).rejects.toBeInstanceOf(AccessUnavailableError);
  expect(calls).toBe(0);
});
test('configuration rejects insecure/noncanonical URLs and missing secrets', () => {
  for (const bad of [
    'http://auth.private.test/internal/v1/consents:read',
    'https://user:pass@auth.test/internal/v1/consents:read',
    `${url}?all=true`,
    `${url}#fragment`,
    'https://auth.test/other',
    'http://127.0.0.2/internal/v1/consents:read',
  ])
    expect(() => createAuthConsentReader({ ...config, url: bad })).toThrow();
  expect(() => createAuthConsentReader({ ...config, serviceTokenSecret: '' })).toThrow();
});

test('streamed oversized bodies and stalled JSON streams cancel within the deadline', async () => {
  let cancellations = 0;
  const headers = { 'content-type': 'application/json' };
  const oversized = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CONSENTED_SCOPE_OCTETS + 2 * MAX_CONSENTED_SCOPES + 4 * 1024 + 129));
      },
      cancel() {
        cancellations++;
      },
    }),
    { headers },
  );
  expect(
    await createAuthConsentReader({ ...config, fetch: async () => oversized })({
      ...input,
      deadline: Date.now() + 1000,
    }),
  ).toBeNull();
  const stalled = new Response(
    new ReadableStream({
      cancel() {
        cancellations++;
      },
    }),
    { headers },
  );
  await expect(
    createAuthConsentReader({ ...config, fetch: async () => stalled })({ ...input, deadline: Date.now() + 20 }),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
  expect(cancellations).toBe(2);
});

const consentEnv = {
  KERNEL_AUTH_CONSENT_URL: 'https://consent.example.test/internal/v1/consents:read',
  CF_ACCESS_CLIENT_ID: 'access-client-id',
  CF_ACCESS_CLIENT_SECRET: 'access-client-secret',
};

test('the shared Auth consent group is absent or complete and errors name only variables', () => {
  expect(readAuthConsentConfig({})).toBeNull();
  expect(readAuthConsentConfig({ CONTENT_SOURCE_HOSTS: 'ignored' })).toBeNull();
  const complete = readAuthConsentConfig(consentEnv);
  expect(complete).toEqual({
    url: consentEnv.KERNEL_AUTH_CONSENT_URL,
    serviceTokenId: consentEnv.CF_ACCESS_CLIENT_ID,
    serviceTokenSecret: consentEnv.CF_ACCESS_CLIENT_SECRET,
  });
  expect(Object.isFrozen(complete)).toBe(true);
  expect(() => readAuthConsentConfig({ CF_ACCESS_CLIENT_ID: consentEnv.CF_ACCESS_CLIENT_ID })).toThrow(
    'KERNEL_AUTH_CONSENT_URL',
  );
  expect(() =>
    readAuthConsentConfig({
      KERNEL_AUTH_CONSENT_URL: consentEnv.KERNEL_AUTH_CONSENT_URL,
      CF_ACCESS_CLIENT_SECRET: consentEnv.CF_ACCESS_CLIENT_SECRET,
    }),
  ).toThrow('CF_ACCESS_CLIENT_ID');
  expect(() =>
    readAuthConsentConfig({
      KERNEL_AUTH_CONSENT_URL: consentEnv.KERNEL_AUTH_CONSENT_URL,
      CF_ACCESS_CLIENT_ID: consentEnv.CF_ACCESS_CLIENT_ID,
    }),
  ).toThrow('CF_ACCESS_CLIENT_SECRET');

  for (const key of Object.keys(consentEnv) as (keyof typeof consentEnv)[]) {
    expect(() => readAuthConsentConfig({ ...consentEnv, [key]: '' })).toThrow(key);
  }

  let consentFailure: unknown;
  try {
    readAuthConsentConfig({
      ...consentEnv,
      KERNEL_AUTH_CONSENT_URL: 'https://consent-user-secret:hidden@consent.example.test/internal/v1/consents:read',
    });
  } catch (error) {
    consentFailure = error;
  }
  expect(consentFailure).toBeInstanceOf(ConfigError);
  expect(String(consentFailure)).toContain('KERNEL_AUTH_CONSENT_URL');
  expect(String(consentFailure)).not.toContain('consent-user-secret');
  expect(String(consentFailure)).not.toContain('hidden');
});

test('Auth consent configuration preserves exact private HTTPS endpoint and visible ASCII bounds', () => {
  for (const target of [
    'not-a-url',
    'http://127.0.0.1/internal/v1/consents:read',
    'https://auth.private.test/',
    `${url}/other`,
    `${url}?secret=hidden`,
    `${url}#hidden`,
    url.replace('https://', 'https://hidden@'),
  ]) {
    expect(() => readAuthConsentConfig({ ...consentEnv, KERNEL_AUTH_CONSENT_URL: target })).toThrow(
      'KERNEL_AUTH_CONSENT_URL',
    );
  }
  for (const variable of Object.keys(consentEnv) as (keyof typeof consentEnv)[]) {
    for (const value of [' secret', 'secret ', 'secret\n', '\u79d8\u5bc6', 'x'.repeat(1025)]) {
      let failure: unknown;
      try {
        readAuthConsentConfig({ ...consentEnv, [variable]: value });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConfigError);
      expect(String(failure)).toContain(variable);
      expect(String(failure)).not.toContain(value);
    }
  }
  expect(readAuthConsentConfig({ ...consentEnv, CF_ACCESS_CLIENT_SECRET: 'x'.repeat(1024) })).not.toBeNull();
});
