import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import type { RatingCounter } from '../../src/access/rating-counter.ts';
import { applyRatingChanges, applyRatingSegmentPageEvent, readAggregate } from '../../src/rating/aggregate-effect.ts';
import {
  createRatingSegmentJobEffect,
  finishRatingPopulationJob,
  processRatingSegmentPage,
  type RatingSegmentJob,
} from '../../src/rating/segment-job.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { WorkClient } from '../../src/work/client.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x3a0b;
const oldKey = '11'.padEnd(64, '0');
const newKey = '22'.padEnd(64, '0');
const changedAt = '2026-10-27 12:00:00.123456+00';
const transferredAt = '2026-10-27 13:00:00.123456+00';
const target = (ordinal: number) => `00000000-0000-7000-8000-3a0b${ordinal.toString(16).padStart(8, '0')}`;
let database: GrowthDatabase;

async function seedVote(input: {
  voterId: string;
  targetId: string;
  units: number;
  countingKey: string;
  at: string;
  populations: string[];
  counted?: boolean;
}): Promise<void> {
  await database.admin.query(
    `INSERT INTO rating.vote (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
     VALUES ($1, $2, $3, $4, $5, 1, $6::timestamptz, $7)`,
    [route, input.voterId, STANDARD_QUESTION_ID, input.targetId, input.units, input.at, newId(route)],
  );
  if (input.counted === false) return;
  await applyRatingChanges(
    database.pool,
    input.populations.map((populationId) => ({
      voterId: input.voterId,
      countingKey: input.countingKey,
      questionId: STANDARD_QUESTION_ID,
      populationId,
      targetId: input.targetId,
      units: input.units,
      revision: 1,
      at: input.at,
    })),
  );
}

function pageEvent(data: unknown): CloudEvent {
  return {
    specversion: '1.0',
    id: newId(route),
    source: 'urn:rezics:log:1.1',
    type: 'com.rezics.rating.segment.page.v1',
    time: transferredAt,
    datacontenttype: 'application/json',
    sequence: '1',
    data,
  };
}

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  if (database) await database.close();
});

