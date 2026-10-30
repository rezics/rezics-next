import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const scales = [256, 1024, 4096] as const;
const sourceRoute = 0x4630;
const actorRoute = 0x4851;
const actorId = id(actorRoute, 1);
const routeKey = new Uint8Array(32).fill(121);
const statisticValue = (sourceRecordId: string, mean = 8.5) => ({
  sourceRecordId,
  scale: { min: 0, max: 10 },
  mean,
  count: 1234,
  asOf: '2026-10-01',
  licence: 'CC BY 4.0',
  attribution: 'VNDB users',
});
const actor = {
  kind: 'account' as const,
  accountId: actorId,
  clientId: 'growth-source-statistic-lifecycle',
  scopes: ['subject:read', 'source_statistic:write'],
  requestedBy: null,
  authnEpoch: 1,
};

let database: GrowthDatabase;
let bearer: string;

function id(route: number, ordinal: number): string {
  return `00000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

function probeSubject(scale: number, repetition: number): string {
  return id(sourceRoute, 1_000_000 + scale * 10 + repetition);
}

function path(subjectId: string) {
  return `/v1/subjects/${subjectId}/source-statistics`;
}

function clearPath(subjectId: string) {
  return `${path(subjectId)}/vndb:clear`;
}

async function request(
  method: string,
  requestPath: string,
  options: { body?: unknown; key?: string } = {},
): Promise<Response> {
  const response = await app.handle(
    new Request(`http://kernel.test${requestPath}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-request-id': 'growth-source-statistic-lifecycle',
        ...(options.key === undefined ? {} : { 'idempotency-key': JSON.stringify(options.key) }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return response;
}

let app: ReturnType<typeof createKernel>;

async function seedProbe(db: GrowthDatabase, scale: number, repetition: number): Promise<void> {
  const subjectId = probeSubject(scale, repetition);
  const readRecordId = `growth-live-read-${scale}-${repetition}`;
  await db.admin.query(
    `INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
     VALUES ($1,$2,'schema:Book',$2)
     ON CONFLICT (route, subject_id) DO NOTHING`,
    [sourceRoute, subjectId],
  );
  await db.admin.query(
    `INSERT INTO rating.source_statistic
       (route, subject_id, source, source_record_id, scale_min, scale_max, mean, count, as_of,
        licence, attribution, transaction_id)
     VALUES ($1,$2,'vndb',$3,0,10,8.5,1234,'2026-10-01','CC BY 4.0','VNDB users',$2)
     ON CONFLICT (route, subject_id, source) DO UPDATE SET source_record_id=EXCLUDED.source_record_id,
       scale_min=EXCLUDED.scale_min, scale_max=EXCLUDED.scale_max, mean=EXCLUDED.mean, count=EXCLUDED.count,
       as_of=EXCLUDED.as_of, licence=EXCLUDED.licence, attribution=EXCLUDED.attribution,
       transaction_id=EXCLUDED.transaction_id`,
    [sourceRoute, subjectId, readRecordId],
  );
}

async function exercise(subjectId: string, scale: number, repetition: number) {
  const readRecordId = `growth-live-read-${scale}-${repetition}`;
  const read = await request('GET', path(subjectId));
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject([{ source: 'vndb', sourceRecordId: readRecordId }]);

  const sourceRecordId = `growth-live-write-${scale}-${repetition}`;
  const value = statisticValue(sourceRecordId);
  const put = await request('PUT', `${path(subjectId)}/vndb`, { body: value, key: randomUUID() });
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ source: 'vndb', ...value });

  const clear = await request('POST', clearPath(subjectId), {
    body: { sourceRecordId, count: 0, asOf: value.asOf },
    key: randomUUID(),
  });
  expect(clear.status).toBe(204);
  expect(clear.headers.get(SESSION_HEADER)).toBeTruthy();
  return { read: read.status, put: put.status, clear: clear.status };
}

async function seedStatisticHistory(db: GrowthDatabase, scale: number, previous: number): Promise<void> {
  const first = previous + 1;
  const unrelatedIds = Array.from({ length: scale - previous }, (_, index) => index + first);
  await db.admin.query(
    `WITH history AS (
       SELECT n, ('00000000-0000-7000-8000-' || lpad(to_hex($1::integer),4,'0') ||
                  lpad(to_hex(2_000_000+n),8,'0'))::uuid AS subject_id
       FROM unnest($2::integer[]) AS n
     )
     INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
     SELECT $1, subject_id, 'schema:Book', subject_id FROM history`,
    [sourceRoute, unrelatedIds],
  );
  await db.admin.query(
    `WITH history AS (
       SELECT n, ('00000000-0000-7000-8000-' || lpad(to_hex($1::integer),4,'0') ||
                  lpad(to_hex(2_000_000+n),8,'0'))::uuid AS subject_id
       FROM unnest($2::integer[]) AS n
     )
     INSERT INTO rating.source_statistic
       (route, subject_id, source, source_record_id, scale_min, scale_max, mean, count, as_of,
        licence, attribution, transaction_id)
     SELECT $1, subject_id, 'vndb', 'growth-unrelated-' || n, 0, 10, 8.5, 1234, '2026-10-01',
            'CC BY 4.0', 'VNDB users', subject_id FROM history`,
    [sourceRoute, unrelatedIds],
  );

  const fenceIds = unrelatedIds.map((n) => `growth-fence-history-${n}`);
  const fenceRoutes = fenceIds.map((externalId) => tupleRoute(routeKey, 'vndb', externalId));
  await db.admin.query(
    `INSERT INTO content.source_fences (route, source, external_id, field_group, taken_down, security_revision)
     SELECT route, 'vndb', external_id, 'facts', false, 1
     FROM unnest($1::integer[], $2::text[]) AS history(route, external_id)`,
    [fenceRoutes, fenceIds],
  );

  await seedCommandHistory(db, scale, previous);
}

