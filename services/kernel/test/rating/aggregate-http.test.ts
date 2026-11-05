import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(93);
const accountId = newId(0x2201);
const tokens = new Map<string, string>();
const scopes = ['subject:read', 'rating:vote'];
const reader: AccountActor = {
  kind: 'account',
  accountId,
  clientId: 'rating-aggregate-http',
  scopes,
  requestedBy: null,
  authnEpoch: 1,
};
const standardQuestion = '00000000-0000-7000-8000-000000000001';
const episodeQuestion = '00000000-0000-7000-8000-000000000002';
const characterQuestion = '00000000-0000-7000-8000-000000000003';
let database: GrowthDatabase;
let app: ReturnType<typeof createKernel>;

function request(path: string) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      headers: { 'x-request-id': 'rating-aggregate-http', authorization: `Bearer ${tokens.get('reader')!}` },
    }),
  );
}

async function json(response: Response, status = 200) {
  if (response.status !== status)
    throw new Error(`Expected HTTP ${status}, received ${response.status}: ${await response.clone().text()}`);
  return response.json();
}

async function subject() {
  const key = randomUUID();
  return (
    await createSubject(database.pool, {
      actor: reader,
      target: subjectTarget(routeKey, accountId, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: key } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
}

async function realm(visibility: 'public' | 'protected') {
  const realmId = newId(0x3310);
  const spaceId = newId(0x3310);
  const revisionId = newId(0x3310);
  const at = new Date().toISOString();
  const client = await database.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO community.space(route, space_id, state, head_revision_id, created_at, creator)
       VALUES ($1, $2, 'active', $3, $4, $5)`,
      [routeOf(spaceId), spaceId, revisionId, at, accountId],
    );
    await client.query(
      `INSERT INTO community.space_revision(route, space_id, revision_id, predecessor, title, summary, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Rating Realm', '', $4, $5)`,
      [routeOf(spaceId), spaceId, revisionId, at, accountId],
    );
    await client.query(
      `INSERT INTO community.realm(route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8)`,
      [routeOf(realmId), realmId, spaceId, visibility, GLOBAL_CONTEXT.id, revisionId, at, accountId],
    );
    await client.query(
      `INSERT INTO community.realm_revision(route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Rating Realm', '', $4, $5, $6, $7)`,
      [routeOf(realmId), realmId, revisionId, visibility, GLOBAL_CONTEXT.id, at, accountId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return realmId;
}

async function component(input: {
  targetId: string;
  questionId?: string;
  populationId: string;
  count: number;
  units?: number;
  at?: string;
}) {
  const units = input.units ?? 12;
  const histogram = Array.from({ length: 21 }, (_, index) => (index === units ? input.count : 0));
  await database.admin.query(
    `INSERT INTO rating.aggregate_component
       (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7::bigint[], $8)`,
    [
      routeOf(input.targetId),
      input.questionId ?? standardQuestion,
      input.populationId,
      input.targetId,
      input.count,
      input.count * units,
      histogram,
      input.at ?? '2026-10-27T10:00:00.000Z',
    ],
  );
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'rating-aggregate-http', alg: 'ES256' };
  app = createKernel({
    pool: database.pool,
    writeRate: createWriteRateLimiter({
      secret: 'rating-aggregate-http-write-rate-secret-32-bytes',
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
  await database.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $2)`,
    [routeOf(accountId), accountId],
  );
  tokens.set(
    'reader',
    await new SignJWT({
      client_id: 'rating-aggregate-http',
      scope: scopes.join(' '),
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'rating-aggregate-http', typ: 'at+jwt' })
      .setIssuer('https://auth.example.test')
      .setAudience('https://api.rezics.test')
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey),
  );
  await database.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [randomUUID()],
  );
  await database.admin.query(
    `INSERT INTO rating.question(id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units)
     VALUES ($1, NULL, 1, 'How much did you like this episode?', 'episode', 0, 20, 1),
            ($2, NULL, 1, 'How much did you like this character?', 'character', 0, 20, 1)`,
    [episodeQuestion, characterQuestion],
  );
});

afterAll(async () => {
  await database?.close();
});

test('aggregate routes are mounted once with their declared action', () => {
  const document = openApiDocument(app);
  const expected = {
    '/v1/subjects/{id}/ratings': ['get'],
    '/v1/subjects/{id}/ratings/populations': ['get'],
  };
  for (const [path, methods] of Object.entries(expected))
    for (const method of methods) {
      expect(document.paths[path]?.[method]?.['x-action']).toBe('subject:read');
      expect(document.paths[path]?.[method]?.['x-exposure']).toBe('public');
      expect(document.paths[path]?.[method]?.security).toEqual([{ bearerAuth: [] }, {}]);
      const native = path.replace(/\{(\w+)\}/g, ':$1');
      expect(app.routes.filter((route) => route.path === native && route.method.toLowerCase() === method)).toHaveLength(
        1,
      );
    }
});

test('aggregate figures reveal work scores at five votes and keep population freshness separate', async () => {
  const subjectId = await subject();
  const publicRealm = await realm('public');
  const protectedRealm = await realm('protected');
  await component({ targetId: subjectId, populationId: GLOBAL_CONTEXT.id, count: 5, units: 13 });
  await component({ targetId: subjectId, populationId: publicRealm, count: 4, units: 9 });
  await component({ targetId: subjectId, populationId: protectedRealm, count: 8, units: 18 });
  await database.admin.query(
    `INSERT INTO rating.population_pending(route, population_id, pending_jobs) VALUES ($1, $2, 2)`,
    [routeOf(publicRealm), publicRealm],
  );
  const result = await json(
    await request(
      `/v1/subjects/${subjectId}/ratings?question=${standardQuestion}&population=${GLOBAL_CONTEXT.id}&population=${publicRealm}&population=${protectedRealm}`,
    ),
  );
  expect(result.figures).toHaveLength(3);
  expect(result.figures[0]).toMatchObject({
    population: GLOBAL_CONTEXT.id,
    count: 5,
    mean: 13,
    freshness: { asOf: '2026-10-27T10:00:00.000Z', updating: false },
  });
  expect(result.figures[0].histogram[13]).toBe(5);
  expect(result.figures[1]).toMatchObject({
    population: publicRealm,
    count: 4,
    remaining: 1,
    freshness: { asOf: '2026-10-27T10:00:00.000Z', updating: true },
  });
  expect(result.figures[1]).not.toHaveProperty('mean');
  expect(result.figures[1]).not.toHaveProperty('histogram');
  expect(result.figures[2]).toMatchObject({
    population: protectedRealm,
    count: 0,
    freshness: { asOf: null, updating: false },
  });
  expect(result.figures[2]).not.toHaveProperty('remaining');
  expect(result.figures[2]).not.toHaveProperty('mean');
});

test('fine-grain scores remain hidden through nine votes and no-vote populations expose only zero plus freshness', async () => {
  const subjectId = await subject();
  const emptyRealm = await realm('public');
  await component({
    targetId: subjectId,
    questionId: episodeQuestion,
    populationId: GLOBAL_CONTEXT.id,
    count: 9,
    units: 16,
  });
  const result = await json(
    await request(
      `/v1/subjects/${subjectId}/ratings?question=${episodeQuestion}&population=${GLOBAL_CONTEXT.id}&population=${emptyRealm}`,
    ),
  );
  expect(result.figures[0]).toMatchObject({ population: GLOBAL_CONTEXT.id, count: 9, remaining: 1 });
  expect(result.figures[0]).not.toHaveProperty('histogram');
  expect(result.figures[0]).not.toHaveProperty('mean');
  expect(result.figures[1]).toEqual({
    population: emptyRealm,
    count: 0,
    freshness: { asOf: null, updating: false },
  });
});

test('unknown subjects are undisclosed as 404 and only rated readable populations are paged', async () => {
  const subjectId = await subject();
  const realms = await Promise.all(Array.from({ length: 21 }, () => realm('public')));
  const protectedRealm = await realm('protected');
  for (const populationId of [GLOBAL_CONTEXT.id, ...realms, protectedRealm])
    await component({ targetId: subjectId, populationId, count: 1, units: 10 });

  const missing = newId(routeOf(subjectId)!);
  expect(
    (await request(`/v1/subjects/${missing}/ratings?question=${standardQuestion}&population=${GLOBAL_CONTEXT.id}`))
      .status,
  ).toBe(404);

  const first = await json(await request(`/v1/subjects/${subjectId}/ratings/populations?question=${standardQuestion}`));
  expect(first.populations).toHaveLength(20);
  expect(first.next).toEqual(expect.any(String));
  const second = await json(
    await request(
      `/v1/subjects/${subjectId}/ratings/populations?question=${standardQuestion}&cursor=${encodeURIComponent(first.next)}`,
    ),
  );
  expect(second.next).toBeNull();
  const all = [...first.populations, ...second.populations];
  expect(all).toHaveLength(22);
  expect(all.map((row: { population: string }) => row.population)).not.toContain(protectedRealm);
  expect(all.map((row: { population: string }) => row.population)).toContain(GLOBAL_CONTEXT.id);
});
