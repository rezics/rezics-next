import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { EVENT_TYPES } from '../../src/events/catalogue.ts';
import {
  applyRatingChanges,
  applyRatingVoteEvent,
  readAggregate,
  readPopulationVoters,
} from '../../src/rating/aggregate-effect.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4123;
const aggregateEvent = 'com.rezics.rating.aggregate.applied.v1';
const sourceType = 'com.rezics.rating.vote.changed.v1';
const at = '2026-10-27 10:00:00.123456+00';
let database: GrowthDatabase;

function change(input: {
  voterId?: string;
  countingKey?: string;
  populationId?: string;
  targetId?: string;
  units: number | null;
  revision?: number;
  at?: string;
}) {
  return {
    voterId: input.voterId ?? newId(route),
    countingKey: input.countingKey ?? '01'.padEnd(64, '0'),
    questionId: STANDARD_QUESTION_ID,
    populationId: input.populationId ?? GLOBAL_CONTEXT.id,
    targetId: input.targetId ?? newId(route),
    units: input.units,
    revision: input.revision ?? 1,
    at: input.at ?? at,
  };
}

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  if (database) await database.close();
});

test('a newer vote subtracts the previous components, adds the new ones, and replay changes nothing', async () => {
  const targetId = newId(route);
  const first = change({ targetId, units: 5, revision: 1 });
  await applyRatingChanges(database.pool, [first]);
  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId,
    }),
  ).toMatchObject({ count: 1n, sum: 5n, histogram: expect.arrayContaining([0n, 1n]) });

  const sameValue = { ...first, revision: 2, at: '2026-10-27 10:00:30.123456+00' };
  await applyRatingChanges(database.pool, [sameValue]);
  const stored = await database.admin.query(
    `SELECT revision FROM rating.population_vote
      WHERE route = $1 AND question_id = $2 AND population_id = $3 AND target_id = $4 AND voter_id = $5`,
    [routeOf(first.targetId), first.questionId, first.populationId, first.targetId, first.voterId],
  );
  expect(stored.rows[0].revision).toBe(2);

  const updated = { ...first, units: 9, revision: 3, at: '2026-10-27 10:01:00.123456+00' };
  await applyRatingChanges(database.pool, [updated]);
  const afterUpdate = await readAggregate(database.pool, {
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    targetId,
  });
  expect(afterUpdate?.count).toBe(1n);
  expect(afterUpdate?.sum).toBe(9n);
  expect(afterUpdate?.histogram[5]).toBe(0n);
  expect(afterUpdate?.histogram[9]).toBe(1n);

  await applyRatingChanges(database.pool, [updated]);
  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId,
    }),
  ).toEqual(afterUpdate);
  expect(EVENT_TYPES()[aggregateEvent]).toBeDefined();
});

test('votes spread across sixteen shards and read back to exact totals', async () => {
  const targetId = newId(route);
  const votes = Array.from({ length: 48 }, (_, ordinal) =>
    change({
      voterId: newId(route),
      countingKey: ordinal.toString(16).padStart(2, '0').padEnd(64, '0'),
      targetId,
      units: ordinal % 21,
      at: `2026-10-27 10:${String(ordinal).padStart(2, '0')}:00+00`,
    }),
  );
  await applyRatingChanges(database.pool, votes);

  const result = await readAggregate(database.pool, {
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    targetId,
  });
  expect(result?.count).toBe(48n);
  expect(result?.sum).toBe(BigInt(votes.reduce((sum, vote) => sum + (vote.units ?? 0), 0)));
  expect(result?.histogram).toHaveLength(21);
  for (let units = 0; units <= 20; units++) {
    expect(result?.histogram[units]).toBe(2n + (units < 6 ? 1n : 0n));
  }
  const shards = await database.admin.query(
    `SELECT count(*)::int AS count FROM rating.aggregate_component
      WHERE route = $1 AND question_id = $2 AND population_id = $3 AND target_id = $4`,
    [routeOf(targetId), STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, targetId],
  );
  expect(shards.rows[0].count).toBe(16);
});

test('accounts sharing a controller count once, and clearing the latest vote reveals the prior current vote', async () => {
  const targetId = newId(route);
  const countingKey = 'ab'.padEnd(64, '0');
  const earlier = change({ targetId, countingKey, units: 3, at: '2026-10-27 10:00:00+00' });
  const later = change({
    targetId,
    countingKey,
    units: 8,
    at: '2026-10-27 10:01:00+00',
  });
  await applyRatingChanges(database.pool, [earlier, later]);
  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId,
    }),
  ).toMatchObject({ count: 1n, sum: 8n, histogram: expect.arrayContaining([0n, 1n]) });

  await applyRatingChanges(database.pool, [
    {
      ...later,
      units: null,
      revision: 2,
      at: '2026-10-27 10:02:00+00',
    },
  ]);
  const result = await readAggregate(database.pool, {
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    targetId,
  });
  expect(result?.count).toBe(1n);
  expect(result?.sum).toBe(3n);
  expect(result?.histogram[3]).toBe(1n);
  expect(result?.histogram[8]).toBe(0n);
});

test('the event effect uses its exact T for the private key and pages population voters', async () => {
  const targetId = newId(route);
  const voterId = newId(route);
  const seen: Array<{ accountId: string; at: string | Date }> = [];
  const event = {
    specversion: '1.0' as const,
    id: newId(route),
    source: 'urn:rezics:log:1.1',
    type: sourceType,
    time: '2026-10-27 10:03:00.123456+00',
    datacontenttype: 'application/json' as const,
    sequence: '0000000000000000001',
    data: {
      voterId,
      questionId: STANDARD_QUESTION_ID,
      targetId,
      previous: null,
      units: 6,
      revision: 1,
      populations: [GLOBAL_CONTEXT.id],
    },
  };
  await applyRatingVoteEvent(
    database.pool,
    async (_client, accountId, instant) => {
      seen.push({ accountId, at: instant });
      return '2a'.padEnd(64, '0');
    },
    event,
  );
  expect(seen).toEqual([{ accountId: voterId, at: event.time }]);

  const firstPage = await readPopulationVoters(database.pool, {
    populationId: GLOBAL_CONTEXT.id,
    targetId,
    after: null,
    limit: 1,
  });
  expect(firstPage).toMatchObject([{ questionId: STANDARD_QUESTION_ID, voterId, units: 6, revision: 1 }]);
  expect(firstPage[0]).not.toHaveProperty('countingKey');
  expect(
    await readPopulationVoters(database.pool, {
      populationId: GLOBAL_CONTEXT.id,
      targetId,
      after: { questionId: firstPage[0]!.questionId, voterId: firstPage[0]!.voterId },
      limit: 1,
    }),
  ).toEqual([]);
});