async function seedCommandHistory(db: GrowthDatabase, scale: number, previous: number): Promise<void> {
  const first = previous + 1;
  const partition = partitionOf(sourceRoute);
  if (first <= scale) {
    const insertHistory = `
      WITH history AS (
        SELECT n, kind, 100_000 + n * 2 + kind AS position,
               ('00000000-0000-7000-8000-' || lpad(to_hex($1::integer),4,'0') ||
                lpad(to_hex(30_000_000+n*2+kind),8,'0'))::uuid AS transaction_id,
               ('00000000-0000-7000-8000-' || lpad(to_hex($1::integer),4,'0') ||
                lpad(to_hex(40_000_000+n*2+kind),8,'0'))::uuid AS event_id,
               ('00000000-0000-7000-8000-' || lpad(to_hex($2::integer),4,'0') ||
                lpad(to_hex(2_000_000+n),8,'0'))::uuid AS subject_id
        FROM generate_series($3::integer,$4::integer) AS n
        CROSS JOIN (VALUES (0),(1)) AS command(kind)
      )`;
    await db.admin.query(
      `${insertHistory}
       INSERT INTO core.receipt
         (partition_no, principal_id, command_kind, idempotency_key, request_digest, epoch, position,
          transaction_id, response, principal_kind)
       SELECT $5, $6, CASE kind WHEN 0 THEN 'rating.source_statistic.write' ELSE 'rating.source_statistic.clear' END,
              'growth-history-' || kind || '-' || n, decode(repeat('00',32),'hex'), 1, position,
              transaction_id,
              CASE kind WHEN 0 THEN jsonb_build_object('source','vndb','sourceRecordId','history-' || n)
                        ELSE jsonb_build_object('removed',true) END,
              'account'
       FROM history`,
      [sourceRoute, sourceRoute, first, scale, partition, actorId],
    );
    await db.admin.query(
      `${insertHistory}
       INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       SELECT $5, position, 0, 1, 1, event_id, 'com.rezics.rating.source_statistic.changed.v1',
              subject_id::text, jsonb_build_object('subjectId',subject_id,'source','vndb',
                'sourceRecordId','history-' || n)
       FROM history`,
      [sourceRoute, sourceRoute, first, scale, partition, actorId],
    );
    await db.admin.query(
      `${insertHistory}
       INSERT INTO editorial.write_basis
         (partition_no, transaction_id, epoch, position, principal_id, client_id, requested_by, principal_kind)
       SELECT $5, transaction_id, 1, position, $6, 'growth-source-statistic-lifecycle', NULL, 'account'
       FROM history`,
      [sourceRoute, sourceRoute, first, scale, partition, actorId],
    );
  }
  await db.admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
    partition,
    100_000 + scale * 2 + 100,
  ]);
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'growth-source-statistic-lifecycle', alg: 'ES256' };
  app = createKernel({
    pool: database.pool,
    routeKey,
    writeRate: createWriteRateLimiter({
      secret: 'growth-source-statistic-lifecycle-write-rate-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
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
    `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,false,1,true)`,
    [actorRoute, actorId],
  );
  await database.admin.query(
    `INSERT INTO access.resource_role_grant
       (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
     VALUES (0,$1,'identity',$2,'','platform.governance',tstzrange('2020-01-01T00:00:00Z',NULL,'[)'),$3)`,
    [GLOBAL_CONTEXT, actorId, randomUUID()],
  );
  await database.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     SELECT 'personal_library', tstzrange('2020-01-01T00:00:00Z',NULL,'[)'), $1
     WHERE NOT EXISTS (SELECT 1 FROM access.exposure_opening WHERE "group"='personal_library' AND upper_inf(valid))`,
    [randomUUID()],
  );
  bearer = await new SignJWT({
    client_id: actor.clientId,
    scope: actor.scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'growth-source-statistic-lifecycle', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(actorId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
});

afterAll(async () => {
  await database?.close();
});

test('source statistic GET, PUT and authoritative zero clear stay bounded as row and tuple histories grow', async () => {
  const report = await checkGrowth(database, {
    name: 'source statistic lifecycle HTTP and tuple fences',
    scales,
    repetitions: 2,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    indexProbes: 128,
    grow: seedStatisticHistory,
    prepare: (db, scale, repetition) => seedProbe(db, scale, repetition),
    warmup: async (db, scale, repetition) => {
      await seedProbe(db, scale, repetition);
      return exercise(probeSubject(scale, repetition), scale, repetition);
    },
    operation: async (_db, scale, repetition) => {
      const subjectId = probeSubject(scale, repetition);
      return exercise(subjectId, scale, repetition);
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  const relations = [
    ...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((run) => Object.keys(run.relations)))),
  ].sort();
  expect(relations).toContain('rating.source_statistic');
  expect(relations).toContain('content.source_fences');
  expect(relations).toContain('core.receipt');
  expect(relations.length).toBeGreaterThan(3);
  assertGrowthAccessPaths('source statistic lifecycle HTTP and tuple fences', report.samples, relations);
});
