import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { applyRatingChanges, applyRatingSegmentPageEvent, readAggregate } from '../../src/rating/aggregate-effect.ts';
import { createVoterEligibilityEffect, readRatingEligibilityJob } from '../../src/rating/eligibility.ts';
import { processRatingSegmentPage, type RatingSegmentJob, type SegmentCursor } from '../../src/rating/segment-job.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x3a09;
const at = '2026-10-27T10:00:00.000Z';
const countingKey = (voterId: string) => createHash('sha256').update(voterId).digest('hex');
const target = (ordinal: number) => `00000000-0000-7000-8000-3a09${ordinal.toString(16).padStart(8, '0')}`;
let database: GrowthDatabase;
let eligibilityEffect: ReturnType<typeof createVoterEligibilityEffect>;

function accountEvent(
  voterId: string,
  type:
    | 'com.rezics.access.account.suspended.v1'
    | 'com.rezics.access.account.reinstated.v1'
    | 'com.rezics.access.account-tombstoned.v1',
): CloudEvent {
  const receiptId = newId(route);
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:rezics:kernel',
    subject: voterId,
    type,
    time: at,
    datacontenttype: 'application/json',
    sequence: '1',
    data:
      type === 'com.rezics.access.account.suspended.v1'
        ? { accountId: voterId, state: 'suspended', minimumAuthnEpoch: '2', receiptId }
        : type === 'com.rezics.access.account.reinstated.v1'
          ? { accountId: voterId, state: 'active', minimumAuthnEpoch: '2', receiptId }
          : {
              accountId: voterId,
              receiptId,
              minimumAuthnEpoch: '2',
              kind: 'tombstone',
              priorOperatorAccountId: null,
            },
  };
}

async function seedVotes(voterId: string, count: number, realms: string[], targetOffset = 0): Promise<void> {
  await database.admin.query(
    `INSERT INTO rating.vote (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
     SELECT $1, $2, $3, ('00000000-0000-7000-8000-3a09' || lpad(to_hex(n + $6::integer), 8, '0'))::uuid,
            n % 21, 1, $4::timestamptz, ('00000000-0000-7000-8000-3a09' || lpad(to_hex(n + 100000), 8, '0'))::uuid
     FROM generate_series(1, $5::integer) AS n`,
    [route, voterId, STANDARD_QUESTION_ID, at, count, targetOffset],
  );
  for (const [index, realmId] of realms.entries()) {
    await database.admin.query(
      `INSERT INTO rating.voter_realm (route, voter_id, realm_id, joined_at, state)
       VALUES ($1, $2, $3, $4::timestamptz, 'counted')`,
      [route, voterId, realmId, new Date(Date.parse(at) + index).toISOString()],
    );
  }
  const populations = [GLOBAL_CONTEXT.id, ...realms];
  await applyRatingChanges(
    database.pool,
    Array.from({ length: count }, (_, index) =>
      populations.map((populationId) => ({
        voterId,
        countingKey: countingKey(voterId),
        questionId: STANDARD_QUESTION_ID,
        populationId,
        targetId: target(index + 1 + targetOffset),
        units: (index + 1) % 21,
        revision: 1,
        at,
      })),
    ).flat(),
  );
}

async function pageAll(job: RatingSegmentJob, after: SegmentCursor | null = null): Promise<void> {
  let cursor = after;
  while (true) {
    const result = await processRatingSegmentPage(database.pool, { ...job, after: cursor });
    await applyRatingSegmentPageEvent(database.pool, async (_client, voterId) => countingKey(voterId), {
      specversion: '1.0',
      id: randomUUID(),
      source: 'urn:rezics:log:1.1',
      type: 'com.rezics.rating.segment.page.v1',
      time: at,
      datacontenttype: 'application/json',
      sequence: '1',
      data: result.eventData,
    });
    if (result.done) return;
    cursor = result.cursor;
  }
}

async function activeJob(voterId: string): Promise<RatingSegmentJob> {
  const job = await readRatingEligibilityJob(database.pool, { voterId });
  if (!job) throw new Error('Expected an active rating eligibility job');
  return job;
}

async function countedVotes(populationId: string, voterId: string): Promise<number> {
  const row = await database.admin.query(
    `SELECT count(*)::int AS count FROM rating.population_vote
     WHERE route = $1 AND population_id = $2 AND voter_id = $3`,
    [route, populationId, voterId],
  );
  return row.rows[0].count;
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  eligibilityEffect = createVoterEligibilityEffect(database.pool);
});

