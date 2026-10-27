import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { drainPublicFigures } from '../../src/rating/public-figure.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4422;
const targetId = '00000000-0000-7000-8000-442200000001';
let database: GrowthDatabase;

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  await database?.close();
});

test('figure drain has constant rows and statements as votes on one subject grow', async () => {
  const report = await checkGrowth(database, {
    name: 'rating public figure drain voters',
    scales: [64, 256, 1024],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) => {
      await db.admin.query(
        `INSERT INTO rating.population_vote
           (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
         SELECT $1, $2, $3, $4,
                ('00000000-0000-7000-8000-4422' || lpad(to_hex(n), 8, '0'))::uuid,
                lpad(to_hex(n % 256), 2, '0') || repeat('0', 62), 10, $5, 1
         FROM generate_series($6::int + 1, $7::int) AS n`,
        [route, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, targetId, '2026-10-27T10:00:00.000Z', previous, scale],
      );
      await db.admin.query(
        `INSERT INTO rating.aggregate_component
           (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
         SELECT $1, $2, $3, $4, shard, $5::bigint / 16, ($5::bigint / 16) * 10,
                ARRAY(SELECT CASE WHEN unit = 10 THEN $5::bigint / 16 ELSE 0::bigint END
                      FROM generate_series(0, 20) AS unit), $6
         FROM generate_series(0, 15) AS shard
         ON CONFLICT (route, question_id, population_id, target_id, shard) DO UPDATE
         SET count = EXCLUDED.count, sum = EXCLUDED.sum, histogram = EXCLUDED.histogram,
             applied_at = EXCLUDED.applied_at`,
        [route, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, targetId, scale, '2026-10-27T10:00:00.000Z'],
      );
    },
    operation: async (db) => {
      const partition = partitionOf(routeOf(targetId)!);
      await db.admin.query(
        `WITH next_position AS (
           SELECT position + 1 AS position FROM core.partition WHERE partition_no = $5
         )
         INSERT INTO rating.public_figure
           (route, question_id, population_id, subject_id, pending_position)
         SELECT $1, $2, $3, $4, next_position.position FROM next_position
         ON CONFLICT (route, question_id, population_id, subject_id) DO UPDATE
         SET pending_position = EXCLUDED.pending_position`,
        [route, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, targetId, partition],
      );
      const drained = await drainPublicFigures(db.pool, partition);
      expect(drained).toBe(1);
      return drained;
    },
    repetitions: 2,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 256, 1024]);
  expect(report.samples.every(({ cost }) => cost.rows > 0)).toBe(true);
});
