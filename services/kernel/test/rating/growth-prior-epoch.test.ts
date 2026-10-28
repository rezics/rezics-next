import { afterAll, beforeAll, expect, test } from 'bun:test';
import { applyRatingChanges } from '../../src/rating/aggregate-effect.ts';
import { drainPublicFigures } from '../../src/rating/public-figure.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4321;
const targetId = '00000000-0000-7000-8000-432100000001';
const totalPopulationId = newId(0x2123);
const totalPopulationRoute = routeOf(totalPopulationId)!;
const republishPopulationId = newId(0x2124);
const republishPopulationRoute = routeOf(republishPopulationId)!;
const noisePopulationId = newId(0x2125);
let database: GrowthDatabase;

function subject(ordinal: number): string {
  return `00000000-0000-7000-8000-4321${ordinal.toString(16).padStart(8, '0')}`;
}

function countingKey(): string {
  return `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
}

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  await database?.close();
});

test('counted population totals have constant rows and statements per vote as one population grows', async () => {
  const report = await checkGrowth(database, {
    name: 'rating counted population totals',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) => {
      await db.admin.query(
        `INSERT INTO rating.population_vote
           (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
         SELECT $1, $2, $3, $4,
                ('00000000-0000-7000-8000-4222' || lpad(to_hex(n), 8, '0'))::uuid,
                lpad(to_hex(n % 256), 2, '0') || repeat('0', 62), 10, $5, 1
         FROM generate_series($6::int + 1, $7::int) AS n`,
        [route, STANDARD_QUESTION_ID, totalPopulationId, targetId, '2026-10-28T10:00:00.000Z', previous, scale],
      );
      await db.admin.query(
        `WITH counts AS (
           SELECT (n % 16)::smallint AS shard, count(*)::bigint AS count
           FROM generate_series($6::int + 1, $7::int) AS n
           GROUP BY (n % 16)::smallint
         )
         INSERT INTO rating.aggregate_component
           (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
         SELECT $1, $2, $3, $4, counts.shard, counts.count, counts.count * 10,
                ARRAY(SELECT CASE WHEN unit = 10 THEN counts.count ELSE 0::bigint END
                      FROM generate_series(0, 20) AS unit), $5
         FROM counts
         ON CONFLICT (route, question_id, population_id, target_id, shard) DO UPDATE
         SET count = rating.aggregate_component.count + EXCLUDED.count,
             sum = rating.aggregate_component.sum + EXCLUDED.sum,
             histogram = ARRAY(SELECT rating.aggregate_component.histogram[index] + EXCLUDED.histogram[index]
                               FROM generate_subscripts(EXCLUDED.histogram, 1) AS bins(index) ORDER BY index),
             applied_at = EXCLUDED.applied_at`,
        [route, STANDARD_QUESTION_ID, totalPopulationId, targetId, '2026-10-28T10:00:00.000Z', previous, scale],
      );
      await db.admin.query(
        `WITH counts AS (
           SELECT (n % 16)::smallint AS shard, count(*)::bigint AS count
           FROM generate_series($4::int + 1, $5::int) AS n
           GROUP BY (n % 16)::smallint
         )
         INSERT INTO rating.population_total_component
           (route, question_id, population_id, shard, count, sum, needs_epoch_check)
         SELECT $1, $2, $3, counts.shard, counts.count, counts.count * 10, false
         FROM counts
         ON CONFLICT (route, question_id, population_id, shard) DO UPDATE
         SET count = rating.population_total_component.count + EXCLUDED.count,
             sum = rating.population_total_component.sum + EXCLUDED.sum`,
        [totalPopulationRoute, STANDARD_QUESTION_ID, totalPopulationId, previous, scale],
      );
    },
    operation: async (db) => {
      await applyRatingChanges(db.pool, [
        {
          voterId: newId(0x4222),
          countingKey: countingKey(),
          questionId: STANDARD_QUESTION_ID,
          populationId: totalPopulationId,
          targetId,
          units: 10,
          revision: 1,
          at: '2026-10-28T10:00:00.000Z',
        },
      ]);
      await db.admin.query(
        `UPDATE rating.population_total_component SET needs_epoch_check = false
         WHERE route = $1 AND question_id = $2 AND population_id = $3`,
        [totalPopulationRoute, STANDARD_QUESTION_ID, totalPopulationId],
      );
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  expect(report.samples.every(({ cost }) => cost.rows > 0)).toBe(true);
});

test('epoch republish has constant rows per bounded page as rated subjects grow', async () => {
  const report = await checkGrowth(database, {
    name: 'rating prior epoch republish page',
    scales: [256, 1024, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) => {
      if (previous === 0) {
        await db.admin.query(
          `INSERT INTO rating.aggregate_component
             (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
           SELECT $1, $2, $3,
                  ('00000000-0000-7000-8000-4321' || lpad(to_hex(n), 8, '0'))::uuid,
                  0, 1, 10, ARRAY(SELECT CASE WHEN unit = 10 THEN 1::bigint ELSE 0::bigint END
                                  FROM generate_series(0, 20) AS unit), $4
           FROM generate_series(10000, 14095) AS n`,
          [route, STANDARD_QUESTION_ID, noisePopulationId, '2026-10-28T10:00:00.000Z'],
        );
        await db.admin.query(
          `INSERT INTO rating.public_figure
             (route, question_id, population_id, subject_id, count, mean, score, m, c, prior_epoch,
              revision, as_of, position, published_prior_generation)
           SELECT $1, $2, $3,
                  ('00000000-0000-7000-8000-4321' || lpad(to_hex(n), 8, '0'))::uuid,
                  1, 5, 5, 5, 5, 1, 1, $4, 0, 1
           FROM generate_series(10000, 14095) AS n`,
          [route, STANDARD_QUESTION_ID, noisePopulationId, '2026-10-28T10:00:00.000Z'],
        );
      }
      await db.admin.query(
        `INSERT INTO rating.aggregate_component
           (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
         SELECT $1, $2, $3,
                ('00000000-0000-7000-8000-4321' || lpad(to_hex(n), 8, '0'))::uuid,
                0, 1, 10, ARRAY(SELECT CASE WHEN unit = 10 THEN 1::bigint ELSE 0::bigint END
                                FROM generate_series(0, 20) AS unit), $4
         FROM generate_series($5::int + 1, $6::int) AS n`,
        [route, STANDARD_QUESTION_ID, republishPopulationId, '2026-10-28T10:00:00.000Z', previous, scale],
      );
      await db.admin.query(
        `INSERT INTO rating.public_figure
           (route, question_id, population_id, subject_id, count, mean, score, m, c, prior_epoch,
            revision, as_of, position, published_prior_generation)
         SELECT $1, $2, $3,
                ('00000000-0000-7000-8000-4321' || lpad(to_hex(n), 8, '0'))::uuid,
                1, 5, 5, 5, 5, 1, 1, $4, 0, 1
         FROM generate_series($5::int + 1, $6::int) AS n`,
        [route, STANDARD_QUESTION_ID, republishPopulationId, '2026-10-28T10:00:00.000Z', previous, scale],
      );
      const shardCounts = Array.from(
        { length: 16 },
        (_, shard) => Math.floor(scale / 16) + (shard < scale % 16 ? 1 : 0),
      );
      await db.admin.query(
        `INSERT INTO rating.population_total_component
           (route, question_id, population_id, shard, count, sum, needs_epoch_check)
         SELECT $1, $2, $3, (ordinality - 1)::smallint, count, count * 10, false
         FROM unnest($4::bigint[]) WITH ORDINALITY AS totals(count, ordinality)
         ON CONFLICT (route, question_id, population_id, shard) DO UPDATE
         SET count = EXCLUDED.count, sum = EXCLUDED.sum`,
        [republishPopulationRoute, STANDARD_QUESTION_ID, republishPopulationId, shardCounts],
      );
      await db.admin.query(
        `INSERT INTO rating.population_prior_epoch
           (route, question_id, population_id, epoch, generation, start_count, m, c)
         VALUES ($1, $2, $3, 2, 2, 50, 6, 5)
         ON CONFLICT (route, question_id, population_id) DO UPDATE
         SET epoch = 2, generation = 2, start_count = 50, m = 6, c = 5`,
        [republishPopulationRoute, STANDARD_QUESTION_ID, republishPopulationId],
      );
      await db.admin.query(
        `INSERT INTO rating.population_prior_republish
           (route, question_id, population_id, generation, after_subject_id)
         VALUES ($1, $2, $3, 2, NULL)
         ON CONFLICT (route, question_id, population_id) DO UPDATE
         SET generation = 2, after_subject_id = NULL`,
        [republishPopulationRoute, STANDARD_QUESTION_ID, republishPopulationId],
      );
    },
    warmup: async (db) => {
      await db.admin.query(
        `UPDATE rating.population_prior_republish
         SET after_subject_id = NULL
         WHERE route = $1 AND question_id = $2 AND population_id = $3`,
        [republishPopulationRoute, STANDARD_QUESTION_ID, republishPopulationId],
      );
      await db.admin.query(
        `UPDATE rating.public_figure
         SET published_prior_generation = 1
         WHERE question_id = $1 AND population_id = $2 AND subject_id <= $3::uuid`,
        [STANDARD_QUESTION_ID, republishPopulationId, subject(4096)],
      );
    },
    operation: async (db) => {
      const drained = await drainPublicFigures(db.pool, partitionOf(route), 100);
      expect(drained).toBe(100);
      return drained;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  expect(report.samples.every(({ cost }) => cost.rows > 0)).toBe(true);
});
