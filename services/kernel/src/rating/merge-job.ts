import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { runCommand, type CommandEvent, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { identityEpochStore } from '../semantic/identity-epoch-store.ts';
import type { IdentityEpochState } from '../semantic/identity-epoch-contract.ts';
import { SEMANTIC_EVENTS, SUBJECT_MERGED } from '../semantic/events.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { readVotePopulations } from './voter-realms.ts';
import { readPopulationVoters } from './aggregate-effect.ts';
import voteLock from './vote-lock.sql';
import voteCountedTargetLock from './vote-counted-target-lock.sql';
import voteCountedTargetSet from './vote-counted-target-set.sql';
import resolveTarget from './subject-resolve-target.sql';

export const RATING_SUBJECT_MERGE_WORKFLOW = 'rating.subjectMerge';
export const RATING_SUBJECT_MERGE_PAGE_SIZE = 100;
const VOTE_CHANGED = 'com.rezics.rating.vote.changed.v1';
const PAGE_COMPLETED = 'com.rezics.rating.subject-merge.page.v1';

export type RatingMergeCursor = { questionId: string; voterId: string };
export type RatingSubjectMergeJob = { id: string; survivor: string };
export type RatingSubjectMergePage = {
  cursor: RatingMergeCursor | null;
  done: boolean;
  voters: number;
};

export class RatingSubjectTargetPendingError extends Error {
  readonly code: 'identity_epoch_pending' | 'identity_epoch_unavailable';
  readonly targetId: string;

  constructor(code: 'identity_epoch_pending' | 'identity_epoch_unavailable', targetId: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'RatingSubjectTargetPendingError';
    this.code = code;
    this.targetId = targetId;
  }
}

export type RatingIdentityEpochReader = (tx: CommandTransaction, partition: number) => Promise<IdentityEpochState>;
type MergeMode = 'merge' | 'return';

function validId(value: string): boolean {
  return routeOf(value) !== null;
}

function validateJob(job: RatingSubjectMergeJob): void {
  if (!job || !validId(job.id) || !validId(job.survivor) || job.id === job.survivor)
    throw new TypeError('Invalid rating subject merge job');
}

function validateCursor(cursor: RatingMergeCursor | null): void {
  if (cursor !== null && (!validId(cursor.questionId) || !validId(cursor.voterId)))
    throw new TypeError('Invalid rating subject merge cursor');
}

function voteEvent(input: {
  voterId: string;
  questionId: string;
  sourceTargetId: string;
  aggregateTargetId: string;
  previous: number | null;
  units: number | null;
  revision: number;
  populations: string[];
}): CommandEvent {
  return {
    type: VOTE_CHANGED,
    subject: input.voterId,
    data: {
      voterId: input.voterId,
      questionId: input.questionId,
      targetId: input.sourceTargetId,
      ...(input.sourceTargetId === input.aggregateTargetId ? {} : { aggregateTargetId: input.aggregateTargetId }),
      previous: input.previous,
      units: input.units,
      revision: input.revision,
      populations: input.populations,
    },
  };
}

function newerVote(
  candidate: { changedAt: string | null; targetId: string },
  current: { changedAt: string | null; targetId: string },
) {
  if (candidate.changedAt === null || current.changedAt === null) throw new Error('Rating vote has no change time');
  // Equal command times are resolved by target id so multiple source merges converge in either order.
  return (
    candidate.changedAt > current.changedAt ||
    (candidate.changedAt === current.changedAt && candidate.targetId < current.targetId)
  );
}

/** Reconcile one source vote with a subject's current survivor vote in its voter's partition. */
export async function reconcileMergedSubjectVote(
  tx: CommandTransaction,
  input: {
    route: number;
    voterId: string;
    questionId: string;
    sourceTargetId: string;
    survivorId: string;
    mode: MergeMode;
  },
): Promise<CommandEvent[]> {
  const key = { route: input.route, voter_id: input.voterId, question_id: input.questionId };
  const source =
    input.mode === 'merge'
      ? await voteCountedTargetLock.run(tx, { ...key, counted_target: input.sourceTargetId })
      : await voteLock.run(tx, { ...key, target_id: input.sourceTargetId });
  if (!source) return [];
  const sourceTargetId = source.targetId as string;
  const sourceCountedTarget = source.countedTarget as string | null;
  if (input.mode === 'merge' && sourceCountedTarget !== input.sourceTargetId) return [];

  const survivorVote = await voteLock.run(tx, { ...key, target_id: input.survivorId });
  const currentCounted = await voteCountedTargetLock.run(tx, { ...key, counted_target: input.survivorId });
  const sourceRevision = Number(source.countedRevision);
  const sourcePopulations = await readVotePopulations(tx, {
    route: input.route,
    voterId: input.voterId,
    questionId: input.questionId,
    targetId: sourceTargetId,
    includeLeaving: input.mode === 'merge',
  });

  const clearSource = async (revision: number): Promise<void> => {
    const cleared = await voteCountedTargetSet.run(tx, {
      ...key,
      target_id: sourceTargetId,
      expected_counted_target: sourceCountedTarget,
      counted_target: null,
      counted_revision: revision,
    });
    if (!cleared) throw new Error('Rating vote count changed while its row was locked');
  };

  if (survivorVote) {
    if (input.mode === 'merge' && sourceCountedTarget === input.sourceTargetId) {
      const revision = sourceRevision + 1;
      await clearSource(revision);
      return [
        voteEvent({
          voterId: input.voterId,
          questionId: input.questionId,
          sourceTargetId,
          aggregateTargetId: input.sourceTargetId,
          previous: source.units === null ? null : Number(source.units),
          units: null,
          revision,
          populations: sourcePopulations,
        }),
      ];
    }
    if (sourceCountedTarget !== null) await clearSource(sourceRevision + 1);
    return [];
  }

  const sourceIsCurrent = currentCounted?.targetId === sourceTargetId;
  const candidateWins = !currentCounted || sourceIsCurrent || newerVote(source, currentCounted);
  if (!candidateWins) {
    if (sourceCountedTarget !== null && !sourceIsCurrent) {
      const revision = sourceRevision + 1;
      await clearSource(revision);
      if (input.mode === 'merge')
        return [
          voteEvent({
            voterId: input.voterId,
            questionId: input.questionId,
            sourceTargetId,
            aggregateTargetId: input.sourceTargetId,
            previous: source.units === null ? null : Number(source.units),
            units: null,
            revision,
            populations: sourcePopulations,
          }),
        ];
    }
    return [];
  }

  if (input.mode === 'merge' && sourceCountedTarget !== input.sourceTargetId) return [];

  const events: CommandEvent[] = [];
  let destinationRevision: number;
  if (currentCounted && !sourceIsCurrent) {
    const currentRevision = Number(currentCounted.countedRevision);
    const removalRevision = currentRevision + 1;
    const oldPopulations = await readVotePopulations(tx, {
      route: input.route,
      voterId: input.voterId,
      questionId: input.questionId,
      targetId: currentCounted.targetId,
      includeLeaving: input.mode === 'merge',
    });
    const cleared = await voteCountedTargetSet.run(tx, {
      ...key,
      target_id: currentCounted.targetId,
      expected_counted_target: input.survivorId,
      counted_target: null,
      counted_revision: removalRevision,
    });
    if (!cleared) throw new Error('Current rating vote changed while its row was locked');
    events.push(
      voteEvent({
        voterId: input.voterId,
        questionId: input.questionId,
        sourceTargetId: currentCounted.targetId,
        aggregateTargetId: input.survivorId,
        previous: currentCounted.units === null ? null : Number(currentCounted.units),
        units: null,
        revision: removalRevision,
        populations: oldPopulations,
      }),
    );
    const oldRevision = Math.max(currentRevision, sourceRevision);
    destinationRevision = oldRevision + 2;
  } else if (sourceIsCurrent) {
    destinationRevision = sourceRevision + 1;
  } else destinationRevision = sourceRevision + 1;

  const set = await voteCountedTargetSet.run(tx, {
    ...key,
    target_id: sourceTargetId,
    expected_counted_target: sourceCountedTarget,
    counted_target: input.survivorId,
    counted_revision: destinationRevision,
  });
  if (!set) throw new Error('Merged rating vote changed while its row was locked');

  if (input.mode === 'merge') {
    const sourceRemovalRevision = sourceRevision + 1;
    if (sourceCountedTarget === input.sourceTargetId) {
      events.push(
        voteEvent({
          voterId: input.voterId,
          questionId: input.questionId,
          sourceTargetId,
          aggregateTargetId: input.sourceTargetId,
          previous: source.units === null ? null : Number(source.units),
          units: null,
          revision: sourceRemovalRevision,
          populations: sourcePopulations,
        }),
      );
    }
  }

  const newPopulations = sourcePopulations;
  events.push(
    voteEvent({
      voterId: input.voterId,
      questionId: input.questionId,
      sourceTargetId,
      aggregateTargetId: input.survivorId,
      previous: null,
      units: source.units === null ? null : Number(source.units),
      revision: destinationRevision,
      populations: newPopulations,
    }),
  );
  return events;
}

export async function resolveSubjectTarget(
  client: CommandTransaction,
  targetId: string,
  readEpoch: RatingIdentityEpochReader = (tx, partition) => identityEpochStore.readEpoch(tx, partition),
): Promise<string> {
  if (!validId(targetId)) throw new TypeError('Invalid rating vote target');
  const [row] = await resolveTarget.run(client, { subject_id: targetId });
  if (!row || typeof row.subjectId !== 'string')
    throw new RatingSubjectTargetPendingError(
      'identity_epoch_unavailable',
      targetId,
      'Semantic direct redirect lookup is unavailable',
    );
  if (row.targetRedirecting || !row.activeTerminal)
    throw new RatingSubjectTargetPendingError(
      'identity_epoch_pending',
      targetId,
      row.targetRedirecting ? 'The direct redirect target is not terminal' : 'The direct redirect target is not active',
    );

  const targetRoute = routeOf(targetId);
  const terminalRoute = routeOf(row.subjectId);
  if (targetRoute === null || terminalRoute === null)
    throw new RatingSubjectTargetPendingError('identity_epoch_unavailable', targetId, 'A route is unavailable');
  // This runs inside the voter command's serializable transaction. Pass native subject homes explicitly;
  // Semantic's default partition zero is topology compatibility, not currentness for these identities.
  const homes = [...new Set([partitionOf(targetRoute), partitionOf(terminalRoute)])].sort(
    (left, right) => left - right,
  );
  for (const home of homes) {
    const state = await readEpoch(client, home);
    if (state.state === 'pending')
      throw new RatingSubjectTargetPendingError(
        'identity_epoch_pending',
        targetId,
        `Semantic identity epoch ${state.job.jobId}@${state.job.epoch} is pending at home ${home}`,
      );
    if (state.state === 'unavailable')
      throw new RatingSubjectTargetPendingError(
        'identity_epoch_unavailable',
        targetId,
        `Semantic identity currentness is unavailable at home ${home} (${state.reason})`,
      );
  }
  return row.subjectId;
}

async function processVoterPartition(
  pool: Pool,
  job: RatingSubjectMergeJob,
  after: RatingMergeCursor | null,
  partition: number,
  voters: Array<{ questionId: string; voterId: string; units: number | null; revision: number; at: string }>,
): Promise<void> {
  const key = `${job.id}:${after?.questionId ?? 'start'}:${after?.voterId ?? 'start'}:${partition}`;
  const digest = createHash('sha256')
    .update(JSON.stringify([job.id, job.survivor, after, partition]))
    .digest();
  const outcome = await runCommand(
    pool,
    {
      partition,
      receipt: {
        actorAccountId: job.id,
        kind: 'rating.subject-merge.page',
        key,
        digest,
      },
    },
    async (tx) => {
      const events: CommandEvent[] = [];
      for (const voter of voters) {
        events.push(
          ...(await reconcileMergedSubjectVote(tx, {
            route: routeOf(voter.voterId)!,
            voterId: voter.voterId,
            questionId: voter.questionId,
            sourceTargetId: job.id,
            survivorId: job.survivor,
            mode: 'merge',
          })),
        );
      }
      events.push({
        type: PAGE_COMPLETED,
        subject: job.id,
        data: { id: job.id, survivor: job.survivor, voters: new Set(voters.map(({ voterId }) => voterId)).size },
      });
      return { value: null, events };
    },
  );
  if (!outcome) throw new Error('Rating subject merge voter partition is unavailable');
}

/** Read a keyset page of at most 100 Global voters, then reconcile it in voter-partition commands. */
export async function processRatingSubjectMergePage(
  pool: Pool,
  input: RatingSubjectMergeJob & { after: RatingMergeCursor | null },
): Promise<RatingSubjectMergePage> {
  validateJob(input);
  validateCursor(input.after);
  const rows = await withConnection(pool, (client) =>
    readPopulationVoters(client, {
      populationId: GLOBAL_CONTEXT.id,
      targetId: input.id,
      after: input.after,
      limit: RATING_SUBJECT_MERGE_PAGE_SIZE,
    }),
  );
  const voterIds = [...new Set(rows.map(({ voterId }) => voterId))];
  const last = rows.at(-1);
  const cursor = last ? { questionId: last.questionId, voterId: last.voterId } : input.after;
  const groups = new Map<number, typeof rows>();
  for (const row of rows) {
    const route = routeOf(row.voterId);
    if (route === null) throw new Error('Rating population voter has an invalid route');
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push(row);
    groups.set(partition, group);
  }
  await Promise.all(
    [...groups].map(([partition, voters]) => processVoterPartition(pool, input, input.after, partition, voters)),
  );
  return { cursor, done: voterIds.length < RATING_SUBJECT_MERGE_PAGE_SIZE, voters: voterIds.length };
}

export function ratingSubjectMergeWorkflowId(subjectId: string): string {
  if (!validId(subjectId)) throw new TypeError('Invalid rating subject merge id');
  return `rating.subjectMerge:${subjectId}`;
}

export function createRatingSubjectMergeJobEffect(pool: Pool, context: WorkContext['client']): Effect {
  return {
    name: 'rating_subject_merge_job',
    types: [SUBJECT_MERGED],
    async run(event: CloudEvent) {
      if (event.type !== SUBJECT_MERGED || !Value.Check(SEMANTIC_EVENTS[SUBJECT_MERGED], event.data))
        throw new TypeError('Invalid subject merge event');
      const job = event.data as RatingSubjectMergeJob;
      if (event.subject !== job.id) throw new TypeError('Rating subject merge event subject mismatch');
      validateJob(job);
      await context.enqueue(
        {
          workflowName: RATING_SUBJECT_MERGE_WORKFLOW,
          workflowID: ratingSubjectMergeWorkflowId(job.id),
          workflowIDReusePolicy: 'return-existing',
          queueName: 'workflows',
          queuePartitionKey: String(partitionOf(routeOf(job.id)!)),
        },
        job,
      );
    },
  };
}

export function registerRatingSubjectMergeWork(context: WorkContext): void {
  const processPage = DBOS.registerStep(
    async (job: RatingSubjectMergeJob, after: RatingMergeCursor | null) =>
      processRatingSubjectMergePage(context.pool, { ...job, after }),
    { name: 'rating.processSubjectMergePage', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (job: RatingSubjectMergeJob) => {
      let after: RatingMergeCursor | null = null;
      for (;;) {
        const result = await processPage(job, after);
        if (result.done) return;
        if (
          !result.cursor ||
          (after?.voterId === result.cursor.voterId && after.questionId === result.cursor.questionId)
        )
          throw new Error('Rating subject merge page did not advance its cursor');
        after = result.cursor;
      }
    },
    { name: RATING_SUBJECT_MERGE_WORKFLOW },
  );
  context.addEffects([createRatingSubjectMergeJobEffect(context.pool, context.client)]);
}
