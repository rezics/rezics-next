import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { kindConsentOperationBound } from '@rezics/auth-contract';
import type { KindConsentEnrollmentInput, KindConsentParticipant } from '@rezics/auth-contract';
import { testDatabase } from '../scripts/database.ts';
import { createInternalConsentHandler } from '../src/internal-consent.ts';
import { createAuthConsentReader } from '../../kernel/src/access/auth-consent.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';

let fixture: ReturnType<typeof testDatabase>;
let db: GrowthDatabase;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof Bun.serve>;
let server: ReturnType<typeof Bun.serve>;
let handler: ReturnType<typeof createInternalConsentHandler>;
const issuer = 'https://consent-team.cloudflareaccess.com';
const audience = 'private-consent-audience';
const serviceTokenId = 'e367826f93b8d71185e03fe518aff3b4.access';
const input = { actorAccountId: 'person', clientId: 'client' };
const enrollmentInput: KindConsentEnrollmentInput = {
  accountId: 'person',
  clientId: 'client',
  requestedScopes: ['read'],
  consumer: {
    route: 'collection-kind',
    ownerAccountId: 'person',
    collectionId: 'collection',
    preparationId: 'preparation',
    originId: 'origin',
  },
};
const config = () => ({
  database: db.pool,
  issuer,
  audience,
  jwksUrl: `${jwks.url}cdn-cgi/access/certs`,
  allowedServiceTokenIds: [serviceTokenId],
});
async function signed(overrides: JWTPayload = {}, pair = keys, alg = 'RS256', omitExpiry = false) {
  const payload: JWTPayload = {
    type: 'app',
    common_name: serviceTokenId,
    sub: '',
    iss: issuer,
    aud: [audience],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
  if (omitExpiry) delete payload.exp;
  return new SignJWT(payload).setProtectedHeader({ alg, kid: 'access-test' }).sign(pair.privateKey);
}
async function post(token?: string, body: unknown = input, path = '/internal/v1/consents:read') {
  return fetch(new URL(path, server.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}),
    },
    body: JSON.stringify(body),
  });
}
beforeAll(async () => {
  fixture = testDatabase();
  db = await openGrowthDatabase(fixture.url);
  await db.admin.query(`INSERT INTO auth_client VALUES ('client',false,ARRAY['read']);
    INSERT INTO auth_client_coverage (client_id,ready) VALUES ('client',true);
    INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ('person','client',ARRAY['read','old'])`);
  keys = await generateKeyPair('RS256', { extractable: true });
  const key = { ...(await exportJWK(keys.publicKey)), kid: 'access-test', alg: 'RS256' };
  jwks = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ keys: [key] }) });
  handler = createInternalConsentHandler(config());
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
}, 60000);
afterAll(async () => {
  server?.stop(true);
  jwks?.stop(true);
  await db?.close();
  fixture?.close();
});

test('real signed Access JWT HTTP returns only exact consent with private no-store', async () => {
  const response = await post(await signed());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ ...input, scopes: ['read'] });
  const absent = await post(await signed(), { ...input, actorAccountId: 'absent' });
  expect(absent.status).toBe(200);
  expect(await absent.json()).toBeNull();
});