test('counter change rekeys every vote by resumable pages and replay changes nothing', async () => {
  const voterId = newId(route);
  const oldControllerAccount = newId(route);
  const newControllerAccount = newId(route);
  const realmId = newId(0x6b0b);
  const populations = [GLOBAL_CONTEXT.id, realmId];
  await database.admin.query(
    `INSERT INTO rating.voter_realm (route, voter_id, realm_id, joined_at, state)
     VALUES ($1, $2, $3, $4::timestamptz, 'counted')`,
    [route, voterId, realmId, changedAt],
  );

  for (let ordinal = 1; ordinal <= 205; ordinal++)
    await seedVote({
      voterId,
      targetId: target(ordinal),
      units: ordinal % 21,
      countingKey: oldKey,
      at: changedAt,
      populations,
      counted: ordinal !== 205,
    });
  await seedVote({
    voterId: oldControllerAccount,
    targetId: target(1),
    units: 2,
    countingKey: oldKey,
    at: '2026-10-27 11:00:00.000000+00',
    populations,
  });
  await seedVote({
    voterId: newControllerAccount,
    targetId: target(1),
    units: 8,
    countingKey: newKey,
    at: '2026-10-27 12:30:00.000000+00',
    populations,
  });

  const counterChange: CloudEvent = {
    specversion: '1.0',
    id: newId(route),
    source: 'urn:rezics:log:1.1',
    subject: voterId,
    type: 'com.rezics.access.rating-counter.changed.v1',
    time: transferredAt,
    datacontenttype: 'application/json',
    sequence: '1',
    data: { accountId: voterId, at: transferredAt },
  };
  const scheduled: unknown[] = [];
  const client = {
    enqueue: async (_options: unknown, job: unknown) => {
      scheduled.push(job);
    },
  } as unknown as WorkClient;
  await createRatingSegmentJobEffect(database.pool, client).run(counterChange);
  expect(scheduled).toHaveLength(1);
  const job = scheduled[0] as RatingSegmentJob;
  expect(job).toMatchObject({
    voterId,
    direction: 'rekey',
    transitionId: counterChange.id,
    at: transferredAt,
    populations,
  });
  let after = null;
  let firstPage: Awaited<ReturnType<typeof processRatingSegmentPage>> | undefined;
  let pages = 0;
  while (true) {
    const result = await processRatingSegmentPage(database.pool, { ...job, after });
    if (result.done) break;
    pages++;
    expect(result.eventData.votes.length).toBeLessThanOrEqual(100);
    firstPage ??= result;
    const event = pageEvent(result.eventData);
    const counter: RatingCounter = async (_client, accountId, at) => {
      expect(accountId).toBe(voterId);
      expect(at).toBe(transferredAt);
      return newKey;
    };
    await applyRatingSegmentPageEvent(database.pool, counter, event);
    if (pages === 1) {
      const beforeReplay = await readAggregate(database.pool, {
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        targetId: target(1),
      });
      await applyRatingSegmentPageEvent(database.pool, counter, event);
      expect(
        await readAggregate(database.pool, {
          questionId: STANDARD_QUESTION_ID,
          populationId: GLOBAL_CONTEXT.id,
          targetId: target(1),
        }),
      ).toEqual(beforeReplay);
    }
    after = result.cursor;
  }

  expect(pages).toBe(3);
  expect(firstPage?.eventData.votes).toHaveLength(100);
  for (const populationId of populations) {
    const counts = await database.admin.query(
      `SELECT counting_key, count(*)::int AS count FROM rating.population_vote
       WHERE route = $1 AND population_id = $2 AND voter_id = $3
       GROUP BY counting_key ORDER BY counting_key`,
      [routeOf(target(1)), populationId, voterId],
    );
    expect(counts.rows).toEqual([{ counting_key: newKey, count: 205 }]);
    expect(
      await readAggregate(database.pool, {
        questionId: STANDARD_QUESTION_ID,
        populationId,
        targetId: target(1),
      }),
    ).toMatchObject({ count: 2n, sum: 10n });
    const oldControllerAggregate = await database.admin.query(
      `SELECT counting_key, units FROM rating.population_vote
       WHERE route = $1 AND population_id = $2 AND target_id = $3 AND units IS NOT NULL
       ORDER BY counting_key`,
      [routeOf(target(1)), populationId, target(1)],
    );
    expect(oldControllerAggregate.rows).toContainEqual({ counting_key: oldKey, units: 2 });
    expect(oldControllerAggregate.rows).toContainEqual({ counting_key: newKey, units: 8 });
  }
  await finishRatingPopulationJob(database.pool, job);
});

test('a re-key page does not restore votes for an ineligible account', async () => {
  const voterId = newId(route);
  await database.admin.query(
    `INSERT INTO rating.vote (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
     VALUES ($1, $2, $3, $4, 7, 1, $5::timestamptz, $6)`,
    [route, voterId, STANDARD_QUESTION_ID, target(900), changedAt, newId(route)],
  );
  await database.admin.query(
    `INSERT INTO rating.voter_state (route, voter_id, state, transition_id, purge_votes, populations)
     VALUES ($1, $2, 'ineligible', $3, false, '{}')`,
    [route, voterId, newId(route)],
  );
  const event: CloudEvent = {
    specversion: '1.0',
    id: newId(route),
    source: 'urn:rezics:log:1.1',
    subject: voterId,
    type: 'com.rezics.access.rating-counter.changed.v1',
    time: transferredAt,
    datacontenttype: 'application/json',
    sequence: '1',
    data: { accountId: voterId, at: transferredAt },
  };
  const scheduled: unknown[] = [];
  const client = {
    enqueue: async (_options: unknown, job: unknown) => {
      scheduled.push(job);
    },
  } as unknown as WorkClient;
  await createRatingSegmentJobEffect(database.pool, client).run(event);
  const job = scheduled[0] as RatingSegmentJob;
  const page = await processRatingSegmentPage(database.pool, { ...job, after: null });
  expect(page.eventData.votes).toHaveLength(1);
  expect(page.eventData.allowMissing).toBe(false);
  expect(page.eventData.votes[0]?.populations).toEqual([]);
  const counter: RatingCounter = async () => newKey;
  await applyRatingSegmentPageEvent(database.pool, counter, pageEvent(page.eventData));
  const rows = await database.admin.query(
    'SELECT count(*)::int AS count FROM rating.population_vote WHERE route = $1 AND voter_id = $2',
    [route, voterId],
  );
  expect(rows.rows[0].count).toBe(0);
  await finishRatingPopulationJob(database.pool, job);
});
