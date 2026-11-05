import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/permission.ts';
import type { Account } from '../../src/access/account-data.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { applyRatingChanges, applyRatingVoteEvent, readAggregate } from '../../src/rating/aggregate-effect.ts';
import { processRatingSubjectMergePage, type RatingMergeCursor } from '../../src/rating/merge-job.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const route = 0x3a01;
const routeKey = new Uint8Array(32).fill(73);
const scopes = ['subject:read', 'rating:vote'];
const actorFor = (accountId: string): AccountActor => ({
  kind: 'account',
  accountId,
  scopes,
  clientId: 'rating-subject-merge-test',
  requestedBy: null,
  authnEpoch: 1,
});
const voterIds = [newId(route), newId(route), newId(route)];
const voters = voterIds.map(actorFor);
const realmId = newId(0x6b01);
const countingKey = (voterId: string) => createHash('sha256').update(voterId).digest('hex');
let database: GrowthDatabase;
let commands: ReturnType<typeof createVoteCommands>;
let mergedId: string;
let survivorId: string;

async function createReadableSubject(actor: AccountActor, label: string): Promise<string> {
  const key = randomUUID();
  const result = await createSubject(database.pool, {
    actor,
    target: subjectTarget(routeKey, actor.accountId, key),
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return result.subject.id;
}

async function applyVoteEvents(voterId: string): Promise<void> {
  const result = await database.admin.query<{
    id: string;
    partition_no: number;
    epoch: number;
    position: string;
    data: Record<string, unknown>;
    time: string;
  }>(
    `SELECT id::text AS id, partition_no, epoch, position::text AS position, data,
            to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time
       FROM core.outbox
      WHERE subject = $1 AND type = 'com.rezics.rating.vote.changed.v1'
      ORDER BY position, event_seq`,
    [voterId],
  );
  for (const row of result.rows) {
    const event: CloudEvent = {
      specversion: '1.0',
      id: row.id,
      source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
      type: 'com.rezics.rating.vote.changed.v1',
      subject: voterId,
      time: row.time,
      datacontenttype: 'application/json',
      sequence: row.position.padStart(19, '0'),
      data: row.data,
    };
    await applyRatingVoteEvent(database.pool, async (_client, id) => countingKey(id), event);
  }
}

async function putAndApply(actor: AccountActor, targetId: string, units: number | null) {
  const result = await commands.putVote(actor, { questionId: STANDARD_QUESTION_ID, targetId, units }, randomUUID());
  await applyVoteEvents(actor.accountId);
  return result;
}

async function seedMergeVoters(sourceId: string, count: number, firstOrdinal: number): Promise<string[]> {
  const ids = Array.from(
    { length: count },
    (_, index) => `00000000-0000-7000-8000-3a01${(firstOrdinal + index).toString(16).padStart(8, '0')}`,
  );
  await database.admin.query(
    `INSERT INTO rating.vote
       (route, voter_id, question_id, target_id, counted_target, units, revision, counted_revision, changed_at, transaction_id)
     SELECT $1, voter_id, $2, $3, $3, 8, 1, 1, '2026-10-27T10:00:00Z', transaction_id
       FROM unnest($4::uuid[], $5::uuid[]) AS seed(voter_id, transaction_id)`,
    [
      route,
      STANDARD_QUESTION_ID,
      sourceId,
      ids,
      ids.map(
        (_, index) => `00000000-0000-7000-8000-3a01${(firstOrdinal + count + index).toString(16).padStart(8, '0')}`,
      ),
    ],
  );
  await database.admin.query(
    `INSERT INTO rating.population_vote
       (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
     SELECT $1, $2, $3, $4, voter_id, counting_key, 8,
            '2026-10-27T10:00:00Z', 1
       FROM unnest($5::uuid[], $6::text[]) AS seed(voter_id, counting_key)`,
    [route, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, sourceId, ids, ids.map(countingKey)],
  );
  return ids;
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  await bootstrapRelease(database.pool, bundledRelease);
  const accounts = new Map<string, Account>();
  for (const actor of voters) {
    await database.admin.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
       VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
      [route, actor.accountId, newId(route)],
    );
    accounts.set(actor.accountId, (await readAccount(database.pool, route, actor.accountId))!);
    await database.admin.query(
      `INSERT INTO rating.voter_realm (route, voter_id, realm_id, joined_at, state, transition_id)
       VALUES ($1, $2, $3, '2026-10-27T10:00:00Z', 'counted', $4)`,
      [route, actor.accountId, realmId, newId(route)],
    );
  }
  const access = createAccess({
    actions: new Map([['subject:read', { anonymous: true }]]),
    accountEvidence: (actor) => accounts.get(actor.accountId) ?? null,
  });
  commands = createVoteCommands({
    createCommandRunner: createLibraryCommandRunner,
    pool: database.pool,
    access,
    clock: () => new Date('2026-10-27T10:00:00.000Z'),
  });
  const first = await createReadableSubject(voters[0]!, 'Merged rating subject');
  const second = await createReadableSubject(voters[0]!, 'Surviving rating subject');
  survivorId = first < second ? first : second;
  mergedId = first < second ? second : first;
});

