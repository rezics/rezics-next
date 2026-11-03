import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import {
  authoritativeTimeValue,
  runCommand,
  type AuthoritativeTime,
  type CommandEvent,
  type CommandTransaction,
} from '../command/command.ts';
import type { RatingCounter } from '../access/rating-counter.ts';
import { applyRatingSegmentPageEvent } from './aggregate-effect.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { ACCESS_EVENTS } from '../access/events.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { RATING_EVENTS } from './events.ts';
import { isRatingEligibilityJob, readRatingEligibilityJob, type RatingEligibilityJob } from './eligibility.ts';
import { populationsForVoteKey } from './voter-realms.ts';
import recordErasurePage from './erasure-status-record.sql';
import decrementPending from './population-pending-decrement.sql';
import incrementPending from './population-pending-increment.sql';
import readRealm from './voter-realm-read.sql';
import readJob from './voter-realm-job-read.sql';
import updateRealm from './voter-realm-update.sql';
import pageVotes from './segment-votes-page.sql';
import readCapped from './voter-realms-capped.sql';
import ensureVoterState from './voter-state-ensure.sql';
import readVoterState from './voter-state-read.sql';
import updateVoterState from './voter-state-update.sql';
import deleteVotePage from './voter-votes-delete-page.sql';
import deleteVoterRealms from './erasure-status-delete-realms.sql';
import { finishVoterRealmRemoval, type VoterRealmJob } from './voter-realms.ts';
import { reconcileMergedSubjectVote, resolveSubjectTarget } from './merge-job.ts';

export const RATING_SEGMENT_WORKFLOW = 'rating.segmentJob';
export const RATING_SEGMENT_PAGE_SIZE = 100;
const REALM_CHANGED = 'com.rezics.rating.voter-realm.changed.v1';
const SEGMENT_PAGE = 'com.rezics.rating.segment.page.v1';
const POPULATION_PENDING = 'com.rezics.rating.population.pending.v1';
const COUNTER_CHANGED = 'com.rezics.access.rating-counter.changed.v1';

export type SegmentCursor = { questionId: string; targetId: string };
export type SegmentVote = SegmentCursor & {
  countedTargetId?: string | null;
  units: number | null;
  revision: number;
  populations: string[];
  changedAt?: string;
};
export type RatingRealmSegmentJob = {
  voterId: string;
  realmId: string;
  direction: 'adding' | 'removing';
  transitionId: string;
};
export type RatingRekeySegmentJob = {
  voterId: string;
  direction: 'rekey';
  transitionId: string;
  at: string;
  populations: string[];
};
export type RatingSegmentJob = RatingRealmSegmentJob | RatingEligibilityJob | RatingRekeySegmentJob;
export type SegmentPageEventData = {
  voterId: string;
  direction: 'adding' | 'removing' | 'rekey';
  at?: string;
  allowMissing?: boolean;
  erasurePageId?: string;
  votes: SegmentVote[];
};
export type SegmentPageResult = {
  eventTime?: string;
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
  direction: 'adding' | 'removing' | 'rekey';
  limitKey: SegmentCursor | null;
};
type StoredSegmentVote = SegmentCursor & {
  countedTargetId: string | null;
  units: number | null;
  revision: number;
  changedAt: string;
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

function isRatingRekeyJob(job: RatingSegmentJob): job is RatingRekeySegmentJob {
  return job.direction === 'rekey';
}

function validateJob(job: RatingSegmentJob): { voterRoute: number } {
  const voterRoute = routeOf(job.voterId);
  if (
    voterRoute === null ||
    !validId(job.transitionId) ||
    (job.direction !== 'adding' && job.direction !== 'removing' && job.direction !== 'rekey')
  )
    throw new TypeError('Invalid rating segment job');
  if (isRatingEligibilityJob(job)) {
    if (job.populations.length > 101 || job.populations.some((id) => !validId(id)))
      throw new TypeError('Invalid rating eligibility populations');
  } else if (isRatingRekeyJob(job)) {
    if (
      !Number.isFinite(Date.parse(job.at)) ||
      job.populations.length < 1 ||
      job.populations.length > 101 ||
      !job.populations.includes(GLOBAL_CONTEXT.id) ||
      job.populations.some((id) => !validId(id))
    )
      throw new TypeError('Invalid rating re-key populations or time');
  } else if (routeOf(job.realmId) === null) throw new TypeError('Invalid rating segment population');
  return { voterRoute };
}

function validateCursor(cursor: SegmentCursor | null): void {
  if (cursor !== null && (!validId(cursor.questionId) || !validId(cursor.targetId)))
    throw new TypeError('Invalid rating segment cursor');
}

/** Read a bounded keyset page from the voter's partition without loading the member's full vote set. */
export async function readRatingSegmentVotes(client: Queryable, input: VotePageInput): Promise<StoredSegmentVote[]> {
  if (
    !Number.isSafeInteger(input.route) ||
    input.route < 0 ||
    input.route > 65535 ||
    routeOf(input.voterId) !== input.route ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > RATING_SEGMENT_PAGE_SIZE ||
    (input.direction !== 'adding' && input.direction !== 'removing' && input.direction !== 'rekey')
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
    countedTargetId: row.countedTargetId,
    units: row.units === null ? null : Number(row.units),
    revision: Number(row.revision),
    changedAt: row.changedAt,
  }));
}

