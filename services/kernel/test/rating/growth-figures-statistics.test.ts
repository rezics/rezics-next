import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess as createKernelAccess } from '../../src/access/index.ts';
import { createAccess as createPermissionAccess } from '../../src/access/permission.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createSourceStatisticCommands } from '../../src/rating/source-statistics.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { pagePublicFigures, readPublicFigures } from '../../src/rating/public-figure.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { partitionOf } from '../../src/route/route.ts';
import { capture, checkGrowth, GrowthBoundError, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const scales = [8, 32, 128] as const;
const figureRoute = 0x4520;
const sourceRoute = 0x4630;
const voterRoute = 0x4851;
const actorRoute = voterRoute;
const voteTargetRoute = 0x4960;
const actorId = id(actorRoute, 1);
const voteActorId = actorId;
const questionBody = {
  revision: 1,
  label: 'Growth check question',
  grain: 'work',
  minimum_units: 0,
  maximum_units: 20,
  step_units: 1,
};
const sourceValue = {
  sourceRecordId: 'growth-vndb-record',
  scale: { min: 0, max: 10 },
  mean: 8.5,
  count: 1234,
  asOf: '2026-10-01',
  licence: 'CC BY 4.0',
  attribution: 'VNDB users',
};
const actor: AccountActor = {
  kind: 'account',
  accountId: voteActorId,
  clientId: 'rating-growth-figures-statistics',
  scopes: ['definitions:read', 'rating:vote', 'source_statistic:write', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const timestamp = '2026-10-27T10:00:00.000Z';
let database: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let bearer: string;
let sourceStatisticCommands: ReturnType<typeof createSourceStatisticCommands>;
let voteCommands: ReturnType<typeof createVoteCommands>;

function id(route: number, ordinal: number): string {
  return `00000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

function figureProbe(scale: number, slot: number) {
  const cohort = scales.indexOf(scale as (typeof scales)[number]) * 3 + slot;
  const pageStart = 100_000 + cohort * 1_000;
  const batchStart = 4_000_000 + cohort * 256;
  return {
    after: id(figureRoute, pageStart),
    pageIds: Array.from({ length: 500 }, (_, index) => id(figureRoute, pageStart + index + 1)),
    batchIds: Array.from({ length: 256 }, (_, index) => id(figureRoute, batchStart + index)),
  };
}

function sourceProbe(dataset: number, scale: number, slot: number, kind: 'list' | 'write'): string {
  const cohort = scales.indexOf(scale as (typeof scales)[number]) * 3 + slot;
  const base = dataset * 10_000_000 + cohort * 100;
  return id(sourceRoute, base + (kind === 'list' ? 1 : 2));
}

function voteProbe(scale: number, slot: number, dataset = 1): { targetId: string; questionId: string } {
  const cohort = scales.indexOf(scale as (typeof scales)[number]) * 3 + slot;
  return {
    targetId: id(voteTargetRoute, dataset * 1_000_000 + cohort),
    questionId: id(voterRoute, 2_000_000 + dataset * 1_000_000 + cohort),
  };
}

async function insertSubjects(db: GrowthDatabase, subjectIds: readonly string[]): Promise<void> {
  await db.admin.query(
    `INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
     SELECT get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11),
            subject_id, 'schema:Book', subject_id
     FROM unnest($1::uuid[]) AS subject_id`,
    [subjectIds],
  );
}

async function request(
  method: string,
  path: string,
  options: { body?: unknown; authenticated?: boolean; key?: string } = {},
): Promise<unknown> {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        'x-request-id': 'rating-growth-figures-statistics',
        ...(options.authenticated === false ? {} : { authorization: `Bearer ${bearer}` }),
        ...(options.key === undefined ? {} : { 'idempotency-key': JSON.stringify(options.key) }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  if (response.status !== 200)
    throw new Error(`Expected HTTP 200, received ${response.status}: ${await response.clone().text()}`);
  return response.json();
}

async function seedFigureHistory(db: GrowthDatabase, scale: number, previous: number): Promise<void> {
  // Each scale adds 500 figures and population votes per hot and sibling route, plus another partition.
  const probes = Array.from({ length: 3 }, (_, slot) => figureProbe(scale, slot));
  await db.admin.query(
    `WITH groups(slot, page_start) AS (
       VALUES (0, $1::integer), (1, $2::integer), (2, $3::integer)
     ), subjects AS (
       SELECT $4::integer AS route, page_start + n AS ordinal
       FROM groups CROSS JOIN generate_series(1, 500) AS n
     )
     INSERT INTO rating.public_figure
       (route, question_id, population_id, subject_id, count, mean, revision, as_of, position)
     SELECT route, $5::uuid, $6::uuid,
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || lpad(to_hex(ordinal), 8, '0'))::uuid,
            1, 8.5, 1, $7::timestamptz, 1
     FROM subjects`,
    [
      ...probes.map(({ after }) => Number.parseInt(after.slice(-8), 16)),
      figureRoute,
      STANDARD_QUESTION_ID,
      GLOBAL_CONTEXT.id,
      timestamp,
    ],
  );
  await db.admin.query(
    `WITH groups(slot, batch_start) AS (
       VALUES (0, $1::integer), (1, $2::integer), (2, $3::integer)
     ), subjects AS (
       SELECT $4::integer AS route, batch_start + n AS ordinal
       FROM groups CROSS JOIN generate_series(0, 255) AS n
     )
     INSERT INTO rating.public_figure
       (route, question_id, population_id, subject_id, count, mean, revision, as_of, position)
     SELECT route, $5::uuid, $6::uuid,
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || lpad(to_hex(ordinal), 8, '0'))::uuid,
            1, 8.5, 1, $7::timestamptz, 1
     FROM subjects`,
    [
      ...probes.map(({ batchIds }) => Number.parseInt(batchIds[0]!.slice(-8), 16)),
      figureRoute,
      STANDARD_QUESTION_ID,
      GLOBAL_CONTEXT.id,
      timestamp,
    ],
  );
  await db.admin.query(
    `WITH population AS (
       SELECT n, bucket,
              CASE bucket WHEN 0 THEN $1::integer WHEN 1 THEN $1::integer + 1 ELSE $1::integer + 16 END AS route
       FROM generate_series($2::integer + 1, $3::integer) AS n
       CROSS JOIN (VALUES (0), (1), (2)) AS buckets(bucket)
     )
     INSERT INTO rating.public_figure
       (route, question_id, population_id, subject_id, count, mean, revision, as_of, position)
     SELECT route, $4::uuid, $5::uuid,
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
             lpad(to_hex(6_000_000 + n * 3 + bucket), 8, '0'))::uuid,
            1, 8.5, 1, $6::timestamptz, 1
     FROM population`,
    [figureRoute, previous * 500, scale * 500, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, timestamp],
  );
  const figureIds = probes.flatMap(({ pageIds, batchIds }) => [...pageIds, ...batchIds]);
  await db.admin.query(
    `WITH targets AS (
       SELECT subject_id,
              get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11) AS route,
              row_number() OVER (ORDER BY subject_id)::integer AS ordinal
       FROM unnest($1::uuid[]) AS subject_id
     )
     INSERT INTO rating.population_vote
       (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
     SELECT route, $2::uuid, $3::uuid, subject_id,
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
             lpad(to_hex(40_000_000 + ordinal), 8, '0'))::uuid,
            lpad(to_hex(ordinal % 256), 2, '0') || repeat('0', 62), 10, $4::timestamptz, 1
     FROM targets`,
    [figureIds, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, timestamp],
  );
  await db.admin.query(
    `WITH population AS (
       SELECT n, bucket,
              CASE bucket WHEN 0 THEN $1::integer WHEN 1 THEN $1::integer + 1 ELSE $1::integer + 16 END AS route
       FROM generate_series($2::integer + 1, $3::integer) AS n
       CROSS JOIN (VALUES (0), (1), (2)) AS buckets(bucket)
     ), targets AS (
       SELECT route,
              ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
               lpad(to_hex(6_000_000 + n * 3 + bucket), 8, '0'))::uuid AS target_id,
              n, bucket
       FROM population
     )
     INSERT INTO rating.population_vote
       (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
     SELECT route, $4::uuid, $5::uuid, target_id,
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
             lpad(to_hex(40_000_000 + n * 3 + bucket), 8, '0'))::uuid,
            lpad(to_hex(n % 256), 2, '0') || repeat('0', 62), 10, $6::timestamptz, 1
     FROM targets`,
    [figureRoute, previous * 500, scale * 500, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, timestamp],
  );
}

async function seedSourceHistory(
  db: GrowthDatabase,
  scale: number,
  previous: number,
  dataset: number,
  includeCommandHistory: boolean,
): Promise<void> {
  // Each scale adds 500 unrelated subjects and source statistics per route while probes use fresh subject keys.
  const listIds = Array.from({ length: 3 }, (_, slot) => sourceProbe(dataset, scale, slot, 'list'));
  const writeIds = Array.from({ length: 3 }, (_, slot) => sourceProbe(dataset, scale, slot, 'write'));
  await insertSubjects(db, [...listIds, ...writeIds]);
  await db.admin.query(
    `WITH population AS (
       SELECT n, bucket,
              CASE bucket WHEN 0 THEN $1::integer WHEN 1 THEN $1::integer + 1 ELSE $1::integer + 16 END AS route
       FROM generate_series($2::integer + 1, $3::integer) AS n
       CROSS JOIN (VALUES (0), (1), (2)) AS buckets(bucket)
     ), subjects AS (
       SELECT route,
              ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
               lpad(to_hex($4::integer + n * 3 + bucket), 8, '0'))::uuid AS subject_id,
              n, bucket
       FROM population
     )
     INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
     SELECT route, subject_id, 'schema:Book', subject_id FROM subjects`,
    [sourceRoute, previous * 500, scale * 500, dataset * 1_000_000],
  );
  await db.admin.query(
    `WITH population AS (
       SELECT n, bucket,
              CASE bucket WHEN 0 THEN $1::integer WHEN 1 THEN $1::integer + 1 ELSE $1::integer + 16 END AS route
       FROM generate_series($2::integer + 1, $3::integer) AS n
       CROSS JOIN (VALUES (0), (1), (2)) AS buckets(bucket)
     )
     INSERT INTO rating.source_statistic
       (route, subject_id, source, source_alias, source_record_id, scale_min, scale_max, mean, count, as_of,
        licence, attribution, transaction_id)
     SELECT route,
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
             lpad(to_hex($4::integer + n * 3 + bucket), 8, '0'))::uuid,
            'vndb', 'vndb', 'growth-record-' || $5::text || '-' || n || '-' || bucket,
            0, 10, 8.5, 1234, '2026-10-01', 'CC BY 4.0', 'VNDB users',
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
             lpad(to_hex($4::integer + n * 3 + bucket), 8, '0'))::uuid
     FROM population`,
    [sourceRoute, previous * 500, scale * 500, dataset * 1_000_000, dataset],
  );
  await db.admin.query(
    `INSERT INTO rating.source_statistic
       (route, subject_id, source, source_alias, source_record_id, scale_min, scale_max, mean, count, as_of,
        licence, attribution, transaction_id)
     SELECT $1, subject_id, 'vndb', 'vndb', 'probe-' || $2::text || '-' || subject_id::text,
            0, 10, 8.5, 1234, '2026-10-01', 'CC BY 4.0', 'VNDB users', subject_id
     FROM unnest($3::uuid[]) AS subject_id`,
    [sourceRoute, dataset, listIds],
  );
  if (includeCommandHistory) await seedCommandHistory(db, scale, previous);
}

async function seedCommandHistory(db: GrowthDatabase, scale: number, previous: number): Promise<void> {
  // Keep receipt, outbox and write-basis growth aligned with mounted source-statistic commands.
  const first = previous === 0 ? 1 : previous * 500 + 4;
  const last = scale * 500;
  if (first <= last) {
    await db.admin.query(
      `WITH commands AS (
         SELECT n, n + 1000 AS position,
                ('00000000-0000-7000-8000-' || lpad(to_hex($1::integer), 4, '0') ||
                 lpad(to_hex(30_000_000 + n), 8, '0'))::uuid AS transaction_id,
                ('00000000-0000-7000-8000-' || lpad(to_hex($1::integer), 4, '0') ||
                 lpad(to_hex(31_000_000 + n), 8, '0'))::uuid AS event_id
         FROM generate_series($2::integer, $3::integer) AS n
       )
       INSERT INTO core.receipt
         (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
          epoch, position, transaction_id, response)
       SELECT $4, 'account', $5::uuid, 'rating.source_statistic.write', 'growth-seed-' || n,
              decode(repeat('00', 32), 'hex'), 1, position, transaction_id,
              jsonb_build_object('source', 'vndb', 'sourceRecordId', 'growth-seed-' || n,
                'scale', jsonb_build_object('min', 0, 'max', 10), 'mean', 8.5, 'count', 1234,
                'asOf', '2026-10-01', 'licence', 'CC BY 4.0', 'attribution', 'VNDB users')
       FROM commands`,
      [partitionOf(sourceRoute), first, last, partitionOf(sourceRoute), actorId],
    );
    await db.admin.query(
      `WITH commands AS (
         SELECT n, n + 1000 AS position,
                ('00000000-0000-7000-8000-' || lpad(to_hex($1::integer), 4, '0') ||
                 lpad(to_hex(30_000_000 + n), 8, '0'))::uuid AS transaction_id,
                ('00000000-0000-7000-8000-' || lpad(to_hex($1::integer), 4, '0') ||
                 lpad(to_hex(31_000_000 + n), 8, '0'))::uuid AS event_id
         FROM generate_series($2::integer, $3::integer) AS n
       )
       INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       SELECT $4, position, 0, 1, 1, event_id, 'com.rezics.rating.source_statistic.changed.v1',
              'growth-' || n,
              jsonb_build_object('source', 'vndb', 'sourceRecordId', 'growth-seed-' || n)
       FROM commands`,
      [sourceRoute, first, last, partitionOf(sourceRoute)],
    );
    await db.admin.query(
      `WITH commands AS (
         SELECT n, n + 1000 AS position,
                ('00000000-0000-7000-8000-' || lpad(to_hex($1::integer), 4, '0') ||
                 lpad(to_hex(30_000_000 + n), 8, '0'))::uuid AS transaction_id
         FROM generate_series($2::integer, $3::integer) AS n
       )
       INSERT INTO editorial.write_basis
         (partition_no, transaction_id, epoch, position, principal_kind, principal_id, client_id, requested_by)
       SELECT $4, transaction_id, 1, position, 'account', $5::uuid,
              'rating-growth-figures-statistics', NULL
       FROM commands`,
      [sourceRoute, first, last, partitionOf(sourceRoute), actorId],
    );
  }
  await db.admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = $1', [
    partitionOf(sourceRoute),
    scale * 500 + 1000,
  ]);
}

async function seedVoteHistory(db: GrowthDatabase, scale: number, previous: number, dataset: number): Promise<void> {
  // Each scale adds 500 votes per voter route and fresh probe votes/questions for every measured key.
  const probes = Array.from({ length: 3 }, (_, slot) => voteProbe(scale, slot, dataset));
  const questionIds = [
    ...new Set(
      scales.flatMap((item) => Array.from({ length: 3 }, (_, slot) => voteProbe(item, slot, dataset).questionId)),
    ),
  ];
  await insertSubjects(
    db,
    probes.map(({ targetId }) => targetId),
  );
  await db.admin.query(
    `INSERT INTO rating.question (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units)
     SELECT question_id, NULL, 1, 'Growth check question', 'work', 0, 20, 1
     FROM unnest($1::uuid[]) AS question_id
     ON CONFLICT (id) DO NOTHING`,
    [questionIds],
  );
  await db.admin.query(
    `WITH population AS (
       SELECT n, bucket,
              CASE bucket WHEN 0 THEN $1::integer WHEN 1 THEN $1::integer + 1 ELSE $1::integer + 16 END AS route
       FROM generate_series($2::integer + 1, $3::integer) AS n
       CROSS JOIN (VALUES (0), (1), (2)) AS buckets(bucket)
     )
     INSERT INTO rating.question (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units)
     SELECT ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
             lpad(to_hex($4::integer + n * 3 + bucket), 8, '0'))::uuid,
            NULL, 1, 'Unrelated growth check question', 'work', 0, 20, 1
     FROM population`,
    [voterRoute, previous * 500, scale * 500, dataset * 10_000_000],
  );
  await db.admin.query(
    `WITH population AS (
       SELECT n, bucket,
              CASE bucket WHEN 0 THEN $1::integer WHEN 1 THEN $1::integer
                          WHEN 2 THEN $1::integer + 1 ELSE $1::integer + 16 END AS route
       FROM generate_series($2::integer + 1, $3::integer) AS n
       CROSS JOIN (VALUES (0), (1), (2), (3)) AS buckets(bucket)
     ), votes AS (
       SELECT route,
              CASE bucket
                WHEN 0 THEN $4::uuid
                ELSE ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
                      lpad(to_hex($9::integer * 10_000_000 + bucket * 1_000_000 + n), 8, '0'))::uuid
              END AS voter_id,
              CASE bucket
                WHEN 0 THEN ('00000000-0000-7000-8000-' || lpad(to_hex($5::integer), 4, '0') ||
                             lpad(to_hex(6_000_000 + $9::integer * 1_000_000 + n), 8, '0'))::uuid
                ELSE $6::uuid
              END AS target_id,
              bucket, n
       FROM population
     )
     INSERT INTO rating.vote
       (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id, counted_target, counted_revision)
     SELECT route, voter_id, $7::uuid, target_id, 10, 1, $8::timestamptz,
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
             lpad(to_hex(20_000_000 + $9::integer * 1_000_000 + n * 4 + bucket), 8, '0'))::uuid,
            target_id, 1
     FROM votes`,
    [
      voterRoute,
      previous * 500,
      scale * 500,
      voteActorId,
      voteTargetRoute,
      id(voteTargetRoute, 900_000),
      STANDARD_QUESTION_ID,
      timestamp,
      dataset,
    ],
  );
  const cohortStart = scales.indexOf(scale as (typeof scales)[number]) * 3;
  await db.admin.query(
    `WITH groups(slot, target_id, question_id) AS (
       VALUES (0, $1::uuid, $2::uuid), (1, $3::uuid, $4::uuid), (2, $5::uuid, $6::uuid)
     )
     INSERT INTO rating.vote
       (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id, counted_target, counted_revision)
     SELECT $7, $8::uuid, question_id, target_id, 10, 1, $9::timestamptz,
            ('00000000-0000-7000-8000-' || lpad(to_hex($7::integer), 4, '0') ||
             lpad(to_hex(30_000_000 + $10::integer * 1_000_000 + $11::integer + slot), 8, '0'))::uuid,
            target_id, 1
     FROM groups`,
    [
      ...probes.flatMap(({ targetId, questionId }) => [targetId, questionId]),
      voterRoute,
      voteActorId,
      timestamp,
      dataset,
      cohortStart,
    ],
  );
  await db.admin.query(
    `WITH population AS (
       SELECT n, bucket,
              CASE bucket WHEN 1 THEN $1::integer WHEN 2 THEN $1::integer + 1 ELSE $1::integer + 16 END AS route
       FROM generate_series($2::integer + 1, $3::integer) AS n
       CROSS JOIN (VALUES (1), (2), (3)) AS buckets(bucket)
     )
     INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
     SELECT route,
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
             lpad(to_hex($4::integer * 10_000_000 + bucket * 1_000_000 + n), 8, '0'))::uuid,
            'actor', 'active',
            ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') ||
             lpad(to_hex(40_000_000 + $4::integer * 1_000_000 + n * 3 + bucket), 8, '0'))::uuid,
            false, 1, true
     FROM population`,
    [voterRoute, previous * 500, scale * 500, dataset],
  );
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  sourceStatisticCommands = createSourceStatisticCommands({
    pool: database.pool,
    routeKey: new Uint8Array(32).fill(121),
  });
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'rating-growth-figures-statistics', alg: 'ES256' };
  app = createKernel({
    pool: database.pool,
    writeRate: createWriteRateLimiter({
      secret: 'rating-growth-figures-statistics-write-rate-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
    routeKey: new Uint8Array(32).fill(121),
    clock: () => new Date(),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(27)]]) },
    access: (config) =>
      createKernelAccess({
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
     VALUES ($1, $2, 'actor', 'active', $3, false, 1, true)`,
    [actorRoute, actorId, randomUUID()],
  );
  await database.admin.query(
    `INSERT INTO access.resource_role_grant
       (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
     VALUES (0, $1, 'identity', $2, '', 'platform.governance',
             tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $3)`,
    [GLOBAL_CONTEXT.id, actorId, randomUUID()],
  );
  await database.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [randomUUID()],
  );
  bearer = await new SignJWT({
    client_id: actor.clientId,
    scope: actor.scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'rating-growth-figures-statistics', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(actorId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  const account = (await readAccount(database.pool, voterRoute, voteActorId))!;
  voteCommands = createVoteCommands({
    pool: database.pool,
    access: createPermissionAccess({
      actions: new Map([['subject:read', { anonymous: true }]]),
      accountEvidence: () => account,
    }),
  });
});

afterAll(async () => {
  await database?.close();
});

test('Public figure batches and pages stay within their bound as figure and voter history grows', async () => {
  let report;
  try {
    report = await checkGrowth(database, {
      name: 'rating public figure point batches and pages',
      scales,
      repetitions: 2,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: seedFigureHistory,
      operation: async (db, scale, repetition) => {
        const probe = figureProbe(scale, repetition % 3);
        const batch = await readPublicFigures(db.pool, {
          partition: partitionOf(figureRoute),
          questionId: STANDARD_QUESTION_ID,
          populationId: GLOBAL_CONTEXT.id,
          subjectIds: probe.batchIds,
        });
        expect(batch.map(({ subjectId }) => subjectId)).toEqual(probe.batchIds);
        const page = await pagePublicFigures(db.pool, {
          partition: partitionOf(figureRoute),
          questionId: STANDARD_QUESTION_ID,
          populationId: GLOBAL_CONTEXT.id,
          after: probe.after,
          limit: 500,
        });
        expect(page.map(({ subjectId }) => subjectId)).toEqual(probe.pageIds);
        return { batch: batch.length, page: page.length };
      },
    });
  } catch (error) {
    if (!(error instanceof GrowthBoundError)) throw error;
    const probe = figureProbe(scales[2], 1);
    const diagnostic = await capture(database, async () => {
      await readPublicFigures(database.pool, {
        partition: partitionOf(figureRoute),
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        subjectIds: probe.batchIds,
      });
      await pagePublicFigures(database.pool, {
        partition: partitionOf(figureRoute),
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        after: probe.after,
        limit: 500,
      });
    });
    console.log(
      JSON.stringify(
        {
          series: error.samples.map(({ scale, cost, repetitions }) => ({
            scale,
            rows: cost.rows,
            blocks: cost.blocks,
            statements: cost.statements,
            repetitions,
          })),
          statements: diagnostic.capture.statements,
          plans: diagnostic.capture.plans,
        },
        null,
        2,
      ),
    );
    throw error;
  }
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(report.samples.every(({ cost }) => cost.statements === 2)).toBe(true);
});

test('Public figure pages preserve start, strict cursor, end and exact published prefix semantics', async () => {
  const populationId = id(figureRoute, 90);
  const otherPopulationId = id(figureRoute, 91);
  const otherQuestionId = id(figureRoute, 92);
  const first = id(figureRoute, 10);
  const unpublished = id(figureRoute, 11);
  const second = id(figureRoute + 1, 10);
  const input = { partition: partitionOf(figureRoute), questionId: STANDARD_QUESTION_ID, populationId };
  await database.admin.query(
    `INSERT INTO rating.question (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units)
     VALUES ($1, NULL, 1, 'Other figure question', 'work', 0, 20, 1)`,
    [otherQuestionId],
  );
  for (const [subjectId, questionId, population, revision] of [
    [first, STANDARD_QUESTION_ID, populationId, 1],
    [unpublished, STANDARD_QUESTION_ID, populationId, 0],
    [second, STANDARD_QUESTION_ID, populationId, 2],
    [id(figureRoute, 12), otherQuestionId, populationId, 1],
    [id(figureRoute, 13), STANDARD_QUESTION_ID, otherPopulationId, 1],
    [id(figureRoute + 16, 10), STANDARD_QUESTION_ID, populationId, 1],
  ] as const) {
    const scored = subjectId === second;
    await database.admin.query(
      `INSERT INTO rating.public_figure
         (route, question_id, population_id, subject_id, count, mean, score, m, c, prior_epoch, revision, as_of, position)
       VALUES (get_byte(uuid_send($1::uuid), 10) * 256 + get_byte(uuid_send($1::uuid), 11),
               $2, $3, $1, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        subjectId,
        questionId,
        population,
        scored ? 7 : 1,
        scored ? 8.5 : null,
        scored ? 8.25 : null,
        scored ? 8 : null,
        scored ? 5 : null,
        scored ? 3 : null,
        revision,
        scored ? timestamp : null,
        scored ? 9 : 0,
      ],
    );
  }
  const expected = [
    {
      questionId: STANDARD_QUESTION_ID,
      populationId,
      subjectId: first,
      count: 1,
      mean: null,
      score: null,
      m: null,
      C: null,
      priorEpoch: null,
      revision: '1',
      asOf: null,
      position: '0',
    },
    {
      questionId: STANDARD_QUESTION_ID,
      populationId,
      subjectId: second,
      count: 7,
      mean: 8.5,
      score: 8.25,
      m: 8,
      C: 5,
      priorEpoch: 3,
      revision: '2',
      asOf: timestamp,
      position: '9',
    },
  ];
  expect(await pagePublicFigures(database.pool, { ...input, after: null, limit: 500 })).toEqual(expected);
  expect(await pagePublicFigures(database.pool, { ...input, after: null, limit: 1 })).toEqual(expected.slice(0, 1));
  expect(await pagePublicFigures(database.pool, { ...input, after: first, limit: 1 })).toEqual(expected.slice(1));
  expect(await pagePublicFigures(database.pool, { ...input, after: unpublished, limit: 500 })).toEqual(expected.slice(1));
  expect(await pagePublicFigures(database.pool, { ...input, after: second, limit: 500 })).toEqual([]);
  expect(
    await pagePublicFigures(database.pool, {
      ...input,
      populationId: id(figureRoute, 93),
      after: null,
      limit: 500,
    }),
  ).toEqual([]);
  expect(
    await readPublicFigures(database.pool, {
      ...input,
      subjectIds: [second, unpublished, first, first, id(figureRoute, 12), id(figureRoute, 13)],
    }),
  ).toEqual(expected);
  expect(await readPublicFigures(database.pool, { ...input, subjectIds: [] })).toEqual([]);
});

test('Source statistic writes and reads stay within their bound as statistics grow', async () => {
  const writeReport = await checkGrowth(database, {
    name: 'mounted rating source statistic write',
    scales,
    repetitions: 2,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (db, scale, previous) => seedSourceHistory(db, scale, previous, 1, true),
    operation: async (_db, scale, repetition) => {
      const subjectId = sourceProbe(1, scale, repetition % 3, 'write');
      const result = await request('PUT', `/v1/subjects/${subjectId}/source-statistics/vndb`, {
        body: sourceValue,
        key: randomUUID(),
      });
      expect(result).toMatchObject({ source: 'vndb', sourceRecordId: sourceValue.sourceRecordId });
      return result;
    },
  });
  expect(writeReport.samples.map(({ scale }) => scale)).toEqual([...scales]);

  const readReport = await checkGrowth(database, {
    name: 'rating source statistic point command read and mounted list',
    scales,
    repetitions: 2,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (db, scale, previous) => seedSourceHistory(db, scale, previous, 2, false),
    operation: async (_db, scale, repetition) => {
      const subjectId = sourceProbe(2, scale, repetition % 3, 'list');
      const point = await sourceStatisticCommands.read(subjectId);
      expect(point).toHaveLength(1);
      expect(point).toMatchObject([{ source: 'vndb', sourceRecordId: `probe-2-${subjectId}` }]);
      const result = await request('GET', `/v1/subjects/${subjectId}/source-statistics`);
      expect(result).toHaveLength(1);
      expect(result).toMatchObject([{ source: 'vndb', sourceRecordId: `probe-2-${subjectId}` }]);
      return { point, result };
    },
  });
  expect(readReport.samples.map(({ scale }) => scale)).toEqual([...scales]);
});

test('Own vote and question reads stay within their bound as votes grow', async () => {
  const ownVoteReport = await checkGrowth(database, {
    name: 'rating own vote and question command GETs',
    scales,
    repetitions: 2,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (db, scale, previous) => seedVoteHistory(db, scale, previous, 1),
    operation: async (_db, scale, repetition) => {
      const probe = voteProbe(scale, repetition % 3, 1);
      const commandVote = await voteCommands.readOwnVote(actor, probe.questionId, probe.targetId);
      expect(commandVote).toMatchObject({ targetId: probe.targetId, units: 10, revision: 1 });
      const response = await request('GET', `/v1/subjects/${probe.targetId}/ratings/${probe.questionId}/vote`);
      expect(response).toMatchObject({ units: 10, revision: 1 });
      return response;
    },
  });
  expect(ownVoteReport.samples.map(({ scale }) => scale)).toEqual([...scales]);

  const questionReport = await checkGrowth(database, {
    name: 'rating question command and mounted GET',
    scales,
    repetitions: 2,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (db, scale, previous) => seedVoteHistory(db, scale, previous, 2),
    operation: async (_db, scale, repetition) => {
      const { questionId } = voteProbe(scale, repetition % 3, 2);
      const commandQuestion = await voteCommands.readRatingQuestion(actor, questionId);
      expect(commandQuestion.id).toBe(questionId);
      const response = await request('GET', `/v1/rating-questions/${questionId}`);
      expect(response).toMatchObject({ id: questionId, label: questionBody.label, grain: 'work' });
      return response;
    },
  });
  expect(questionReport.samples.map(({ scale }) => scale)).toEqual([...scales]);
});
