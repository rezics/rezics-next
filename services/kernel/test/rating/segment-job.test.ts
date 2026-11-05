import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { applyRatingChanges, applyRatingSegmentPageEvent, readAggregate } from '../../src/rating/aggregate-effect.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork, type WorkModule } from '../../src/work/registry.ts';
import {
  beginRatingPopulationJob,
  createRatingSegmentJobEffect,
  finishRatingPopulationJob,
  processRatingSegmentPage,
  ratingSegmentWorkflowId,
  registerRatingSegmentWork,
  readRatingSegmentJob,
  type RatingSegmentJob,
  type SegmentCursor,
  type SegmentPageEventData,
} from '../../src/rating/segment-job.ts';
import { createVoterRealmsEffect } from '../../src/rating/voter-realms.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x3a07;
const at = '2026-10-27T10:00:00.000Z';
const countingKey = (voterId: string) => createHash('sha256').update(voterId).digest('hex');
const target = (ordinal: number) => `00000000-0000-7000-8000-3a07${ordinal.toString(16).padStart(8, '0')}`;
let database: GrowthDatabase;
let realmEffect: ReturnType<typeof createVoterRealmsEffect>;
let worker: Awaited<ReturnType<typeof composeWork>>;
let workClient: Awaited<ReturnType<typeof createWorkClient>>;

function membership(voterId: string, realmId: string, role: 'member' | null): CloudEvent {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:rezics:kernel',
    type: 'com.rezics.community.realm.membership.v1',
    time: at,
    datacontenttype: 'application/json',
    sequence: '1',
    data: {
      accountId: voterId,
      realmId,
      role,
      at: '2026-10-27 10:00:00+00',
      reservationId: newId(route),
      transactionId: newId(route),
    },
  };
}

async function seedVotes(voterId: string, count: number): Promise<void> {
  await database.admin.query(
    `INSERT INTO rating.vote (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
     SELECT $1, $2, $3, ('00000000-0000-7000-8000-3a07' || lpad(to_hex(n), 8, '0'))::uuid,
            n % 21, 1, $4::timestamptz, ('00000000-0000-7000-8000-3a07' || lpad(to_hex(n + 100000), 8, '0'))::uuid
     FROM generate_series(1, $5::integer) AS n`,
    [route, voterId, STANDARD_QUESTION_ID, at, count],
  );
}

async function job(voterId: string, realmId: string): Promise<RatingSegmentJob> {
  const value = await readRatingSegmentJob(database.pool, { voterId, realmId });
  if (!value) throw new Error('Expected an active voter Realm job');
  return value;
}

async function pageAll(current: RatingSegmentJob, after: SegmentCursor | null = null): Promise<void> {
  let cursor = after;
  while (true) {
    const result = await processRatingSegmentPage(database.pool, { ...current, after: cursor });
    await applyPage(result.eventData);
    if (result.done) {
      await finishRatingPopulationJob(database.pool, current, result.nextJobs);
      return;
    }
    cursor = result.cursor;
  }
}

async function applyPage(data: SegmentPageEventData): Promise<void> {
  await applyRatingSegmentPageEvent(database.pool, async (_client, voterId) => countingKey(voterId), {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:rezics:log:1.1',
    type: 'com.rezics.rating.segment.page.v1',
    time: at,
    datacontenttype: 'application/json',
    sequence: '1',
    data,
  });
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  realmEffect = createVoterRealmsEffect(database.pool);
  workClient = await createWorkClient(database.url);
  const module: WorkModule = { name: 'rating-segment-test', register: registerRatingSegmentWork };
  worker = await composeWork([module], { databaseUrl: database.url, pool: database.pool, client: workClient });
  await worker.launch();
});

afterAll(async () => {
  await worker?.shutdown();
  await workClient?.close();
  if (database) await database.close();
});