afterAll(async () => {
  if (database) await database.close();
});

test('a subject merge counts each voter once, keeps cast targets, and lets a later survivor vote replace the moved vote', async () => {
  await putAndApply(voters[0]!, mergedId, 14);
  await putAndApply(voters[0]!, survivorId, 6);
  await putAndApply(voters[1]!, mergedId, 17);
  await putAndApply(voters[1]!, survivorId, 12);
  await putAndApply(voters[1]!, survivorId, null);
  await putAndApply(voters[2]!, mergedId, 11);

  await database.admin.query(
    `INSERT INTO semantic.redirect (route, subject_id, sequence, target, recorded_transaction_id)
     VALUES ($1, $2, 1, $3, $4)`,
    [routeOf(mergedId), mergedId, survivorId, newId(route)],
  );

  const page = await processRatingSubjectMergePage(database.pool, { id: mergedId, survivor: survivorId, after: null });
  expect(page.voters).toBe(3);
  expect(page.done).toBe(true);
  for (const voter of voters) await applyVoteEvents(voter.accountId);

  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId: survivorId,
    }),
  ).toMatchObject({ count: 2n, sum: 17n, updating: false });
  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: realmId,
      targetId: survivorId,
    }),
  ).toMatchObject({ count: 2n, sum: 17n, updating: false });
  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId: mergedId,
    }),
  ).toMatchObject({ count: 0n, sum: 0n, updating: false });

  const oldVotes = await database.admin.query<{ voter_id: string; target_id: string; counted_target: string | null }>(
    `SELECT voter_id::text, target_id::text, counted_target::text
       FROM rating.vote WHERE voter_id = ANY($1::uuid[]) ORDER BY voter_id, target_id`,
    [voters.map(({ accountId }) => accountId)],
  );
  expect(oldVotes.rows.filter((row) => row.target_id === mergedId)).toHaveLength(3);
  expect(
    oldVotes.rows.find((row) => row.voter_id === voters[2]!.accountId && row.target_id === mergedId)?.counted_target,
  ).toBe(survivorId);

  const later = await putAndApply(voters[2]!, survivorId, 8);
  expect(later).toMatchObject({ targetId: survivorId, units: 8 });
  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId: survivorId,
    }),
  ).toMatchObject({ count: 2n, sum: 14n, updating: false });
  const afterVote = await database.admin.query<{ target_id: string; counted_target: string | null }>(
    `SELECT target_id::text, counted_target::text FROM rating.vote
      WHERE voter_id = $1 AND question_id = $2 ORDER BY target_id`,
    [voters[2]!.accountId, STANDARD_QUESTION_ID],
  );
  expect(afterVote.rows).toEqual([
    { target_id: survivorId, counted_target: survivorId },
    { target_id: mergedId, counted_target: null },
  ]);
});

test('a merge page handles at most 100 voters and resumes after its voter cursor', async () => {
  const sourceId = newId(route);
  const targetId = newId(route);
  const ids = await seedMergeVoters(sourceId, 205, 0x10000000);
  let after: RatingMergeCursor | null = null;
  const pages: number[] = [];
  for (;;) {
    const page = await processRatingSubjectMergePage(database.pool, { id: sourceId, survivor: targetId, after });
    pages.push(page.voters);
    if (page.done) break;
    after = page.cursor;
  }
  expect(pages).toEqual([100, 100, 5]);

  const replay = await processRatingSubjectMergePage(database.pool, {
    id: sourceId,
    survivor: targetId,
    after: null,
  });
  expect(replay.voters).toBe(100);
  expect(replay.cursor?.voterId).toBe(ids.toSorted()[99]);
});