afterAll(async () => {
  if (database) await database.close();
});

test('suspended votes leave Global and every counted Realm in paged jobs and return on reinstatement', async () => {
  const voterId = newId(route);
  const realms = [newId(0x6b09), newId(0x6b0a)];
  await seedVotes(voterId, 235, realms);

  await eligibilityEffect.run(accountEvent(voterId, 'com.rezics.access.account.suspended.v1'));
  const leaving = await activeJob(voterId);
  expect(leaving.direction).toBe('removing');
  await pageAll(leaving);

  for (const populationId of [GLOBAL_CONTEXT.id, ...realms]) {
    expect(await countedVotes(populationId, voterId)).toBe(0);
    expect(
      await readAggregate(database.pool, {
        questionId: STANDARD_QUESTION_ID,
        populationId,
        targetId: target(1),
      }),
    ).toMatchObject({ count: 0n, sum: 0n });
  }

  await eligibilityEffect.run(accountEvent(voterId, 'com.rezics.access.account.reinstated.v1'));
  await pageAll(await activeJob(voterId));
  for (const populationId of [GLOBAL_CONTEXT.id, ...realms]) {
    expect(await countedVotes(populationId, voterId)).toBe(235);
    expect(
      await readAggregate(database.pool, {
        questionId: STANDARD_QUESTION_ID,
        populationId,
        targetId: target(1),
      }),
    ).toMatchObject({ count: 1n, sum: 1n });
  }
});

test("a tombstoned account's votes leave every aggregate and are then deleted", async () => {
  const voterId = newId(route);
  const realms = [newId(0x6b09), newId(0x6b0a)];
  await seedVotes(voterId, 135, realms, 1000);

  await eligibilityEffect.run(accountEvent(voterId, 'com.rezics.access.account-tombstoned.v1'));
  await pageAll(await activeJob(voterId));

  const votes = await database.admin.query(
    'SELECT count(*)::int AS count FROM rating.vote WHERE route = $1 AND voter_id = $2',
    [route, voterId],
  );
  const memberships = await database.admin.query(
    'SELECT count(*)::int AS count FROM rating.voter_realm WHERE route = $1 AND voter_id = $2',
    [route, voterId],
  );
  expect(votes.rows[0].count).toBe(0);
  expect(memberships.rows[0].count).toBe(0);
  for (const populationId of [GLOBAL_CONTEXT.id, ...realms]) {
    expect(await countedVotes(populationId, voterId)).toBe(0);
    expect(
      await readAggregate(database.pool, {
        questionId: STANDARD_QUESTION_ID,
        populationId,
        targetId: target(1001),
      }),
    ).toMatchObject({ count: 0n, sum: 0n });
  }
});

test('eligibility jobs resume from their cursor and never apply a page twice', async () => {
  const voterId = newId(route);
  const realms = [newId(0x6b09)];
  await seedVotes(voterId, 235, realms, 2000);
  await eligibilityEffect.run(accountEvent(voterId, 'com.rezics.access.account.suspended.v1'));
  const job = await activeJob(voterId);

  const first = await processRatingSegmentPage(database.pool, { ...job, after: null });
  expect(first.eventData.votes).toHaveLength(100);
  await applyRatingSegmentPageEvent(database.pool, async (_client, id) => countingKey(id), {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:rezics:log:1.1',
    type: 'com.rezics.rating.segment.page.v1',
    time: at,
    datacontenttype: 'application/json',
    sequence: '1',
    data: first.eventData,
  });

  const replay = await processRatingSegmentPage(database.pool, { ...job, after: null });
  expect(replay.cursor).toEqual(first.cursor);
  expect(replay.eventData.votes).toEqual([]);
  expect(replay.done).toBe(false);
  await pageAll(job, first.cursor);

  for (const populationId of [GLOBAL_CONTEXT.id, ...realms]) {
    expect(await countedVotes(populationId, voterId)).toBe(0);
    expect(
      await readAggregate(database.pool, {
        questionId: STANDARD_QUESTION_ID,
        populationId,
        targetId: target(2101),
      }),
    ).toMatchObject({ count: 0n, sum: 0n });
  }
});
