import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createRatingCounter } from '../../src/access/rating-counter.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { applyRatingVoteEvent } from '../../src/rating/aggregate-effect.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

const targetRoute = 0x4a03;
const targetId = '00000000-0000-7000-8000-4a0300000001';
const controllerId = '00000000-0000-7000-8000-222200000001';
const controllerKey = new Uint8Array(32).fill(91);
const countingKey = createRatingCounter({ secret: controllerKey });
const measuredCountingKey = createHmac('sha256', controllerKey)
  .update(`access.rating-counter.v1\0${controllerId}`)
  .digest('hex');
const oldAt = '2026-10-27 09:00:00+00';
let database: GrowthDatabase;

function accountId(route: number, ordinal: number): string {
  return `00000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

const population: Population = {
  name: 'rating aggregate population',
  hotPartition: targetRoute >>> 4,
  hotShare: 1,
  rows: ({ ordinal, route }) => {
    const voterId = accountId(route, ordinal + 1);
    const otherTargetId = accountId(route, ordinal + 100_000);
    return {
      'access.rating_counter_controller': [
        { route, account_id: voterId, effective_at: '-infinity', controller_id: controllerId },
      ],
      'rating.population_vote': [
        {
          route: targetRoute,
          question_id: STANDARD_QUESTION_ID,
          population_id: GLOBAL_CONTEXT.id,
          target_id: targetId,
          voter_id: voterId,
          counting_key: measuredCountingKey,
          units: 0,
          at: oldAt,
          revision: 1,
        },
        {
          route,
          question_id: STANDARD_QUESTION_ID,
          population_id: GLOBAL_CONTEXT.id,
          target_id: otherTargetId,
          voter_id: voterId,
          counting_key: '5b'.padEnd(64, '0'),
          units: ordinal % 21,
          at: oldAt,
          revision: 1,
        },
      ],
    };
  },
  finish: async (admin) => {
    await admin.query(
      `INSERT INTO rating.aggregate_component
         (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
       VALUES ($1, $2, $3, $4, $5, 1, 0, ARRAY[1::bigint, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], $6)
       ON CONFLICT (route, question_id, population_id, target_id, shard) DO UPDATE
       SET count = 1, sum = 0,
           histogram = ARRAY[1::bigint, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
           applied_at = EXCLUDED.applied_at`,
      [
        targetRoute,
        STANDARD_QUESTION_ID,
        GLOBAL_CONTEXT.id,
        targetId,
        Number.parseInt(measuredCountingKey.slice(0, 2), 16) % 16,
        oldAt,
      ],
    );
  },
};

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  if (database) await database.close();
});

test('aggregate updates keep bounded rows and statements as votes, targets, accounts and source partitions grow', async () => {
  const report = await checkGrowth(database, {
    name: 'rating aggregate apply',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDatabase, scale, previous) =>
      seed({ pool: growthDatabase.pool, admin: growthDatabase.admin }, population, { from: previous, to: scale }),
    operation: async (_growthDatabase, scale, repetition) => {
      const ordinal = repetition;
      const voterId = accountId(placement(population, ordinal).route, ordinal + 1);
      const instant = new Date(Date.parse('2026-10-27T11:00:00.000Z') + repetition * 1000).toISOString();
      const event = {
        specversion: '1.0' as const,
        id: newId(0),
        source: 'urn:rezics:log:1.1',
        type: 'com.rezics.rating.vote.changed.v1',
        time: instant,
        datacontenttype: 'application/json' as const,
        sequence: '0000000000000000001',
        data: {
          voterId,
          questionId: STANDARD_QUESTION_ID,
          targetId,
          previous: 0,
          units: 0,
          revision: 2,
          populations: [GLOBAL_CONTEXT.id],
        },
      };
      return applyRatingVoteEvent(database.pool, countingKey, event);
    },
    repetitions: 2,
    warmups: 1,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  expect(routeOf(targetId)).toBe(targetRoute);
});