test('missing/expired/foreign/human/forged JWT denies with zero database reads', async () => {
  const foreign = await generateKeyPair('RS256');
  const provider = await generateKeyPair('ES256');
  const tokens = [
    undefined,
    'garbage',
    await signed({ exp: 1 }),
    await signed({ iss: 'https://foreign.test' }),
    await signed({ aud: ['foreign'] }),
    await signed({ aud: [audience, 'foreign'] }),
    await signed({ sub: 'human', email: 'private@example.test' }),
    await signed({ sub: serviceTokenId }),
    await signed({ common_name: 'other.access' }),
    await signed({ type: 'org' }),
    await signed({}, foreign),
    await signed({}, provider, 'ES256'),
    await signed({}, keys, 'RS256', true),
    await signed({ iat: Math.floor(Date.now() / 1000) + 100 }),
  ];
  const result = await capture(db, async () => {
    for (const token of tokens) {
      const response = await post(token);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'denied' });
    }
    const response = await handler(
      new Request(new URL('/internal/v1/consents:read', server.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${await signed()}`, cookie: `CF_Authorization=${await signed()}` },
      }),
    );
    expect(response.status).toBe(403);
  });
  expect(result.capture.statements).toEqual([]);
});

test('authenticated malformed/bulk/query requests never execute reads', async () => {
  const token = await signed();
  const result = await capture(db, async () => {
    for (const body of [
      null,
      [],
      [input],
      { ...input, firstParty: true },
      { ...input, scopes: ['read'] },
      { ...input, actorAccountId: ['person'] },
      { ...input, clientId: '' },
      { ...input, clientId: 'x'.repeat(17000) },
    ]) {
      expect((await post(token, body)).status).toBe(403);
    }
    expect((await post(token, input, '/internal/v1/consents:read?all=true')).status).toBe(403);
    expect(
      (
        await fetch(new URL('/internal/v1/consents:read', server.url), {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        })
      ).status,
    ).toBe(403);
  });
  expect(result.capture.statements).toEqual([]);
  for (const invalid of [
    { ...config(), audience: '' },
    { ...config(), issuer: '' },
    { ...config(), jwksUrl: '' },
    { ...config(), allowedServiceTokenIds: [] },
  ])
    expect(() => createInternalConsentHandler(invalid)).toThrow();
});

test('native kernel HTTP transport sends service credentials and re-reads reductions/deletion', async () => {
  // This test gateway represents Access: only the verified token, never the raw
  // service secret, reaches the Auth listener. JOSE verification still runs there.
  let requests = 0;
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests++;
      expect(request.headers.get('CF-Access-Client-Id')).toBe(serviceTokenId);
      expect(request.headers.get('CF-Access-Client-Secret')).toBe('test-secret');
      const headers = new Headers(request.headers);
      headers.delete('CF-Access-Client-Secret');
      headers.set('Cf-Access-Jwt-Assertion', await signed());
      return fetch(
        new Request(new URL('/internal/v1/consents:read', server.url), {
          method: 'POST',
          headers,
          body: await request.text(),
        }),
      );
    },
  });
  try {
    const read = createAuthConsentReader({
      url: `${gateway.url}internal/v1/consents:read`,
      serviceTokenId,
      serviceTokenSecret: 'test-secret',
    });
    const run = () => read({ ...input, deadline: Date.now() + 3000 });
    expect(await run()).toEqual({ ...input, scopes: ['read'] });
    await db.admin.query(`UPDATE auth_consent SET scopes=ARRAY[]::text[] WHERE account_id='person'`);
    expect(await run()).toEqual({ ...input, scopes: [] });
    await db.admin.query(`DELETE FROM auth_consent WHERE account_id='person'`);
    expect(await run()).toBeNull();
    expect(requests).toBe(3);
  } finally {
    gateway.stop(true);
  }
});

test('database failures disclose only unavailable', async () => {
  const broken = createInternalConsentHandler({
    ...config(),
    database: {
      query() {
        throw new Error('password private@example.test');
      },
    } as unknown as GrowthDatabase['pool'],
  });
  const response = await broken(
    new Request(new URL('/internal/v1/consents:read', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Cf-Access-Jwt-Assertion': await signed() },
      body: JSON.stringify(input),
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'unavailable' });
});

test('short original deadline cancels verification and body work before native enrollment', async () => {
  let slowJwksStarted!: () => void;
  let slowJwksCancelled!: () => void;
  const jwksStarted = new Promise<void>((resolve) => (slowJwksStarted = resolve));
  const jwksCancelled = new Promise<void>((resolve) => (slowJwksCancelled = resolve));
  const slowJwks = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      slowJwksStarted();
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            slowJwksCancelled();
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  let nativeCalls = 0;
  const enroll = Object.assign(
    async (_value: KindConsentEnrollmentInput) => {
      nativeCalls++;
      return { status: 'unavailable' as const };
    },
    {
      bound: kindConsentOperationBound,
      actual: () => undefined,
    },
  );
  const participant: KindConsentParticipant = { enroll };
  const slowHandler = createInternalConsentHandler({
    ...config(),
    jwksUrl: `${slowJwks.url}cdn-cgi/access/certs`,
    kindConsentParticipant: participant,
  });
  let bodyRead = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        bodyRead = true;
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const verificationDeadline = Date.now() + 100;
  const verificationResponse = await slowHandler(
    new Request(new URL('/internal/v1/kind-consents:enroll', server.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Cf-Access-Jwt-Assertion': await signed(),
        'X-Rezics-Kind-Deadline': String(verificationDeadline),
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  );
  await jwksStarted;
  await jwksCancelled;
  expect(verificationResponse.status).toBe(503);
  expect(bodyRead).toBe(false);
  expect(nativeCalls).toBe(0);
  slowJwks.stop(true);

  let bodyCancelled = false;
  let bodyChunkSent = false;
  let bodyReadStarted!: () => void;
  const bodyStarted = new Promise<void>((resolve) => (bodyReadStarted = resolve));
  const stalledBody = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        bodyReadStarted();
        if (!bodyChunkSent) {
          bodyChunkSent = true;
          controller.enqueue(new TextEncoder().encode('{"input":'));
        }
        return new Promise<void>(() => {});
      },
      cancel() {
        bodyCancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const bodyDeadline = Date.now() + 250;
  const bodyResponsePromise = handler(
    new Request(new URL('/internal/v1/kind-consents:enroll', server.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Cf-Access-Jwt-Assertion': await signed(),
        'X-Rezics-Kind-Deadline': String(bodyDeadline),
      },
      body: stalledBody,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  );
  await bodyStarted;
  const bodyResponse = await bodyResponsePromise;
  expect(bodyResponse.status).toBe(503);
  expect(bodyCancelled).toBe(true);
  expect(nativeCalls).toBe(0);

  const headerDeadline = Date.now() + 2_000;
  const mismatchedResponse = await handler(
    new Request(new URL('/internal/v1/kind-consents:enroll', server.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Cf-Access-Jwt-Assertion': await signed(),
        'X-Rezics-Kind-Deadline': String(headerDeadline),
      },
      body: JSON.stringify({ input: enrollmentInput, deadline: headerDeadline - 1 }),
    }),
  );
  expect(mismatchedResponse.status).toBe(403);
  expect(nativeCalls).toBe(0);
});