/** Find the current transition without holding a voter connection while another partition is entered. */
export async function readRatingSegmentJob(
  pool: Pool,
  input: { voterId: string; realmId: string },
): Promise<RatingRealmSegmentJob | null> {
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

function populationsForJob(job: RatingSegmentJob): string[] {
  return isRatingEligibilityJob(job) || isRatingRekeyJob(job) ? job.populations : [job.realmId];
}

async function changePopulationPending(pool: Pool, job: RatingSegmentJob, populationId: string, start: boolean) {
  const route = routeOf(populationId);
  if (route === null) throw new TypeError('Invalid rating population address');
  const action = start ? 'rating.segment.pending.start' : 'rating.segment.pending.finish';
  const digest = createHash('sha256')
    .update(JSON.stringify([action, populationId, job.transitionId]))
    .digest();
  const outcome = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      receipt: {
        actorAccountId: job.voterId,
        kind: action,
        key: `${job.transitionId}:${populationId}`,
        digest,
      },
    },
    async (tx) => {
      const row = start
        ? await incrementPending.run(tx, { route, population_id: populationId })
        : await decrementPending.run(tx, { route, population_id: populationId });
      if (!row)
        throw new Error(
          start ? 'Could not start rating population job' : 'Rating population pending count would become negative',
        );
      return {
        value: null,
        events: [
          {
            type: POPULATION_PENDING,
            subject: populationId,
            data: { populationId, pendingJobs: Number(row.pending_jobs) },
          },
        ],
      };
    },
  );
  if (!outcome) throw new Error('Rating population partition is unavailable while updating its pending count');
}

/** Mark each affected population as updating once for this durable transition. */
export async function beginRatingPopulationJob(pool: Pool, job: RatingSegmentJob): Promise<void> {
  validateJob(job);
  for (const populationId of populationsForJob(job)) await changePopulationPending(pool, job, populationId, true);
}

/** Complete a Realm job once; replacement jobs are counted before the old transition is removed. */
export async function finishRatingPopulationJob(
  pool: Pool,
  job: RatingSegmentJob,
  nextJobs: readonly RatingSegmentJob[] = [],
): Promise<void> {
  for (const next of new Map(nextJobs.map((item) => [item.transitionId, item])).values())
    await beginRatingPopulationJob(pool, next);

  validateJob(job);
  for (const populationId of populationsForJob(job)) await changePopulationPending(pool, job, populationId, false);
}

