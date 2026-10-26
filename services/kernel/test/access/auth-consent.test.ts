import { expect, test } from 'bun:test';
import { createAuthConsentReader } from '../../src/access/auth-consent.ts';
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
    { ...consent, scopes: Array(101).fill('read') },
    { ...consent, scopes: ['x'.repeat(129)] },
  ]) {
    expect(await createAuthConsentReader({ ...config, fetch: async () => Response.json(value) })(input)).toBeNull();
  }
  for (const response of [
    new Response('x'.repeat(32769)),
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
        controller.enqueue(new Uint8Array(32769));
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
