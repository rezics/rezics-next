import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(93);
const voterId = newId(0x2201);
const persona = 'rating-vote-session-http';
const tokens = new Map<string, string>();
const tokenKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
const actor: AccountActor = {
  kind: 'account',
  accountId: voterId,
  clientId: persona,
  scopes: ['subject:read', 'rating:vote'],
  requestedBy: null,
  authnEpoch: 1,
};
let database: GrowthDatabase;
let app: ReturnType<typeof createKernel>;

function request(method: string, path: string, body?: unknown, key = randomUUID()) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        'x-request-id': persona,
        authorization: `Bearer ${tokens.get('voter')!}`,
        'idempotency-key': JSON.stringify(key),
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
      actor,
      target: subjectTarget(routeKey, voterId, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: key } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
}

async function receipt(key: string) {
  const result = await database.admin.query<{ partition_no: number; epoch: number; position: string }>(
    `SELECT partition_no, epoch, position::text FROM core.receipt
     WHERE principal_kind = 'account' AND principal_id = $1 AND command_kind = 'rating.vote.put' AND idempotency_key = $2`,
    [voterId, key],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function responseBody(response: Response) {
  expect(response.status).toBe(200);
  return response.json();
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: persona, alg: 'ES256' };
  app = createKernel({
    pool: database.pool,
    writeRate: createWriteRateLimiter({
      secret: 'rating-vote-session-http-write-rate-secret-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
    routeKey,
    clock: () => new Date(),
    tokens: tokenKeys,
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
  await database.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $2)`,
    [routeOf(voterId), voterId],
  );
  tokens.set(
    'voter',
    await new SignJWT({
      client_id: persona,
      scope: 'subject:read rating:vote',
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: persona, typ: 'at+jwt' })
      .setIssuer('https://auth.example.test')
      .setAudience('https://api.rezics.test')
      .setSubject(voterId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey),
  );
  await database.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [randomUUID()],
  );
});

afterAll(async () => {
  await database?.close();
});

test('a first PUT, changing PUT, and DELETE answer the voter session component at their committed position', async () => {
  const subjectId = await subject();
  const path = `/v1/subjects/${subjectId}/ratings/00000000-0000-7000-8000-000000000001/vote`;

  for (const [method, body] of [
    ['PUT', { units: 5 }],
    ['PUT', { units: 9 }],
    ['DELETE', undefined],
  ] as const) {
    const key = randomUUID();
    const response = await request(method, path, body, key);
    expect(response.status).toBe(method === 'DELETE' ? 204 : 200);
    const session = response.headers.get(SESSION_HEADER);
    expect(session).toBeTruthy();
    const [component] = decodeSession(tokenKeys, `account:${voterId}`, session!) ?? [];
    expect(component).toBeDefined();
    const committed = await receipt(key);
    expect(component).toEqual({
      partition: committed.partition_no,
      epoch: committed.epoch,
      position: expect.any(BigInt),
    });
    expect(component!.position).toBeGreaterThanOrEqual(BigInt(committed.position));
  }
});

test('replaying a vote command answers the same body and component, while an unchanged PUT answers no token', async () => {
  const subjectId = await subject();
  const path = `/v1/subjects/${subjectId}/ratings/00000000-0000-7000-8000-000000000001/vote`;
  const key = randomUUID();
  const first = await request('PUT', path, { units: 8 }, key);
  const firstBody = await responseBody(first);
  const firstSession = first.headers.get(SESSION_HEADER);
  expect(firstSession).toBeTruthy();

  const replay = await request('PUT', path, { units: 8 }, key);
  expect(await responseBody(replay)).toEqual(firstBody);
  const replaySession = replay.headers.get(SESSION_HEADER);
  expect(replaySession).toBeTruthy();
  expect(decodeSession(tokenKeys, `account:${voterId}`, replaySession!)).toEqual(
    decodeSession(tokenKeys, `account:${voterId}`, firstSession!),
  );

  const unchanged = await request('PUT', path, { units: 8 }, randomUUID());
  expect(await responseBody(unchanged)).toEqual(firstBody);
  expect(unchanged.headers.get(SESSION_HEADER)).toBeNull();
});
