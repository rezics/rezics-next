import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(94);
const accountIds = { reader: newId(0x2401), outsider: newId(0x2401) };
type Persona = keyof typeof accountIds | 'anonymous';
const standardQuestion = '00000000-0000-7000-8000-000000000001';
const tokens = new Map<string, string>();
const reader: AccountActor = {
  kind: 'account',
  accountId: accountIds.reader,
  clientId: 'rating-public-reads',
  scopes: ['subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
let database: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let clockOffset = 0;
let readerCredential: (clientId: string, scope: string) => Promise<string>;

function request(method: string, path: string, as: Persona = 'anonymous', body?: unknown) {
  const key = randomUUID();
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        'x-request-id': 'rating-public-reads',
        ...(as === 'anonymous' ? {} : { authorization: `Bearer ${tokens.get(as)!}` }),
        ...(method === 'PUT' || method === 'DELETE' ? { 'idempotency-key': JSON.stringify(key) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function json(response: Response, status = 200) {
  if (response.status !== status)
    throw new Error(`Expected HTTP ${status}, received ${response.status}: ${await response.clone().text()}`);
  return response.json();
}

async function subject(): Promise<string> {
  const key = randomUUID();
  return (
    await createSubject(database.pool, {
      actor: reader,
      target: subjectTarget(routeKey, reader.accountId, key),
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
      [routeOf(spaceId), spaceId, revisionId, at, accountIds.reader],
    );
    await client.query(
      `INSERT INTO community.space_revision(route, space_id, revision_id, predecessor, title, summary, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Rating Realm', '', $4, $5)`,
      [routeOf(spaceId), spaceId, revisionId, at, accountIds.reader],
    );
    await client.query(
      `INSERT INTO community.realm(route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8)`,
      [routeOf(realmId), realmId, spaceId, visibility, GLOBAL_CONTEXT.id, revisionId, at, accountIds.reader],
    );
    await client.query(
      `INSERT INTO community.realm_revision(route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Rating Realm', '', $4, $5, $6, $7)`,
      [routeOf(realmId), realmId, revisionId, visibility, GLOBAL_CONTEXT.id, at, accountIds.reader],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (visibility === 'protected') {
    const reservationId = newId(routeOf(realmId)!);
    const transactionId = randomUUID();
    await database.admin.query(
      `INSERT INTO community.realm_member(route, realm_id, account_id, role, valid, reservation_id, transaction_id)
       VALUES ($1, $2, $3, 'member', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $4, $5)`,
      [routeOf(realmId), realmId, accountIds.reader, reservationId, transactionId],
    );
    await database.admin.query(
      `INSERT INTO access.resource_role_grant
         (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
       VALUES ($1, $2, 'identity', $2, 'member', 'community.realm.member', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $3)`,
      [routeOf(realmId), realmId, transactionId],
    );
    await database.admin.query(
      `INSERT INTO access.membership_inverse
         (route, account_id, kind, group_id, reservation_id, transaction_id, source_transaction_id)
       VALUES ($1, $2, 'realm', $3, $4, $5, $5)`,
      [routeOf(accountIds.reader), accountIds.reader, realmId, reservationId, transactionId],
    );
  }
  return realmId;
}

async function component(input: { targetId: string; populationId: string; count: number; units?: number }) {
  const units = input.units ?? 12;
  const histogram = Array.from({ length: 21 }, (_, index) => (index === units ? input.count : 0));
  await database.admin.query(
    `INSERT INTO rating.aggregate_component
       (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7::bigint[], '2026-10-27T10:00:00.000Z')`,
    [
      routeOf(input.targetId),
      standardQuestion,
      input.populationId,
      input.targetId,
      input.count,
      input.count * units,
      histogram,
    ],
  );
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'rating-public-reads', alg: 'ES256' };
  readerCredential = (clientId, scope) =>
    new SignJWT({ client_id: clientId, scope, authn_epoch: 1, auth_time: Math.floor(Date.now() / 1000), amr: ['pwd'] })
      .setProtectedHeader({ alg: 'ES256', kid: 'rating-public-reads', typ: 'at+jwt' })
      .setIssuer('https://auth.example.test')
      .setAudience('https://api.rezics.test')
      .setSubject(accountIds.reader)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey);
  app = createKernel({
    pool: database.pool,
    writeRate: createWriteRateLimiter({
      secret: 'rating-public-reads-write-rate-secret-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
    routeKey,
    clock: () => new Date(Date.now() + clockOffset),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(24)]]) },
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
  for (const accountId of Object.values(accountIds))
    await database.admin.query(
      `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
       VALUES ($1, $2, 'actor', 'active', $2)`,
      [routeOf(accountId), accountId],
    );
  for (const persona of Object.keys(accountIds) as (keyof typeof accountIds)[]) {
    const accountId = accountIds[persona];
    tokens.set(
      persona,
      await new SignJWT({
        client_id: 'rating-public-reads',
        scope: 'subject:read realm:read',
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'rating-public-reads', typ: 'at+jwt' })
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

test('public rating reads declare their exposure and read actions', () => {
  const document = openApiDocument(app);
  const expected = [
    ['/v1/subjects/{id}/ratings', 'get', 'subject:read'],
    ['/v1/subjects/{id}/ratings/populations', 'get', 'subject:read'],
    ['/v1/rating-questions/{questionId}', 'get', 'definitions:read'],
    ['/v1/subjects/{id}/source-statistics', 'get', 'subject:read'],
  ] as const;
  for (const [path, method, action] of expected) {
    const operation = document.paths[path]?.[method];
    expect(operation?.['x-exposure']).toBe('public');
    expect(operation?.['x-action']).toBe(action);
    expect(operation?.security).toEqual([{ bearerAuth: [] }, {}]);
  }
});

test('Global figures are public at, below, and at zero threshold for anonymous and signed-in readers', async () => {
  const at = await subject();
  const below = await subject();
  const zero = await subject();
  await component({ targetId: at, populationId: GLOBAL_CONTEXT.id, count: 5, units: 13 });
  await component({ targetId: below, populationId: GLOBAL_CONTEXT.id, count: 4, units: 9 });
  for (const persona of ['anonymous', 'reader'] as const) {
    const atFigure = (
      await json(
        await request(
          'GET',
          `/v1/subjects/${at}/ratings?question=${standardQuestion}&population=${GLOBAL_CONTEXT.id}`,
          persona,
        ),
      )
    ).figures[0];
    expect(atFigure).toMatchObject({ population: GLOBAL_CONTEXT.id, count: 5, mean: 13 });
    expect(atFigure.histogram[13]).toBe(5);

    const belowFigure = (
      await json(
        await request(
          'GET',
          `/v1/subjects/${below}/ratings?question=${standardQuestion}&population=${GLOBAL_CONTEXT.id}`,
          persona,
        ),
      )
    ).figures[0];
    expect(belowFigure).toMatchObject({ population: GLOBAL_CONTEXT.id, count: 4, remaining: 1 });
    expect(belowFigure).not.toHaveProperty('mean');
    expect(belowFigure).not.toHaveProperty('histogram');

    const zeroFigure = (
      await json(
        await request(
          'GET',
          `/v1/subjects/${zero}/ratings?question=${standardQuestion}&population=${GLOBAL_CONTEXT.id}`,
          persona,
        ),
      )
    ).figures[0];
    expect(zeroFigure).toEqual({
      population: GLOBAL_CONTEXT.id,
      count: 0,
      freshness: { asOf: null, updating: false },
    });
  }
});

test('Realm figures and population entries follow public and protected read visibility', async () => {
  const subjectId = await subject();
  const publicRealm = await realm('public');
  const protectedRealm = await realm('protected');
  await component({ targetId: subjectId, populationId: GLOBAL_CONTEXT.id, count: 5 });
  await component({ targetId: subjectId, populationId: publicRealm, count: 5, units: 11 });
  await component({ targetId: subjectId, populationId: protectedRealm, count: 5, units: 17 });

  for (const persona of ['anonymous', 'outsider', 'reader'] as const) {
    const result = await json(
      await request(
        'GET',
        `/v1/subjects/${subjectId}/ratings?question=${standardQuestion}&population=${publicRealm}&population=${protectedRealm}`,
        persona,
      ),
    );
    expect(result.figures[0]).toMatchObject({ population: publicRealm, count: 5, mean: 11 });
    if (persona === 'reader') {
      expect(result.figures[1]).toMatchObject({ population: protectedRealm, count: 5, mean: 17 });
    } else {
      expect(result.figures[1]).toEqual({
        population: protectedRealm,
        count: 0,
        freshness: { asOf: null, updating: false },
      });
    }

    const page = await json(
      await request('GET', `/v1/subjects/${subjectId}/ratings/populations?question=${standardQuestion}`, persona),
    );
    const populations = page.populations.map((row: { population: string }) => row.population);
    expect(populations).toContain(GLOBAL_CONTEXT.id);
    expect(populations).toContain(publicRealm);
    expect(populations.includes(protectedRealm)).toBe(persona === 'reader');
  }
});

test('anonymous readers cannot read a hidden subject rating', async () => {
  const hidden = await subject();
  await database.admin.query(
    `UPDATE semantic.subject SET visibility = 'hidden', security_revision = security_revision + 1
     WHERE route = $1 AND subject_id = $2`,
    [routeOf(hidden), hidden],
  );
  const response = await request(
    'GET',
    `/v1/subjects/${hidden}/ratings?question=${standardQuestion}&population=${GLOBAL_CONTEXT.id}`,
  );
  expect(response.status).toBe(404);
});

test('rating questions and source statistics can be read anonymously', async () => {
  const subjectId = await subject();
  await database.admin.query(
    `INSERT INTO rating.source_statistic
       (route, subject_id, source, source_record_id, scale_min, scale_max, mean, count, as_of, licence, attribution, transaction_id)
     VALUES ($1, $2, 'vndb', 'record-1', 0, 10, 8.4, 123, '2026-10-01', 'CC BY 4.0', 'VNDB users', $3)`,
    [routeOf(subjectId), subjectId, randomUUID()],
  );
  expect(await json(await request('GET', `/v1/rating-questions/${standardQuestion}`))).toMatchObject({
    id: standardQuestion,
    label: 'How much did you like this work?',
  });
  expect(await json(await request('GET', `/v1/subjects/${subjectId}/source-statistics`))).toEqual([
    {
      source: 'vndb',
      sourceRecordId: 'record-1',
      scale: { min: 0, max: 10 },
      mean: 8.4,
      count: 123,
      asOf: '2026-10-01',
      licence: 'CC BY 4.0',
      attribution: 'VNDB users',
    },
  ]);
});

test('each vote route requires an account with rating:vote', async () => {
  const subjectId = await subject();
  const vote = `/v1/subjects/${subjectId}/ratings/${standardQuestion}/vote`;
  const calls = [
    ['GET', vote, undefined],
    ['PUT', vote, { units: 9 }],
    ['DELETE', vote, undefined],
  ] as const;
  for (const [method, path, body] of calls) {
    expect((await request(method, path, 'anonymous', body)).status).toBe(401);
    expect((await request(method, path, 'reader', body)).status).toBe(403);
  }
});

test('The mounted rating-question directory returns bounded current native metadata with an authority-bound signed keyset and preserves exact point-read authority and identity', async () => {
  const standard = {
    id: standardQuestion,
    revision: 1,
    label: 'How much did you like this work?',
    grain: 'work',
    scale: { min: 0, max: 20, displayStep: 1 },
  };
  const grains = ['work', 'release', 'episode', 'character'] as const;
  const questions = Array.from({ length: 24 }, (_, index) => ({
    id: `fffe0000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
    revision: index + 2,
    // Reverse labels deliberately: ordering follows identity, never labels or grain.
    label: `Question ${24 - index}`,
    grain: grains[index % grains.length]!,
    scale: { min: 2, max: 14, displayStep: 2 },
  }));
  const denial = randomUUID();
  const directory = '/v1/rating-questions';
  const pagePath = (cursor: string, limit = 20) => `${directory}?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
  const credentialRead = (path: string, token: string) =>
    app.handle(
      new Request(`http://kernel.test${path}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  const problem = async (response: Response, status: number, code: string) => {
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await json(response, status)).toMatchObject({ status, code, type: `https://rezics.com/problems/${code}` });
  };
  try {
    for (const question of questions)
      await database.admin.query(
        `INSERT INTO rating.question (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          question.id,
          accountIds.reader,
          question.revision,
          question.label,
          question.grain,
          question.scale.min,
          question.scale.max,
          question.scale.displayStep,
        ],
      );

    const operation = openApiDocument(app).paths[directory]?.get;
    expect(operation?.['x-action']).toBe('definitions:read');
    expect(operation?.['x-exposure']).toBe('public');
    expect(operation?.security).toEqual([{ bearerAuth: [] }, {}]);
    expect(app.routes.filter((route) => route.path === directory && route.method === 'GET')).toHaveLength(1);

    const expectedFirst = [standard, ...questions.slice(0, 19)];
    const first = await json(await request('GET', directory));
    expect(Object.keys(first).sort()).toEqual(['next', 'ratingQuestions']);
    expect(first.ratingQuestions).toEqual(expectedFirst);
    expect(typeof first.next).toBe('string');
    expect(first.next.length).toBeLessThanOrEqual(4096);
    for (const persona of ['reader', 'outsider'] as const) {
      const page = await json(await request('GET', directory, persona));
      expect(page.ratingQuestions).toEqual(expectedFirst);
      expect(await json(await request('GET', `/v1/rating-questions/${questions[0]!.id}`, persona))).toEqual(
        questions[0],
      );
    }
    expect(await json(await request('GET', `/v1/rating-questions/${standardQuestion}`))).toEqual(standard);
    await problem(await request('GET', `/v1/rating-questions/${newId(0)}`), 404, 'not_found');

    const single = await json(await request('GET', `${directory}?limit=1`));
    expect(single.ratingQuestions).toEqual([standard]);
    const nextSingle = await json(await request('GET', pagePath(single.next, 1)));
    expect(nextSingle.ratingQuestions).toEqual([questions[0]]);

    // Metadata changes do not invalidate directory positions or freeze later revisions.
    const changed = questions[20]!;
    changed.revision += 1;
    changed.label = 'Current revised episode question';
    changed.grain = 'episode';
    changed.scale = { min: 4, max: 28, displayStep: 4 };
    await database.admin.query(
      `UPDATE rating.question SET revision=$2, label=$3, grain=$4, minimum_units=$5, maximum_units=$6, step_units=$7 WHERE id=$1`,
      [
        changed.id,
        changed.revision,
        changed.label,
        changed.grain,
        changed.scale.min,
        changed.scale.max,
        changed.scale.displayStep,
      ],
    );
    const last = await json(await request('GET', pagePath(first.next)));
    expect(last).toEqual({ ratingQuestions: questions.slice(19), next: null });
    expect(await json(await request('GET', `/v1/rating-questions/${changed.id}`))).toEqual(changed);
    expect(new Set([...first.ratingQuestions, ...last.ratingQuestions].map((row: { id: string }) => row.id)).size).toBe(
      25,
    );

    for (const query of [
      'limit=0',
      'limit=21',
      'limit=-1',
      'limit=1.5',
      'limit=no',
      'limit=',
      'limit=1&limit=1',
      'cursor=a&cursor=b',
      'cursor=',
      `cursor=${'a'.repeat(4097)}`,
      'query=Question',
      'grain=work',
      `selectedId=${standardQuestion}`,
      'total=true',
    ])
      await problem(await request('GET', `${directory}?${query}`), 400, 'invalid_request');
    await problem(await request('GET', `${directory}?cursor=malformed`), 400, 'invalid_cursor');
    const tampered = `${first.next.slice(0, -1)}${first.next.endsWith('a') ? 'b' : 'a'}`;
    await problem(await request('GET', pagePath(tampered)), 400, 'invalid_cursor');
    await problem(await request('GET', pagePath(first.next, 1)), 400, 'invalid_cursor');
    await problem(await request('GET', pagePath(first.next), 'reader'), 400, 'invalid_cursor');
    const readerPage = await json(await request('GET', directory, 'reader'));
    await problem(await request('GET', pagePath(readerPage.next)), 400, 'invalid_cursor');
    await problem(await request('GET', pagePath(readerPage.next), 'outsider'), 400, 'invalid_cursor');
    for (const [client, scope] of [
      ['rating-public-reads-other', 'subject:read realm:read'],
      ['rating-public-reads', 'subject:read'],
    ]) {
      const token = await readerCredential(client!, scope!);
      expect((await credentialRead(directory, token)).status).toBe(200);
      await problem(await credentialRead(pagePath(readerPage.next), token), 400, 'invalid_cursor');
    }

    clockOffset = 16 * 60_000;
    try {
      await problem(await request('GET', pagePath(first.next)), 400, 'invalid_cursor');
    } finally {
      clockOffset = 0;
    }

    // The owner of every fixture question is still denied by current Global authority.
    await database.admin.query(
      `INSERT INTO access.resource_denial (route, resource_id, subject_id, action, reason, valid, transaction_id)
       VALUES (0, $1, $2, 'definitions:read', 'resource', '(,)'::tstzrange, $3)`,
      [GLOBAL_CONTEXT.id, accountIds.reader, denial],
    );
    await problem(await request('GET', directory, 'reader'), 404, 'not_found');
    await problem(await request('GET', pagePath(readerPage.next), 'reader'), 404, 'not_found');
    await problem(await request('GET', `/v1/rating-questions/${questions[0]!.id}`, 'reader'), 404, 'not_found');
    expect((await request('GET', directory)).status).toBe(200);
    await database.admin.query('DELETE FROM access.resource_denial WHERE transaction_id=$1', [denial]);
    expect((await request('GET', pagePath(readerPage.next), 'reader')).status).toBe(200);

    await database.admin.query('DELETE FROM rating.question WHERE id = ANY($1::uuid[])', [
      questions.slice(19).map((q) => q.id),
    ]);
    expect(await json(await request('GET', pagePath(first.next)))).toEqual({ ratingQuestions: [], next: null });
  } finally {
    clockOffset = 0;
    await database.admin.query('DELETE FROM access.resource_denial WHERE transaction_id=$1', [denial]);
    await database.admin.query('DELETE FROM rating.question WHERE id = ANY($1::uuid[])', [questions.map((q) => q.id)]);
  }
});