/** Page in the voter home; production receipts replay the committed page until its aggregate delivery completes. */
export async function processRatingSegmentPage(
  pool: Pool,
  input: RatingSegmentJob & { after: SegmentCursor | null },
  ratingCounter?: RatingCounter,
): Promise<SegmentPageResult> {
  const { voterRoute } = validateJob(input);
  validateCursor(input.after);
  const data = (votes: SegmentVote[], allowMissing = true): SegmentPageEventData =>
    isRatingRekeyJob(input)
      ? { voterId: input.voterId, direction: 'rekey', at: input.at, allowMissing, votes }
      : { voterId: input.voterId, direction: input.direction, votes };
  const options = {
    partition: partitionOf(voterRoute),
    ...(ratingCounter
      ? {
          receipt: {
            actorAccountId: input.voterId,
            kind: 'rating.segment.page',
            key: `${input.transitionId}:${input.after?.questionId ?? ''}:${input.after?.targetId ?? ''}`,
            digest: createHash('sha256').update(canonicalize(input)!).digest(),
          },
        }
      : {}),
  };
  const producePage = async (
    tx: CommandTransaction,
    command: { transactionId: string; time: AuthoritativeTime },
  ): Promise<{ value: SegmentPageResult; events: CommandEvent[] }> => {
    if (isRatingEligibilityJob(input)) {
      const row = await readVoterState.run(tx, { route: voterRoute, voter_id: input.voterId });
      const activeState = input.direction === 'removing' ? 'leaving' : 'returning';
      const empty = data([]);
      if (!row || row.transitionId !== input.transitionId || row.state !== activeState)
        return {
          value: { cursor: input.after, done: true, eventData: empty, nextJobs: [] },
          events: [{ type: SEGMENT_PAGE, subject: input.voterId, data: empty }],
        };

      const cursor = cursorOf(row.cursorQuestionId, row.cursorTargetId);
      if (cursor !== null && input.after !== null && compare(cursor, input.after) < 0)
        throw new Error('Rating eligibility checkpoint is ahead of its voter cursor');
      if (cursor !== null && (input.after === null || compare(cursor, input.after) > 0))
        return {
          value: { cursor, done: false, eventData: empty, nextJobs: [] },
          events: [{ type: SEGMENT_PAGE, subject: input.voterId, data: empty }],
        };
      if (cursor === null && input.after !== null)
        throw new Error('Rating eligibility cursor was reset within one transition');

      const votes = await readRatingSegmentVotes(tx, {
        route: voterRoute,
        voterId: input.voterId,
        after: cursor,
        limit: RATING_SEGMENT_PAGE_SIZE,
        direction: input.direction,
        limitKey: null,
      });
      if (votes.length > 0) {
        const realms = await readCapped.run(tx, { route: voterRoute, voter_id: input.voterId });
        const mergeEvents: CommandEvent[] = [];
        const page: SegmentVote[] = [];
        const resolvedTargets = new Map<string, string>();
        for (const vote of votes) {
          if (input.direction === 'adding') {
            let resolvedTarget = resolvedTargets.get(vote.targetId);
            if (resolvedTarget === undefined) {
              resolvedTarget = await resolveSubjectTarget(tx, vote.targetId);
              resolvedTargets.set(vote.targetId, resolvedTarget);
            }
            if (resolvedTarget !== vote.targetId) {
              mergeEvents.push(
                ...(await reconcileMergedSubjectVote(tx, {
                  route: voterRoute,
                  voterId: input.voterId,
                  questionId: vote.questionId,
                  sourceTargetId: vote.targetId,
                  survivorId: resolvedTarget,
                  mode: 'return',
                })),
              );
              continue;
            }
          }
          page.push({
            ...vote,
            populations: [GLOBAL_CONTEXT.id, ...populationsForVoteKey(vote, realms)],
          });
        }
        const last = votes.at(-1)!;
        if (row.purgeVotes) {
          await deleteVotePage.run(tx, {
            route: voterRoute,
            voter_id: input.voterId,
            after_question_id: cursor?.questionId ?? null,
            after_target_id: cursor?.targetId ?? null,
            through_question_id: last.questionId,
            through_target_id: last.targetId,
          });
        }
        await updateVoterState.run(tx, {
          route: voterRoute,
          voter_id: input.voterId,
          state: row.state,
          cursor_question_id: last.questionId,
          cursor_target_id: last.targetId,
          transition_id: row.transitionId,
          purge_votes: row.purgeVotes,
          populations: input.populations,
        });
        const eventData = data(page);
        if (row.purgeVotes) {
          eventData.erasurePageId = command.transactionId;
          await recordErasurePage.run(tx, {
            route: voterRoute,
            voter_id: input.voterId,
            page_id: command.transactionId,
            terminal: false,
            had_votes: false,
          });
        }
        return {
          value: {
            cursor: { questionId: last.questionId, targetId: last.targetId },
            done: false,
            eventData,
            nextJobs: [],
          },
          events: [{ type: SEGMENT_PAGE, subject: input.voterId, data: eventData }, ...mergeEvents],
        };
      }

      if (row.purgeVotes) {
        const deleted = await deleteVoterRealms.run(tx, { route: voterRoute, voter_id: input.voterId });
        if (deleted.length === RATING_SEGMENT_PAGE_SIZE)
          return {
            value: { cursor, done: false, eventData: empty, nextJobs: [] },
            events: [{ type: SEGMENT_PAGE, subject: input.voterId, data: empty }],
          };
        await recordErasurePage.run(tx, {
          route: voterRoute,
          voter_id: input.voterId,
          page_id: row.transitionId,
          terminal: true,
          had_votes: row.cursorQuestionId !== null,
        });
      }
      await updateVoterState.run(tx, {
        route: voterRoute,
        voter_id: input.voterId,
        state: input.direction === 'removing' ? 'ineligible' : 'eligible',
        cursor_question_id: null,
        cursor_target_id: null,
        transition_id: row.transitionId,
        purge_votes: false,
        populations: [],
      });
      return {
        value: { cursor, done: true, eventData: empty, nextJobs: [] },
        events: [{ type: SEGMENT_PAGE, subject: input.voterId, data: empty }],
      };
    }

    if (isRatingRekeyJob(input)) {
      const votes = await readRatingSegmentVotes(tx, {
        route: voterRoute,
        voterId: input.voterId,
        after: input.after,
        limit: RATING_SEGMENT_PAGE_SIZE,
        direction: input.direction,
        limitKey: null,
      });
      if (votes.length === 0)
        return {
          value: { cursor: input.after, done: true, eventData: data([]), nextJobs: [] },
          events: [{ type: SEGMENT_PAGE, subject: input.voterId, data: data([]) }],
        };

      const eligibility = await readVoterState.run(tx, { route: voterRoute, voter_id: input.voterId });
      const allowMissing = !eligibility || eligibility.state === 'eligible' || eligibility.state === 'returning';
      const realms = allowMissing ? await readCapped.run(tx, { route: voterRoute, voter_id: input.voterId }) : [];
      const page = votes.map((vote) => ({
        ...vote,
        changedAt: vote.changedAt,
        populations: allowMissing ? [GLOBAL_CONTEXT.id, ...populationsForVoteKey(vote, realms)] : [],
      }));
      const last = votes.at(-1)!;
      const eventData = data(page, allowMissing);
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
      await ensureVoterState.run(tx, { route: voterRoute, voter_id: input.voterId });
      const eligibility = await readVoterState.run(tx, { route: voterRoute, voter_id: input.voterId });
      const allowAdding = eligibility?.state === 'eligible' || eligibility?.state === 'returning';
      const eventData = data(
        votes.map((vote) => ({
          ...vote,
          populations: input.direction === 'removing' || allowAdding ? [input.realmId] : [],
        })),
      );
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
  };
  const outcome = await runCommand(pool, options, async (tx, command) => {
    // A crash before foreground delivery replays the exact page and its native source position.
    const result = await producePage(tx, command);
    return { ...result, value: { ...result.value, eventTime: authoritativeTimeValue(command.time) } };
  });
  if (!outcome) throw new Error('Voter partition is unavailable while paging rating votes');
  if (ratingCounter) {
    await applyRatingSegmentPageEvent(pool, ratingCounter, {
      specversion: '1.0',
      id: outcome.transactionId,
      source: `urn:rezics:log:${outcome.partition}.${outcome.epoch}`,
      sequence: outcome.position.toString().padStart(19, '0'),
      type: SEGMENT_PAGE,
      subject: input.voterId,
      time: outcome.value.eventTime!,
      datacontenttype: 'application/json',
      data: outcome.value.eventData,
    });
  }
  return outcome.value;
}

/** Start the current row's durable workflow from its transition id, which prevents duplicate join events from forking jobs. */
export function createRatingSegmentJobEffect(pool: Pool, client: WorkContext['client']): Effect {
  return {
    name: 'rating_segment_job',
    types: [REALM_CHANGED, 'com.rezics.rating.eligibility.changed.v1', COUNTER_CHANGED],
    async run(event: CloudEvent) {
      let job: RatingSegmentJob | null;
      if (event.type === COUNTER_CHANGED && Value.Check(ACCESS_EVENTS[COUNTER_CHANGED], event.data)) {
        const { accountId, at } = event.data as { accountId: string; at: string };
        const voterRoute = routeOf(accountId);
        if (voterRoute === null || event.subject !== accountId) throw new TypeError('Invalid rating re-key event');
        const realms = await withConnection(pool, (connection) =>
          readCapped.run(connection, { route: voterRoute, voter_id: accountId }),
        );
        job = {
          voterId: accountId,
          direction: 'rekey',
          transitionId: event.id,
          at,
          populations: [GLOBAL_CONTEXT.id, ...realms.map(({ realmId }) => realmId)],
        };
      } else if (event.type === REALM_CHANGED && Value.Check(RATING_EVENTS[REALM_CHANGED], event.data)) {
        const { voterId, realmId } = event.data as { voterId: string; realmId: string };
        job = await readRatingSegmentJob(pool, { voterId, realmId });
      } else if (
        event.type === 'com.rezics.rating.eligibility.changed.v1' &&
        Value.Check(RATING_EVENTS['com.rezics.rating.eligibility.changed.v1'], event.data)
      ) {
        const { voterId } = event.data as { voterId: string };
        job = await readRatingEligibilityJob(pool, { voterId });
      } else throw new TypeError('Invalid rating segment transition event');
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
    .update(
      JSON.stringify([
        job.voterId,
        isRatingEligibilityJob(job) ? 'eligibility' : isRatingRekeyJob(job) ? 'rekey' : job.realmId,
        job.transitionId,
      ]),
    )
    .digest('hex');
  return `rating.segment:${key}`;
}

/** Register page and finish steps plus the membership-change starter effect. */
export function registerRatingSegmentWork(context: WorkContext, ratingCounter?: RatingCounter): void {
  const processPage = DBOS.registerStep(
    async (job: RatingSegmentJob, after: SegmentCursor | null) =>
      processRatingSegmentPage(context.pool, { ...job, after }, ratingCounter),
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