test('the registered DBOS workflow pages a join and clears the Realm freshness counter', async () => {
  const voterId = newId(route);
  const realmId = newId(0x6b07);
  await seedVotes(voterId, 235);
  await realmEffect.run(membership(voterId, realmId, 'member'));
  const current = await job(voterId, realmId);
  const event: CloudEvent = {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:rezics:log:1.1',
    type: 'com.rezics.rating.voter-realm.changed.v1',
    time: at,
    datacontenttype: 'application/json',
    sequence: '1',
    data: { voterId, realmId },
  };
  await createRatingSegmentJobEffect(database.pool, workClient).run(event);
  await workClient.retrieveWorkflow(ratingSegmentWorkflowId(current)).getResult({ pollingIntervalMs: 10 });

  const row = await database.admin.query(
    `SELECT state FROM rating.voter_realm WHERE route = $1 AND voter_id = $2 AND realm_id = $3`,
    [route, voterId, realmId],
  );
  expect(row.rows[0].state).toBe('counted');
  const pending = await database.admin.query(
    `SELECT pending_jobs FROM rating.population_pending WHERE route = $1 AND population_id = $2`,
    [0x6b07, realmId],
  );
  expect(pending.rows[0].pending_jobs).toBe(0);

  const pages = await database.admin.query(
    `SELECT id::text AS id, partition_no, epoch, position, recorded_at::text AS time, data
     FROM core.outbox WHERE subject = $1 AND type = 'com.rezics.rating.segment.page.v1'
     ORDER BY position, event_seq`,
    [voterId],
  );
  expect(pages.rows.map((page) => (page.data.votes as unknown[]).length)).toEqual([100, 100, 35, 0]);
  for (const page of pages.rows) {
    await applyRatingSegmentPageEvent(database.pool, async (_client, id) => countingKey(id), {
      specversion: '1.0',
      id: page.id,
      source: `urn:rezics:log:${page.partition_no}.${page.epoch}`,
      type: 'com.rezics.rating.segment.page.v1',
      time: page.time,
      sequence: String(page.position).padStart(19, '0'),
      datacontenttype: 'application/json',
      data: page.data,
    });
  }
  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: realmId,
      targetId: target(1),
    }),
  ).toMatchObject({ count: 1n, sum: 1n, updating: false });
});

test('joining adds existing votes in resumable pages of at most 100, while replay resumes at the cursor', async () => {
  const voterId = newId(route);
  const realmId = newId(0x6b07);
  await seedVotes(voterId, 235);
  await realmEffect.run(membership(voterId, realmId, 'member'));
  const current = await job(voterId, realmId);
  await beginRatingPopulationJob(database.pool, current);

  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: realmId,
      targetId: target(1),
    }),
  ).toMatchObject({ updating: true });

  const first = await processRatingSegmentPage(database.pool, { ...current, after: null });
  expect(first.eventData.votes).toHaveLength(100);
  await applyPage(first.eventData);

  // A worker crash after the voter command commits but before DBOS stores its step output must not reapply the page.
  const replay = await processRatingSegmentPage(database.pool, { ...current, after: null });
  expect(replay.cursor).toEqual(first.cursor);
  expect(replay.eventData.votes).toEqual([]);
  expect(replay.done).toBe(false);

  const changedTarget = first.eventData.votes[49]!.targetId;
  await database.admin.query(
    `UPDATE rating.vote SET units = 13, revision = 2, changed_at = $4::timestamptz
     WHERE route = $1 AND voter_id = $2 AND question_id = $3 AND target_id = $5`,
    [route, voterId, STANDARD_QUESTION_ID, '2026-10-27T10:01:00.000Z', changedTarget],
  );
  await applyRatingChanges(database.pool, [
    {
      voterId,
      countingKey: countingKey(voterId),
      questionId: STANDARD_QUESTION_ID,
      populationId: realmId,
      targetId: changedTarget,
      units: 13,
      revision: 2,
      at: '2026-10-27T10:01:00.000Z',
    },
  ]);

  await pageAll(current, first.cursor);
  const aggregate = await readAggregate(database.pool, {
    questionId: STANDARD_QUESTION_ID,
    populationId: realmId,
    targetId: changedTarget,
  });
  expect(aggregate).toMatchObject({ count: 1n, sum: 13n, updating: false });
});

test('leaving during adding removes the applied prefix, then rejoining during removal restores each vote once', async () => {
  const voterId = newId(route);
  const realmId = newId(0x6b07);
  await seedVotes(voterId, 235);
  await realmEffect.run(membership(voterId, realmId, 'member'));
  const adding = await job(voterId, realmId);
  await beginRatingPopulationJob(database.pool, adding);
  const first = await processRatingSegmentPage(database.pool, { ...adding, after: null });
  expect(first.eventData.votes).toHaveLength(100);
  await applyPage(first.eventData);

  await realmEffect.run(membership(voterId, realmId, null));
  const removing = await job(voterId, realmId);
  expect(removing.direction).toBe('removing');
  await realmEffect.run(membership(voterId, realmId, 'member'));
  await pageAll(removing);

  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: realmId,
      targetId: target(1),
    }),
  ).toMatchObject({ count: 0n, updating: true });

  const readding = await job(voterId, realmId);
  expect(readding.direction).toBe('adding');
  await pageAll(readding);

  const aggregate = await readAggregate(database.pool, {
    questionId: STANDARD_QUESTION_ID,
    populationId: realmId,
    targetId: target(1),
  });
  expect(aggregate).toMatchObject({ count: 1n, sum: 1n, updating: false });
  const totals = await database.admin.query(
    `SELECT count(*)::int AS count, sum(units)::int AS sum FROM rating.population_vote
     WHERE route = $1 AND population_id = $2 AND voter_id = $3 AND units IS NOT NULL`,
    [route, realmId, voterId],
  );
  expect(totals.rows[0]).toEqual({
    count: 235,
    sum: Array.from({ length: 235 }, (_, index) => (index + 1) % 21).reduce((a, b) => a + b, 0),
  });
});
