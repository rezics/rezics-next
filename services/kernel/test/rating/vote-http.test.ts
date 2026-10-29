import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(93);
const accountIds = {
  owner: newId(0x2201),
  other: newId(0x2201),
  suspended: newId(0x2201),
  unscoped: newId(0x2201),
};
type Persona = keyof typeof accountIds | 'anonymous';
const tokens = new Map<string, string>();
const scopes = ['subject:read', 'rating:vote'];
const owner: AccountActor = {
  kind: 'account',
  accountId: accountIds.owner,
  clientId: 'rating-vote-http',
  scopes,
  requestedBy: null,
  authnEpoch: 1,
};
let database: GrowthDatabase;
let app: ReturnType<typeof createKernel>;

function request(
  method: string,
  path: string,
  body?: unknown,
  as: Persona = 'owner',
  key: string | null = randomUUID(),
) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        'x-request-id': 'rating-vote-http',
        ...(as === 'anonymous' ? {} : { authorization: `Bearer ${tokens.get(as)!}` }),
        ...(key === null ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function subject() {
  const key = randomUUID();
  return (
    await createSubject(database.pool, {
      actor: owner,
      target: subjectTarget(routeKey, owner.accountId, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: key } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
}

async function json(response: Response, status = 200) {
  if (response.status !== status)
    throw new Error(`Expected HTTP ${status}, received ${response.status}: ${await response.clone().text()}`);
  return response.json();
}

async function problem(response: Response, status: number) {
  if (response.status !== status)
    throw new Error(`Expected HTTP ${status}, received ${response.status}: ${await response.clone().text()}`);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = await response.json();
  expect(body).toMatchObject({ status });
  expect(body.type).toBe(`https://rezics.com/problems/${body.code}`);
  return body;
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'rating-vote-http', alg: 'ES256' };
  app = createKernel({
    pool: database.pool,
    writeRate: createWriteRateLimiter({
      secret: 'rating-vote-http-write-rate-secret-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
    routeKey,
    clock: () => new Date(),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.example.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.example.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
  });
  for (const [persona, accountId] of Object.entries(accountIds)) {
    await database.admin.query(
      `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
       VALUES ($1, $2, 'actor', $3, $2)`,
      [routeOf(accountId), accountId, persona === 'suspended' ? 'suspended' : 'active'],
    );
    const tokenScopes = persona === 'unscoped' ? ['subject:read'] : scopes;
    tokens.set(
      persona,
      await new SignJWT({
        client_id: 'rating-vote-http',
        scope: tokenScopes.join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'rating-vote-http', typ: 'at+jwt' })
        .setIssuer('https://auth.example.test')
        .setAudience('https://api.rezics.test')
        .setSubject(accountId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }
  await database.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [randomUUID()],
  );
});

afterAll(async () => {
  await database?.close();
});

test('rating question and own vote routes are mounted once with their declared action', () => {
  const document = openApiDocument(app);
  const expected = [
    {
      path: '/v1/subjects/{id}/ratings/{questionId}/vote',
      methods: ['put', 'delete', 'get'],
      action: 'rating:vote',
      exposure: 'gate:personal_library',
      security: [{ bearerAuth: [] }],
    },
    {
      path: '/v1/rating-questions/{questionId}',
      methods: ['get'],
      action: 'definitions:read',
      exposure: 'public',
      security: [{ bearerAuth: [] }, {}],
    },
  ];
  for (const { path, methods, action, exposure, security } of expected)
    for (const method of methods) {
      expect(document.paths[path]?.[method]?.['x-action']).toBe(action);
      expect(document.paths[path]?.[method]?.['x-exposure']).toBe(exposure);
      expect(document.paths[path]?.[method]?.security).toEqual(security);
      if (path.endsWith('/vote') && (method === 'put' || method === 'delete'))
        expect(document.paths[path]?.[method]?.responses?.[method === 'put' ? '200' : '204']?.headers).toHaveProperty(
          'rezics-session-token',
        );
      const native = path.replace(/\{(\w+)\}/g, ':$1');
      expect(app.routes.filter((route) => route.path === native && route.method.toLowerCase() === method)).toHaveLength(
        1,
      );
    }
});

test('votes use strict integer JSON, require idempotency keys, and can be read or tombstoned by their owner', async () => {
  const subjectId = await subject();
  const base = `/v1/subjects/${subjectId}/ratings/00000000-0000-7000-8000-000000000001/vote`;
  await problem(await request('PUT', base, { units: 5 }, 'owner', null), 400);
  await problem(await request('PUT', base, { units: 5, extra: true }), 400);
  await problem(await request('PUT', base, { units: 5.5 }), 400);

  const written = await json(await request('PUT', base, { units: 14 }));
  expect(written).toEqual({ units: 14, revision: 1, at: expect.any(String) });
  expect(await json(await request('GET', base))).toEqual(written);

  expect((await request('DELETE', base, undefined, 'owner')).status).toBe(204);
  await problem(await request('GET', base), 404);
  const tombstone = await database.admin.query(
    `SELECT units, revision FROM rating.vote WHERE voter_id = $1 AND question_id = $2 AND target_id = $3`,
    [accountIds.owner, '00000000-0000-7000-8000-000000000001', subjectId],
  );
  expect(tombstone.rows).toEqual([{ units: null, revision: 2 }]);
});

test('a vote read always belongs to the authenticated account', async () => {
  const subjectId = await subject();
  const base = `/v1/subjects/${subjectId}/ratings/00000000-0000-7000-8000-000000000001/vote`;
  const ownerVote = await json(await request('PUT', base, { units: 7 }));
  await problem(await request('GET', base, undefined, 'other'), 404);
  const otherVote = await json(await request('PUT', base, { units: 12 }, 'other'));
  expect(await json(await request('GET', base))).toEqual(ownerVote);
  expect(await json(await request('GET', base, undefined, 'other'))).toEqual(otherVote);
});

test('rating question reads return the stored label, grain, and integer unit scale', async () => {
  expect(await json(await request('GET', '/v1/rating-questions/00000000-0000-7000-8000-000000000001'))).toEqual({
    id: '00000000-0000-7000-8000-000000000001',
    revision: 1,
    label: 'How much did you like this work?',
    grain: 'work',
    scale: { min: 0, max: 20, displayStep: 1 },
  });
});

test('anonymous, suspended, and unscoped callers cannot use rating routes', async () => {
  const subjectId = await subject();
  const vote = `/v1/subjects/${subjectId}/ratings/00000000-0000-7000-8000-000000000001/vote`;
  for (const persona of ['anonymous', 'suspended', 'unscoped'] as const) {
    const expected = persona === 'anonymous' ? [401] : [401, 403];
    for (const [method, path, body] of [
      ['GET', vote, undefined],
      ['PUT', vote, { units: 9 }],
      ['DELETE', vote, undefined],
    ] as const) {
      const response = await request(method, path, body, persona);
      expect(expected).toContain(response.status);
      await problem(response, response.status);
    }
  }
});
