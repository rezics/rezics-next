import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { runCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { RATING_EVENTS } from './events.ts';
import decrementPending from './population-pending-decrement.sql';
import incrementPending from './population-pending-increment.sql';
import readRealm from './voter-realm-read.sql';
import readJob from './voter-realm-job-read.sql';
import updateRealm from './voter-realm-update.sql';
import promoteRealm from './voter-realm-promote.sql';
import pageVotes from './segment-votes-page.sql';
import { finishVoterRealmRemoval, type VoterRealmJob } from './voter-realms.ts';

export const RATING_SEGMENT_WORKFLOW = 'rating.segmentJob';
export const RATING_SEGMENT_PAGE_SIZE = 100;
const REALM_CHANGED = 'com.rezics.rating.voter-realm.changed.v1';
const SEGMENT_PAGE = 'com.rezics.rating.segment.page.v1';
const POPULATION_PENDING = 'com.rezics.rating.population.pending.v1';

export type SegmentCursor = { questionId: string; targetId: string };
export type SegmentVote = SegmentCursor & { units: number | null; revision: number };
export type RatingSegmentJob = {
  voterId: string;
  realmId: string;
  direction: 'adding' | 'removing';
  transitionId: string;
};
export type SegmentPageEventData = {
  voterId: string;
  realmId: string;
  direction: 'adding' | 'removing';
  votes: SegmentVote[];
};
export type SegmentPageResult = {
  cursor: SegmentCursor | null;
  done: boolean;
  eventData: SegmentPageEventData;
  nextJobs: RatingSegmentJob[];
};

type RealmRow = {
  state: string;
  cursorQuestionId: string | null;
  cursorTargetId: string | null;
  limitQuestionId: string | null;
  limitTargetId: string | null;
  rejoin: boolean;
  transitionId: string;
};

type VotePageInput = {
  route: number;
  voterId: string;
  after: SegmentCursor | null;
  limit: number;
  direction: 'adding' | 'removing';
  limitKey: SegmentCursor | null;
};

type Queryable = Pick<Pool | PoolClient, 'query'>;

function validId(value: string): boolean {
  return routeOf(value) !== null;
}

function compare(a: SegmentCursor, b: SegmentCursor): number {
  if (a.questionId !== b.questionId) return a.questionId < b.questionId ? -1 : 1;
  return a.targetId === b.targetId ? 0 : a.targetId < b.targetId ? -1 : 1;
}

function cursorOf(questionId: string | null, targetId: string | null): SegmentCursor | null {
  if (questionId === null || targetId === null) return null;
  return { questionId, targetId };
}

function validateJob(job: RatingSegmentJob): { voterRoute: number; populationRoute: number } {
  const voterRoute = routeOf(job.voterId);
  const populationRoute = routeOf(job.realmId);
  if (
    voterRoute === null ||
    populationRoute === null ||
    !validId(job.transitionId) ||
    (job.direction !== 'adding' && job.direction !== 'removing')
  )
    throw new TypeError('Invalid rating segment job');
  return { voterRoute, populationRoute };
}

function validateCursor(cursor: SegmentCursor | null): void {
  if (cursor !== null && (!validId(cursor.questionId) || !validId(cursor.targetId)))
    throw new TypeError('Invalid rating segment cursor');
}

/** Read a bounded keyset page from the voter's partition without loading the member's full vote set. */
export async function readRatingSegmentVotes(client: Queryable, input: VotePageInput): Promise<SegmentVote[]> {
  if (
    !Number.isSafeInteger(input.route) ||
    input.route < 0 ||
    input.route > 65535 ||
    routeOf(input.voterId) !== input.route ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > RATING_SEGMENT_PAGE_SIZE ||
    (input.direction !== 'adding' && input.direction !== 'removing')
  )
    throw new TypeError('Invalid rating segment vote page');
  validateCursor(input.after);
  validateCursor(input.limitKey);
  if (input.direction === 'adding' && input.limitKey !== null)
    throw new TypeError('Adding segment pages cannot have an upper key');
  const rows = await pageVotes.run(client, {
    route: input.route,
    voter_id: input.voterId,
    after_question_id: input.after?.questionId ?? null,
    after_target_id: input.after?.targetId ?? null,
    limit_question_id: input.limitKey?.questionId ?? null,
    limit_target_id: input.limitKey?.targetId ?? null,
    limit: input.limit,
  });
  return rows.map((row) => ({
    questionId: row.questionId,
    targetId: row.targetId,
    units: row.units === null ? null : Number(row.units),
    revision: Number(row.revision),
  }));
}

/** Find the current transition without holding a voter connection while another partition is entered. */
export async function readRatingSegmentJob(
  pool: Pool,
  input: { voterId: string; realmId: string },
): Promise<RatingSegmentJob | null> {
  const route = routeOf(input.voterId);
  if (route === null || routeOf(input.realmId) === null) throw new TypeError('Invalid voter Realm address');
  const row = await withConnection(pool, (client) =>
    readJob.run(client, {
      route,
      voter_id: input.voterId,
      realm_id: input.realmId,
    }),
  );
  if (!row || (row.state !== 'adding' && row.state !== 'removing')) return null;
  return {
    voterId: input.voterId,
    realmId: input.realmId,
    direction: row.state,
    transitionId: row.transitionId,
  };
}

/** Increment a Realm's freshness counter once for this transition in the Realm's partition. */
export async function beginRatingPopulationJob(pool: Pool, job: RatingSegmentJob): Promise<void> {
  const { populationRoute } = validateJob(job);
  const action = 'rating.segment.pending.start';
  const receiptDigest = createHash('sha256')
    .update(JSON.stringify([action, job.realmId, job.transitionId]))
    .digest();
  const outcome = await runCommand(
    pool,
    {
      partition: partitionOf(populationRoute),
      receipt: {
        actorAccountId: job.voterId,
        kind: action,
        key: job.transitionId,
        digest: receiptDigest,
      },
    },
    async (tx) => {
      const row = await incrementPending.run(tx, { route: populationRoute, population_id: job.realmId });
      if (!row) throw new Error('Could not start rating population job');
      return {
        value: null,
        events: [
          {
            type: POPULATION_PENDING,
            subject: job.realmId,
            data: { populationId: job.realmId, pendingJobs: Number(row.pending_jobs) },
          },
        ],
      };
    },
  );
  if (!outcome) throw new Error('Realm partition is unavailable while starting rating population job');
}

/** Complete a Realm job once; replacement jobs are counted before the old transition is removed. */
export async function finishRatingPopulationJob(
  pool: Pool,
  job: RatingSegmentJob,
  nextJobs: readonly RatingSegmentJob[] = [],
): Promise<void> {
  for (const next of new Map(nextJobs.map((item) => [item.transitionId, item])).values())
    await beginRatingPopulationJob(pool, next);

  const { populationRoute } = validateJob(job);
  const action = 'rating.segment.pending.finish';
  const receiptDigest = createHash('sha256')
    .update(JSON.stringify([action, job.realmId, job.transitionId]))
    .digest();
  const outcome = await runCommand(
    pool,
    {
      partition: partitionOf(populationRoute),
      receipt: {
        actorAccountId: job.voterId,
        kind: action,
        key: job.transitionId,
        digest: receiptDigest,
      },
    },
    async (tx) => {
      const row = await decrementPending.run(tx, { route: populationRoute, population_id: job.realmId });
      if (!row) throw new Error('Rating population pending count would become negative');
      return {
        value: null,
        events: [
          {
            type: POPULATION_PENDING,
            subject: job.realmId,
            data: { populationId: job.realmId, pendingJobs: Number(row.pending_jobs) },
          },
        ],
      };
    },
  );
  if (!outcome) throw new Error('Realm partition is unavailable while finishing rating population job');
}

/** Process one page in the voter's partition. The stored cursor makes a command replay return a checkpoint, not a page twice. */
export async function processRatingSegmentPage(
  pool: Pool,
  input: RatingSegmentJob & { after: SegmentCursor | null },
): Promise<SegmentPageResult> {
  const { voterRoute } = validateJob(input);
  validateCursor(input.after);
  const data = (votes: SegmentVote[]): SegmentPageEventData => ({
    voterId: input.voterId,
    realmId: input.realmId,
    direction: input.direction,
    votes,
  });
  const outcome = await runCommand(pool, { partition: partitionOf(voterRoute) }, async (tx, command) => {
    const row = (await readRealm.run(tx, {
      route: voterRoute,
      voter_id: input.voterId,
      realm_id: input.realmId,
    })) as RealmRow | null;
    const empty = data([]);
    if (!row || row.transitionId !== input.transitionId || row.state !== input.direction)
      return {
        value: { cursor: input.after, done: true, eventData: empty, nextJobs: [] },
        events: [{ type: SEGMENT_PAGE, subject: input.voterId, data: empty }],
      };

    const cursor = cursorOf(row.cursorQuestionId, row.cursorTargetId);
    if (cursor !== null && input.after !== null && compare(cursor, input.after) < 0)
      throw new Error('Rating segment checkpoint is ahead of its voter Realm cursor');
    if (cursor !== null && (input.after === null || compare(cursor, input.after) > 0))
      return {
        value: { cursor, done: false, eventData: empty, nextJobs: [] },
        events: [{ type: SEGMENT_PAGE, subject: input.voterId, data: empty }],
      };
    if (cursor === null && input.after !== null)
      throw new Error('Rating segment cursor was reset within one transition');

    const limitKey = row.state === 'removing' ? cursorOf(row.limitQuestionId, row.limitTargetId) : null;
    const votes = await readRatingSegmentVotes(tx, {
      route: voterRoute,
      voterId: input.voterId,
      after: cursor,
      limit: RATING_SEGMENT_PAGE_SIZE,
      direction: input.direction,
      limitKey,
    });
    if (votes.length > 0) {
      const last = votes.at(-1)!;
      await updateRealm.run(tx, {
        route: voterRoute,
        voter_id: input.voterId,
        realm_id: input.realmId,
        state: input.direction,
        cursor_question_id: last.questionId,
        cursor_target_id: last.targetId,
        limit_question_id: row.limitQuestionId,
        limit_target_id: row.limitTargetId,
        rejoin: row.rejoin,
        transition_id: row.transitionId,
      });
      const eventData = data(votes);
      return {
        value: {
          cursor: { questionId: last.questionId, targetId: last.targetId },
          done: false,
          eventData,
          nextJobs: [],
        },
        events: [{ type: SEGMENT_PAGE, subject: input.voterId, data: eventData }],
      };
    }

    let nextJobs: VoterRealmJob[] = [];
    if (row.state === 'adding') {
      await updateRealm.run(tx, {
        route: voterRoute,
        voter_id: input.voterId,
        realm_id: input.realmId,
        state: 'counted',
        cursor_question_id: null,
        cursor_target_id: null,
        limit_question_id: null,
        limit_target_id: null,
        rejoin: false,
        transition_id: row.transitionId,
      });
    } else {
      nextJobs = await finishVoterRealmRemoval(tx, {
        route: voterRoute,
        voterId: input.voterId,
        realmId: input.realmId,
        transitionId: command.transactionId,
      });
    }
    const eventData = empty;
    return {
      value: { cursor, done: true, eventData, nextJobs },
      events: [
        { type: SEGMENT_PAGE, subject: input.voterId, data: eventData },
        ...nextJobs.map((next) => ({
          type: REALM_CHANGED,
          subject: input.voterId,
          data: { voterId: input.voterId, realmId: next.realmId },
        })),
      ],
    };
  });
  if (!outcome) throw new Error('Voter partition is unavailable while paging rating votes');
  return outcome.value;
}

/** Start the current row's durable workflow from its transition id, which prevents duplicate join events from forking jobs. */
export function createRatingSegmentJobEffect(pool: Pool, client: WorkContext['client']): Effect {
  return {
    name: 'rating_segment_job',
    types: [REALM_CHANGED],
    async run(event: CloudEvent) {
      if (event.type !== REALM_CHANGED || !Value.Check(RATING_EVENTS[REALM_CHANGED], event.data))
        throw new TypeError('Invalid voter Realm change event');
      const { voterId, realmId } = event.data as { voterId: string; realmId: string };
      const job = await readRatingSegmentJob(pool, { voterId, realmId });
      if (!job) return;
      const { voterRoute } = validateJob(job);
      await beginRatingPopulationJob(pool, job);
      await client.enqueue(
        {
          workflowName: RATING_SEGMENT_WORKFLOW,
          workflowID: ratingSegmentWorkflowId(job),
          workflowIDReusePolicy: 'return-existing',
          queueName: 'workflows',
          queuePartitionKey: String(partitionOf(voterRoute)),
        },
        job,
      );
    },
  };
}

export function ratingSegmentWorkflowId(job: RatingSegmentJob): string {
  validateJob(job);
  const key = createHash('sha256')
    .update(JSON.stringify([job.voterId, job.realmId, job.transitionId]))
    .digest('hex');
  return `rating.segment:${key}`;
}

/** Register page and finish steps plus the membership-change starter effect. */
export function registerRatingSegmentWork(context: WorkContext): void {
  const processPage = DBOS.registerStep(
    async (job: RatingSegmentJob, after: SegmentCursor | null) =>
      processRatingSegmentPage(context.pool, { ...job, after }),
    { name: 'rating.processSegmentPage', ...COMMAND_STEP_RETRIES },
  );
  const finishJob = DBOS.registerStep(
    async (job: RatingSegmentJob, nextJobs: RatingSegmentJob[]) =>
      finishRatingPopulationJob(context.pool, job, nextJobs),
    { name: 'rating.finishSegmentJob', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (job: RatingSegmentJob) => {
      let after: SegmentCursor | null = null;
      for (;;) {
        const result = await processPage(job, after);
        if (result.done) {
          await finishJob(job, result.nextJobs);
          return;
        }
        after = result.cursor;
      }
    },
    { name: RATING_SEGMENT_WORKFLOW },
  );
  context.addEffects([createRatingSegmentJobEffect(context.pool, context.client)]);
}
