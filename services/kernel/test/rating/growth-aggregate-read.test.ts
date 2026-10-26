import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { readAggregateFigure, readRatingPopulationPage } from '../../src/rating/aggregate-read.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const targetRoute = 0x4a03;
const targetId = '00000000-0000-7000-8000-4a0300000001';
const appliedAt = '2026-10-27T10:00:00.000Z';
let database: GrowthDatabase;

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  if (database) await database.close();
});

test('one population aggregate read has constant rows and statements as target voters grow', async () => {
  const report = await checkGrowth(database, {
    name: 'rating aggregate read voters',
    scales: [64, 256, 1024],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) => {
      await db.admin.query(
        `INSERT INTO rating.population_vote
           (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
         SELECT $1, $2, $3, $4, ('00000000-0000-7000-8000-4a03' || lpad(to_hex(n), 8, '0'))::uuid,
                lpad(to_hex(n % 256), 2, '0') || repeat('0', 62), 10, $5, 1
         FROM generate_series($6::int + 1, $7::int) AS n`,
        [targetRoute, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, targetId, appliedAt, previous, scale],
      );
      await db.admin.query(
        `INSERT INTO rating.aggregate_component
           (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
         SELECT $1, $2, $3, $4, shard, $5::bigint / 16, ($5::bigint / 16) * 10,
                ARRAY(SELECT CASE WHEN unit = 10 THEN $5::bigint / 16 ELSE 0::bigint END
                      FROM generate_series(0, 20) AS unit), $6
         FROM generate_series(0, 15) AS shard
         ON CONFLICT (route, question_id, population_id, target_id, shard) DO UPDATE
         SET count = EXCLUDED.count, sum = EXCLUDED.sum, histogram = EXCLUDED.histogram, applied_at = EXCLUDED.applied_at`,
        [targetRoute, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, targetId, scale, appliedAt],
      );
    },
    operation: (db) =>
      readAggregateFigure(db.pool, {
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        targetId,
      }),
    repetitions: 2,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 256, 1024]);
});

test('a target population page has constant rows and statements as rated populations grow', async () => {
  const report = await checkGrowth(database, {
    name: 'rating aggregate read populations',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) => {
      if (previous === 0)
        await db.admin.query(
          `INSERT INTO rating.aggregate_component
             (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
           SELECT $1, $2, ('00000000-0000-7000-8000-4a04' || lpad(to_hex(n), 8, '0'))::uuid, $3, 0,
                  1, 10, ARRAY(SELECT CASE WHEN unit = 10 THEN 1::bigint ELSE 0::bigint END
                               FROM generate_series(0, 20) AS unit), $4
           FROM generate_series(1, 4096) AS n`,
          [targetRoute, STANDARD_QUESTION_ID, '00000000-0000-7000-8000-4a030000fffe', appliedAt],
        );
      await db.admin.query(
        `INSERT INTO rating.aggregate_component
           (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
         SELECT $1, $2, ('00000000-0000-7000-8000-4a03' || lpad(to_hex(n), 8, '0'))::uuid, $3, 0,
                1, 10, ARRAY(SELECT CASE WHEN unit = 10 THEN 1::bigint ELSE 0::bigint END
                             FROM generate_series(0, 20) AS unit), $4
         FROM generate_series($5::int + 1, $6::int) AS n`,
        [targetRoute, STANDARD_QUESTION_ID, targetId, appliedAt, previous, scale],
      );
    },
    operation: (db) =>
      readRatingPopulationPage(db.pool, {
        questionId: STANDARD_QUESTION_ID,
        targetId,
        after: null,
        limit: 20,
      }),
    repetitions: 2,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  expect(
    await readAggregateFigure(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId: newId(targetRoute),
    }),
  ).toMatchObject({ count: 0, freshness: { asOf: null, updating: false } });
});
