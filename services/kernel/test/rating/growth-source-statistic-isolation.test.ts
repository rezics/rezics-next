import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, type GrowthDatabase } from '../support/growth.ts';
import {
  createSourceStatisticIsolationFixture,
  SOURCE_STATISTIC_GROWTH_SCALES,
} from './source-statistic-isolation-fixture.ts';

const fixtureOptions = { withRatingWorker: false };
let fixture: Awaited<ReturnType<typeof createSourceStatisticIsolationFixture>>;

const fixedStatistic = {
  sourceRecordId: 'vndb-fixed-source-statistic-growth-record',
  scale: { min: 0, max: 4096 },
  mean: 3072.25,
  count: 1_234_567,
  asOf: '2026-10-19',
  licence: 'VNDB growth fixture licence',
  attribution: 'VNDB growth fixture attribution.',
};
const historyPrefix = 'source-isolation-growth-';
const positionBase = 100_000_000;

function sqlId(routeExpression: string, ordinalExpression: string): string {
  return `('00000000-0000-7000-8000-' || lpad(to_hex(${routeExpression}), 4, '0') ||
          lpad(to_hex(${ordinalExpression}), 8, '0'))::uuid`;
}

async function seedUnrelatedHistory(
  db: GrowthDatabase,
  scale: number,
  previous: number,
  input: { hotRoute: number; importerId: string },
): Promise<void> {
  const hotRoute = input.hotRoute;
  const siblingRoute = hotRoute ^ 1;
  const otherRoute = (hotRoute + 16) & 0xffff;
  const routeForOrdinal = `CASE mod(n, 4)
    WHEN 0 THEN $1::integer WHEN 1 THEN $1::integer WHEN 2 THEN $2::integer ELSE $3::integer END`;
  const first = previous + 1;

  await db.admin.query(
    `WITH rows AS (
       SELECT n, ${routeForOrdinal} AS route
       FROM generate_series($4::integer, $5::integer) AS series(n)
     )
     INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
     SELECT route, ${sqlId('route', '10_000_000 + n')}, 'schema:Book', ${sqlId('route', '10_000_000 + n')}
     FROM rows`,
    [hotRoute, siblingRoute, otherRoute, first, scale],
  );
  await db.admin.query(
    `WITH rows AS (
       SELECT n, ${routeForOrdinal} AS route
       FROM generate_series($4::integer, $5::integer) AS series(n)
     )
     INSERT INTO rating.source_statistic
       (route, subject_id, source, source_record_id, scale_min, scale_max, mean, count, as_of,
        licence, attribution, transaction_id)
     SELECT route, ${sqlId('route', '10_000_000 + n')}, 'vndb', '${historyPrefix}' || n,
            0, 4096, 3072.25, 1234, '2026-10-01', 'VNDB growth fixture licence',
            'VNDB growth fixture attribution.', ${sqlId('route', '10_000_000 + n')}
     FROM rows`,
    [hotRoute, siblingRoute, otherRoute, first, scale],
  );
  await db.admin.query(
    `WITH rows AS (
       SELECT n, ${routeForOrdinal} AS route
       FROM generate_series($4::integer, $5::integer) AS series(n)
     )
     INSERT INTO rating.vote
       (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id,
        counted_target, counted_revision)
     SELECT route, ${sqlId('route', '30_000_000 + n')}, $6::uuid, ${sqlId('route', '20_000_000 + n')},
            20, 1, '2026-10-01T00:00:00Z', ${sqlId('route', '40_000_000 + n')},
            ${sqlId('route', '20_000_000 + n')}, 1
     FROM rows`,
    [hotRoute, siblingRoute, otherRoute, first, scale, STANDARD_QUESTION_ID],
  );

  const hotPartition = partitionOf(hotRoute);
  const otherPartition = partitionOf(otherRoute);
  const partitionForOrdinal = `CASE WHEN mod(n, 4) = 3 THEN $6::integer ELSE $7::integer END`;
  const transactionId = sqlId('route', '50_000_000 + n');
  const eventId = sqlId('route', '60_000_000 + n');
  await db.admin.query(
    `WITH rows AS (
       SELECT n, ${routeForOrdinal} AS route, ${partitionForOrdinal} AS partition_no
       FROM generate_series($4::integer, $5::integer) AS series(n)
     )
     INSERT INTO core.receipt
       (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
        epoch, position, transaction_id, response)
     SELECT partition_no, 'account', $8::uuid, 'rating.source_statistic.write',
            '${historyPrefix}receipt-' || n, decode(repeat('00', 32), 'hex'), 1,
            ${positionBase} + n * 10, ${transactionId},
            jsonb_build_object('source', 'vndb', 'sourceRecordId', '${historyPrefix}' || n,
              'scale', jsonb_build_object('min', 0, 'max', 4096), 'mean', 3072.25,
              'count', 1234, 'asOf', '2026-10-01', 'licence', 'VNDB growth fixture licence',
              'attribution', 'VNDB growth fixture attribution.')
     FROM rows`,
    [hotRoute, siblingRoute, otherRoute, first, scale, otherPartition, hotPartition, input.importerId],
  );
  await db.admin.query(
    `WITH rows AS (
       SELECT n, ${routeForOrdinal} AS route, ${partitionForOrdinal} AS partition_no
       FROM generate_series($4::integer, $5::integer) AS series(n)
     )
     INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
     SELECT partition_no, ${positionBase} + n * 10, 0, 1, 1, ${eventId},
            'com.rezics.rating.source_statistic.changed.v1', '${historyPrefix}' || n,
            jsonb_build_object('source', 'vndb', 'sourceRecordId', '${historyPrefix}' || n)
     FROM rows`,
    [hotRoute, siblingRoute, otherRoute, first, scale, otherPartition, hotPartition],
  );
  await db.admin.query(
    `WITH rows AS (
       SELECT n, ${routeForOrdinal} AS route, ${partitionForOrdinal} AS partition_no
       FROM generate_series($4::integer, $5::integer) AS series(n)
     )
     INSERT INTO editorial.write_basis
       (partition_no, transaction_id, epoch, position, principal_kind, principal_id, client_id, requested_by)
     SELECT partition_no, ${transactionId}, 1, ${positionBase} + n * 10,
            'account', $8::uuid, 'rating-source-statistic-isolation-growth', NULL
     FROM rows`,
    [hotRoute, siblingRoute, otherRoute, first, scale, otherPartition, hotPartition, input.importerId],
  );
  await db.admin.query(
    `UPDATE core.partition
     SET position = greatest(position, $2::bigint)
     WHERE partition_no = ANY($1::integer[])`,
    [[hotPartition, otherPartition], positionBase + scale * 10],
  );

  const counts = await db.admin.query<{
    subjects: number;
    subjects_hot: number;
    statistics: number;
    statistics_hot: number;
    votes: number;
    votes_hot: number;
    receipts: number;
    receipts_hot: number;
    outbox: number;
    outbox_hot: number;
    basis: number;
    basis_hot: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM semantic.subject WHERE recorded_transaction_id = subject_id) AS subjects,
       (SELECT count(*)::integer FROM semantic.subject WHERE route = $1
          AND recorded_transaction_id = subject_id) AS subjects_hot,
       (SELECT count(*)::integer FROM rating.source_statistic WHERE source_record_id LIKE '${historyPrefix}%') AS statistics,
       (SELECT count(*)::integer FROM rating.source_statistic WHERE route = $1 AND source_record_id LIKE '${historyPrefix}%') AS statistics_hot,
       (SELECT count(*)::integer FROM rating.vote WHERE question_id = $2 AND units = 20
          AND changed_at = '2026-10-01T00:00:00Z') AS votes,
       (SELECT count(*)::integer FROM rating.vote WHERE route = $1 AND question_id = $2 AND units = 20
          AND changed_at = '2026-10-01T00:00:00Z') AS votes_hot,
       (SELECT count(*)::integer FROM core.receipt WHERE command_kind = 'rating.source_statistic.write'
          AND idempotency_key LIKE '${historyPrefix}receipt-%') AS receipts,
       (SELECT count(*)::integer FROM core.receipt WHERE partition_no = $3
          AND idempotency_key LIKE '${historyPrefix}receipt-%') AS receipts_hot,
       (SELECT count(*)::integer FROM core.outbox WHERE type = 'com.rezics.rating.source_statistic.changed.v1'
          AND subject LIKE '${historyPrefix}%') AS outbox,
       (SELECT count(*)::integer FROM core.outbox WHERE partition_no = $3
          AND subject LIKE '${historyPrefix}%') AS outbox_hot,
       (SELECT count(*)::integer FROM editorial.write_basis WHERE client_id = 'rating-source-statistic-isolation-growth') AS basis,
       (SELECT count(*)::integer FROM editorial.write_basis WHERE partition_no = $3
          AND client_id = 'rating-source-statistic-isolation-growth') AS basis_hot`,
    [hotRoute, STANDARD_QUESTION_ID, hotPartition],
  );
  const actual = counts.rows[0]!;
  const hotRouteRows = scale / 2;
  const hotPartitionRows = (scale * 3) / 4;
  expect(actual).toEqual({
    subjects: scale,
    subjects_hot: hotRouteRows,
    statistics: scale,
    statistics_hot: hotRouteRows,
    votes: scale,
    votes_hot: hotRouteRows,
    receipts: scale,
    receipts_hot: hotPartitionRows,
    outbox: scale,
    outbox_hot: hotPartitionRows,
    basis: scale,
    basis_hot: hotPartitionRows,
  });
}

async function json(response: Response, expectedStatus = 200): Promise<unknown> {
  const text = await response.clone().text();
  if (response.status !== expectedStatus)
    throw new Error(`Expected HTTP ${expectedStatus}, received ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

beforeAll(async () => {
  fixture = await createSourceStatisticIsolationFixture(fixtureOptions);
}, 180_000);

afterAll(async () => {
  await fixture?.close();
});

test('The distinct joined native outcomes and three-scale bounded growth retain the existing owner contracts.', async () => {
  const subjectId = await fixture.createSubject('Fixed source statistic growth target');
  await fixture.grantImporter(fixture.actors.importer);
  const hotRoute = routeOf(subjectId)!;
  const checkName = 'rating source statistic fixed-subject write replay read under source and vote history growth';
  const report = await checkGrowth(fixture.database, {
    name: checkName,
    scales: SOURCE_STATISTIC_GROWTH_SCALES,
    repetitions: 2,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (db, scale, previous) =>
      seedUnrelatedHistory(db, scale, previous, {
        hotRoute,
        importerId: fixture.actors.importer.actor.accountId,
      }),
    operation: async (_db, scale, repetition) => {
      const key = `source-isolation-growth-${scale}-${repetition}-${randomUUID()}`;
      const path = `/v1/subjects/${subjectId}/source-statistics/vndb`;
      const write = await fixture.request('PUT', path, {
        actor: fixture.actors.importer,
        body: fixedStatistic,
        key,
      });
      const committed = await json(write);
      expect(committed).toEqual({ source: 'vndb', ...fixedStatistic });

      const replay = await fixture.request('PUT', path, {
        actor: fixture.actors.importer,
        body: fixedStatistic,
        key,
      });
      const replayed = await json(replay);
      expect(replayed).toEqual(committed);

      const read = await fixture.request('GET', `/v1/subjects/${subjectId}/source-statistics`, {
        actor: fixture.actors.importer,
      });
      const result = await json(read);
      expect(result).toEqual([{ source: 'vndb', ...fixedStatistic }]);
      return { committed, replayed, result };
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([...SOURCE_STATISTIC_GROWTH_SCALES]);
  const touchedRelations = [
    ...new Set(
      report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations))),
    ),
  ];
  expect(touchedRelations).toEqual(
    expect.arrayContaining([
      'semantic.subject',
      'rating.source_statistic',
      'core.partition',
      'core.receipt',
      'core.outbox',
      'editorial.write_basis',
    ]),
  );
  assertGrowthAccessPaths(checkName, report.samples, touchedRelations);
});