test('a later merge carries a previously merged vote forward without changing its cast target', async () => {
  const voterId = newId(route);
  const originalTarget = newId(route);
  const previousSurvivor = newId(route);
  const survivor = newId(route);
  await database.admin.query(
    `INSERT INTO rating.vote
       (route, voter_id, question_id, target_id, counted_target, units, revision, counted_revision, changed_at, transaction_id)
     VALUES ($1, $2, $3, $4, $5, 13, 1, 1, '2026-10-27T10:00:00Z', $6)`,
    [route, voterId, STANDARD_QUESTION_ID, originalTarget, previousSurvivor, newId(route)],
  );
  await applyRatingChanges(database.pool, [
    {
      voterId,
      countingKey: countingKey(voterId),
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId: previousSurvivor,
      units: 13,
      revision: 1,
      at: '2026-10-27T10:00:00.000Z',
    },
  ]);

  const page = await processRatingSubjectMergePage(database.pool, {
    id: previousSurvivor,
    survivor,
    after: null,
  });
  expect(page).toMatchObject({ voters: 1, done: true });
  await applyVoteEvents(voterId);

  const vote = await database.admin.query<{ target_id: string; counted_target: string | null }>(
    `SELECT target_id::text, counted_target::text FROM rating.vote WHERE voter_id = $1 AND question_id = $2`,
    [voterId, STANDARD_QUESTION_ID],
  );
  expect(vote.rows).toEqual([{ target_id: originalTarget, counted_target: survivor }]);
  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId: previousSurvivor,
    }),
  ).toMatchObject({ count: 0n, sum: 0n, updating: false });
  expect(
    await readAggregate(database.pool, {
      questionId: STANDARD_QUESTION_ID,
      populationId: GLOBAL_CONTEXT.id,
      targetId: survivor,
    }),
  ).toMatchObject({ count: 1n, sum: 13n, updating: false });
});

const growthRoute = 0x3a02;
const growthId = (ordinal: number) => `00000000-0000-7000-8000-3a02${ordinal.toString(16).padStart(8, '0')}`;
const growthTargets = [101, 102, 103, 104, 105, 106].map(growthId);
const growthIndexPopulation: Population = {
  name: 'rating merge page index seed',
  hotPartition: growthRoute >>> 4,
  hotShare: 1,
  rows: ({ ordinal }) => {
    const voterId = growthId(700000 + ordinal);
    return {
      'rating.voter_state': [{ route: growthRoute, voter_id: voterId, state: 'eligible' }],
      'rating.voter_realm': [
        {
          route: growthRoute,
          voter_id: voterId,
          realm_id: realmId,
          joined_at: '2026-10-27T10:00:00.000Z',
          state: 'counted',
        },
      ],
    };
  },
};
const growthPopulation: Population = {
  name: 'rating subject merge voters',
  hotPartition: growthRoute >>> 4,
  hotShare: 1,
  rows: ({ ordinal }) => {
    const voterId = growthId(10000 + ordinal);
    const votes = growthTargets.map((targetId, index) => ({
      route: growthRoute,
      voter_id: voterId,
      question_id: STANDARD_QUESTION_ID,
      target_id: targetId,
      counted_target: targetId,
      units: (ordinal + index) % 21,
      revision: 1,
      counted_revision: 1,
      changed_at: '2026-10-27T10:00:00.000Z',
      transaction_id: growthId(100000 + ordinal * 6 + index),
    }));
    return {
      'rating.vote': votes,
      'rating.population_vote': growthTargets.map((targetId, index) => ({
        route: growthRoute,
        question_id: STANDARD_QUESTION_ID,
        population_id: GLOBAL_CONTEXT.id,
        target_id: targetId,
        voter_id: voterId,
        counting_key: countingKey(voterId),
        units: (ordinal + index) % 21,
        at: '2026-10-27T10:00:00.000Z',
        revision: 1,
      })),
    };
  },
};

test('merge page has constant rows and statements as merged target voters grow', async () => {
  await seed(database, growthIndexPopulation, { from: 0, to: 4096 });
  const report = await checkGrowth(database, {
    name: 'rating subject merge page voters',
    rule: 'series',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    // Merge page Cost: one voter-page seek, then for each of 100 voters one question seek,
    // three vote locks, one update lookup and two vote-index insertions (PK and counted target).
    // The membership/state index population is fixed, as is the single-partition command envelope.
    indexProbes: 1 + 100 * (1 + 3 + 1 + 2),
    repetitions: 1,
    warmups: 1,
    grow: (db, scale, previous) => seed(db, growthPopulation, { from: previous, to: scale }),
    operation: async (_db, _scale, repetition) => {
      const page = await processRatingSubjectMergePage(database.pool, {
        id: growthTargets[repetition]!,
        survivor: growthId(900000 + repetition),
        after: null,
      });
      expect(page).toMatchObject({ voters: 100, done: false });
      return page;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
});
