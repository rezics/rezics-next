import { testReceiptKeys } from '../support/receipt-keys.ts';
// Cost: at most one current row per admitted provider; observation/fence work is indexed.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sourceObservation } from '../../src/rating/source-provider.ts';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(121);
const accountIds = {
  owner: newId(0x2301),
  importer: newId(0x2301),
  ungranted: newId(0x2301),
};
type Persona = keyof typeof accountIds | 'anonymous';
const tokens = new Map<string, string>();
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
        'x-request-id': 'source-statistics-test',
        ...(as === 'anonymous' ? {} : { authorization: `Bearer ${tokens.get(as)!}` }),
        ...(key === null ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function createTarget(): Promise<string> {
  const response = await request(
    'POST',
    '/v1/subjects',
    {
      type: 'schema:Book',
      labels: { en: randomUUID() },
    },
    'importer',
  );
  return (await json(response, 201)).subject.id;
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
  return response.json();
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'source-statistics-test', alg: 'ES256' };
  app = createKernel({
    receiptKeys: testReceiptKeys(),
    pool: database.pool,
    writeRate: createWriteRateLimiter({
      secret: 'source-statistics-write-rate-secret-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
    routeKey,
    clock: () => new Date(),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(27)]]) },
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

  for (const persona of Object.keys(accountIds) as (keyof typeof accountIds)[]) {
    const accountId = accountIds[persona];
    await database.admin.query(
      `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
       VALUES ($1, $2, 'actor', 'active', $2)`,
      [routeOf(accountId), accountId],
    );
    const scopes = [
      'subject:read',
      'rating:vote',
      ...(persona === 'owner' ? [] : ['source_statistic:write', 'subject:create']),
    ];
    tokens.set(
      persona,
      await new SignJWT({
        client_id: 'source-statistics-test',
        scope: scopes.join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'source-statistics-test', typ: 'at+jwt' })
        .setIssuer('https://auth.example.test')
        .setAudience('https://api.rezics.test')
        .setSubject(accountId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }
  await database.admin.query(
    `INSERT INTO access.resource_role_grant
       (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
     VALUES (0, $1, 'identity', $2, '', 'platform.governance',
             tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $3)`,
    [GLOBAL_CONTEXT.id, accountIds.importer, randomUUID()],
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

test('source statistic routes are mounted with distinct read and importer actions', () => {
  const document = openApiDocument(app);
  expect(document.paths['/v1/subjects/{id}/source-statistics']?.get?.['x-action']).toBe('subject:read');
  expect(document.paths['/v1/subjects/{id}/source-statistics']?.get?.['x-exposure']).toBe('public');
  expect(document.paths['/v1/subjects/{id}/source-statistics']?.get?.security).toEqual([{ bearerAuth: [] }, {}]);
  expect(document.paths['/v1/subjects/{id}/source-statistics/{source}']?.put?.['x-action']).toBe(
    'source_statistic:write',
  );
  expect(document.paths['/v1/subjects/{id}/source-statistics/{source}']?.put?.['x-exposure']).toBe(
    'gate:personal_library',
  );
  expect(document.paths['/v1/subjects/{id}/source-statistics/{source}']?.put?.security).toEqual([{ bearerAuth: [] }]);
});

test('the importer writes and refreshes a labelled statistic without creating native votes', async () => {
  const subjectId = await createTarget();
  const path = `/v1/subjects/${subjectId}/source-statistics/vndb`;
  const first = {
    sourceRecordId: 'v17',
    scale: { min: 0, max: 10 },
    mean: 8.7,
    count: 1234,
    asOf: '2026-10-01',
    licence: 'CC BY 4.0',
    attribution: 'VNDB users',
  };
  await problem(await request('PUT', path, first, 'importer', null), 400);
  await problem(await request('PUT', path, { ...first, extra: true }, 'importer'), 400);
  await json(await request('PUT', path, first, 'importer'));
  const expected = [{ source: 'vndb', ...first }];
  expect(await json(await request('GET', `/v1/subjects/${subjectId}/source-statistics`))).toEqual(expected);

  const refreshed = { ...first, sourceRecordId: 'v18', mean: 9.1, count: 1500, asOf: '2026-10-15' };
  await json(
    await request(
      'PUT',
      path,
      { ...refreshed, expectedObservation: sourceObservation(subjectId, 'vndb', first).digest },
      'importer',
    ),
  );
  expect(await json(await request('GET', `/v1/subjects/${subjectId}/source-statistics`))).toEqual([
    {
      source: 'vndb',
      ...refreshed,
      observation: { kind: 'unversioned', digest: sourceObservation(subjectId, 'vndb', refreshed).digest },
    },
  ]);
  const counts = await database.admin.query(
    `SELECT
       (SELECT count(*)::int FROM rating.source_statistic WHERE route = $1 AND subject_id = $2) AS statistics,
       (SELECT count(*)::int FROM rating.vote) AS votes`,
    [routeOf(subjectId), subjectId],
  );
  expect(counts.rows).toEqual([{ statistics: 1, votes: 0 }]);
});

test('a caller without the Global Context grant cannot write a source statistic', async () => {
  const subjectId = await createTarget();
  const response = await request(
    'PUT',
    `/v1/subjects/${subjectId}/source-statistics/vndb`,
    {
      sourceRecordId: 'v19',
      scale: { min: 0, max: 10 },
      mean: 7,
      count: 1,
      asOf: '2026-10-01',
      licence: 'CC BY 4.0',
      attribution: 'VNDB users',
    },
    'ungranted',
  );
  await problem(response, 403);
  const stored = await database.admin.query(
    'SELECT count(*)::int AS n FROM rating.source_statistic WHERE route = $1 AND subject_id = $2',
    [routeOf(subjectId), subjectId],
  );
  expect(stored.rows).toEqual([{ n: 0 }]);
});

test('source statistics are concealed when the subject is unreadable', async () => {
  const subjectId = await createTarget();
  await database.admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', 'resource', '(,)'::tstzrange, $4)`,
    [routeOf(subjectId), subjectId, accountIds.owner, randomUUID()],
  );
  await problem(await request('GET', `/v1/subjects/${subjectId}/source-statistics`), 404);
});

test('the exact source statistic clear method is mounted under the existing writer authority', () => {
  const operation = openApiDocument(app).paths['/v1/subjects/{id}/source-statistics/{source}:clear']?.post;
  expect(operation?.operationId).toBe('rating.source_statistic_clear');
  expect(operation?.['x-action']).toBe('source_statistic:write');
  expect(operation?.['x-exposure']).toBe('gate:personal_library');
  expect(operation?.security).toEqual([{ bearerAuth: [] }]);
});

test('positive source-statistic publication still requires a finite mean and a positive count', async () => {
  const subjectId = await createTarget();
  const path = `/v1/subjects/${subjectId}/source-statistics/vndb`;
  const value = {
    sourceRecordId: 'positive-validation-record',
    scale: { min: 0, max: 10 },
    mean: 8,
    count: 1,
    asOf: '2026-10-01',
    licence: 'CC BY 4.0',
    attribution: 'VNDB users',
  };
  for (const body of [
    { ...value, count: 0 },
    { ...value, mean: null },
    { ...value, count: '1' },
  ]) {
    await problem(await request('PUT', path, body, 'importer'), 400);
  }
  const rows = await database.admin.query(
    'SELECT count(*)::int AS n FROM rating.source_statistic WHERE route=$1 AND subject_id=$2',
    [routeOf(subjectId), subjectId],
  );
  expect(rows.rows).toEqual([{ n: 0 }]);
});
