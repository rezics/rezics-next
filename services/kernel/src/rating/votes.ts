import type { Pool, PoolClient } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount } from '../access/account-data.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, commandAttemptDeadline, type CommandEvent } from '../command/command.ts';
import type { SessionComponent } from '../tokens/session.ts';
import { withConnection } from '../database/pool.ts';
import { LibraryNotFoundError, createLibraryCommandRunner, requireRoute } from '../library/command-support.ts';
import { resolveSubject } from '../library/subject-anchor.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { deadlineFor } from '../request/deadline.ts';
import { readVisibleRatingQuestion } from './question-directory.ts';
import {
  ratingQuestionHistogramIndex,
  ratingQuestionHistogramSize,
  type RatingQuestionScale,
} from './question-scale.ts';
import { readVotePopulations } from './voter-realms.ts';
import { produceIdentityRatingVoteChange } from '../semantic/identity-rating-producer.ts';
import {
  admitIdentityRatingEffect,
  IdentityRatingAdmissionPendingError,
  readIdentityRatingEpochs,
  compareIdentityRatingEpochs,
} from '../semantic/identity-rating-admission.ts';
import {
  normalizeVoteReviewGuard,
  ownVoteReviewWitness,
  readVoteReviewSlots,
  VoteReviewStaleError,
  VoteReviewUnavailableError,
  type VoteReviewGuard,
  type VoteReviewRow,
  type VoteReviewEpoch,
} from './own-votes-review.ts';
import { STANDARD_QUESTION_ID } from './standard-question.ts';
export { STANDARD_QUESTION_ID } from './standard-question.ts';
export { VoteReviewStaleError, VoteReviewUnavailableError } from './own-votes-review.ts';
export type { VoteReviewGuard } from './own-votes-review.ts';
import questionRead from './question-read.sql';
import voteInsert from './vote-insert.sql';
import voteLock from './vote-lock.sql';
import voteCountedTargetLock from './vote-counted-target-lock.sql';
import voteCountedTargetSet from './vote-counted-target-set.sql';
import voteRead from './vote-read.sql';
import voteUpdate from './vote-update.sql';

import {
  assertVoteObservation,
  parseVoteObservation,
  requireVoteObservationProvider,
  type VoteObservation,
} from './vote-observation.ts';

export const VOTE_SCOPE = 'rating:vote';

export type RatingQuestion = RatingQuestionScale & {
  id: string;
  ownerId: string | null;
  realmId: string | null;
  meaning: string | null;
  revision: number;
  label: string;
  grain: 'work' | 'release' | 'episode' | 'character';
  lifecycleState: 'active' | 'retired';
  lifecycleRevision: number;
};

export type Vote = {
  voterId: string;
  questionId: string;
  targetId: string;
  units: number | null;
  revision: number;
  changedAt: string;
  transactionId: string;
};

export type PutVoteInput = {
  questionId: string;
  targetId: string;
  units: number | null;
  guard?: VoteReviewGuard;
  observation?: VoteObservation;
};
export type PutVoteOutcome = {
  vote: Vote | null;
  component: SessionComponent | null;
};

export class VoteInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid rating vote field: ${field}`);
    this.name = 'VoteInvalidError';
  }
}

export class RatingQuestionNotFoundError extends Error {
  constructor() {
    super('Rating question not found');
    this.name = 'RatingQuestionNotFoundError';
  }
}

export class RatingQuestionRetiredError extends Error {
  readonly reason = 'retired' as const;
  constructor() {
    super('Rating question is retired');
    this.name = 'RatingQuestionRetiredError';
  }
}

type Dependencies = { pool: Pool; access: Access; clock?: KernelClock };
type Queryable = Pick<Pool | PoolClient, 'query'>;
type QuestionRow = NonNullable<Awaited<ReturnType<typeof questionRead.run>>>;
type VoteRow = NonNullable<Awaited<ReturnType<typeof voteRead.run>>>;

function account(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null) throw new GrantDeniedError();
  return actor;
}

function voteAccount(actor: Actor): AccountActor {
  const owner = account(actor);
  if (!owner.scopes.includes(VOTE_SCOPE)) throw new GrantDeniedError();
  return owner;
}

function asQuestion(row: QuestionRow): RatingQuestion {
  if (row.grain !== 'work' && row.grain !== 'release' && row.grain !== 'episode' && row.grain !== 'character')
    throw new Error(`Unknown rating grain: ${row.grain}`);
  if (row.lifecycleState !== 'active' && row.lifecycleState !== 'retired')
    throw new Error(`Unknown rating question lifecycle state: ${row.lifecycleState}`);
  return {
    ...row,
    grain: row.grain,
    revision: Number(row.revision),
    minimumUnits: Number(row.minimumUnits),
    maximumUnits: Number(row.maximumUnits),
    stepUnits: Number(row.stepUnits),
    lifecycleState: row.lifecycleState,
    lifecycleRevision: Number(row.lifecycleRevision),
  };
}

function asVote(row: VoteRow): Vote {
  if (row.changedAt === null) throw new Error('Rating vote has no change time');
  return {
    voterId: row.voterId,
    questionId: row.questionId,
    targetId: row.targetId,
    units: row.units === null ? null : Number(row.units),
    revision: Number(row.revision),
    changedAt: new Date(row.changedAt).toISOString(),
    transactionId: row.transactionId,
  };
}

function asReviewRow(row: VoteRow | null): VoteReviewRow | null {
  return row
    ? {
        targetId: row.targetId,
        units: row.units === null ? null : Number(row.units),
        revision: Number(row.revision),
        countedRevision: Number(row.countedRevision),
        countedTarget: row.countedTarget,
        changedAt: row.changedAt!,
        transactionId: row.transactionId,
      }
    : null;
}

function changedVoteEvent(input: {
  voterId: string;
  questionId: string;
  sourceTargetId: string;
  aggregateTargetId: string;
  previous: number | null;
  units: number | null;
  revision: number;
  populations: string[];
}) {
  return produceIdentityRatingVoteChange({
    authenticatedVoterId: input.voterId,
    questionId: input.questionId,
    sourceTargetId: input.sourceTargetId,
    aggregateTargetId: input.aggregateTargetId,
    previous: input.previous,
    units: input.units,
    revision: input.revision,
    populations: input.populations,
  });
}

function queryClient(client: Queryable): Queryable {
  return { query: client.query.bind(client) };
}

async function findQuestion(
  config: Dependencies,
  actor: Actor,
  questionId: string,
  deadline = deadlineFor(5_000),
): Promise<RatingQuestion> {
  const row = await readVisibleRatingQuestion(config, actor, questionId, deadline, false);
  if (!row) throw new RatingQuestionNotFoundError();
  return asQuestion(row);
}

/** Shared native command preparation for a selected exact slot. Advice retains no authorization. */
export async function prepareVoteTarget(
  config: Dependencies,
  actor: Actor,
  input: { questionId: string; targetId: string; units?: number | null },
  deadline: number,
) {
  voteAccount(actor);
  const question = await findQuestion(config, actor, input.questionId, deadline);
  if (input.units !== undefined) {
    if (input.units !== null && question.lifecycleState === 'retired') throw new RatingQuestionRetiredError();
    validateUnits(question, input.units);
  }
  const target = await resolveSubject(config, actor, input.targetId, undefined, { pool: config.pool, deadline });
  if (!target) throw new LibraryNotFoundError();
  return { question, target };
}

function validateUnits(question: RatingQuestion, units: number | null): void {
  ratingQuestionHistogramSize(question);
  if (units === null) return;
  try {
    ratingQuestionHistogramIndex(question, units);
  } catch {
    throw new VoteInvalidError('units');
  }
}

function assertCurrentAccount(owner: AccountActor, current: Awaited<ReturnType<typeof readAccount>>): void {
  if (
    !current ||
    current.kind !== 'actor' ||
    current.state !== 'active' ||
    current.fenced ||
    !Number.isSafeInteger(owner.authnEpoch) ||
    owner.authnEpoch < 1 ||
    current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
  )
    throw new GrantDeniedError();
}

class VoteUnchanged extends Error {
  constructor(readonly vote: Vote | null) {
    super('Vote is unchanged');
    this.name = 'VoteUnchanged';
  }
}

/** Writes and reads the signed-in person's current rating vote on the account's partition. */
export function createVoteCommands(config: Dependencies) {
  const { pool, clock } = config;
  const runner = createLibraryCommandRunner({
    pool,
    ...(clock === undefined ? {} : { clock }),
  });
  const guardedRunner = createLibraryCommandRunner({
    pool,
    access: config.access,
    ...(clock === undefined ? {} : { clock }),
  });

  async function putVoteOutcome(actor: Actor, input: PutVoteInput, idempotencyKey: string): Promise<PutVoteOutcome> {
    const owner = voteAccount(actor);
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.questionId !== 'string' ||
      typeof input.targetId !== 'string'
    )
      throw new VoteInvalidError('vote');
    if (input.units !== null && typeof input.units !== 'number') throw new VoteInvalidError('units');

    let observation: VoteObservation | undefined;
    if (input.observation !== undefined) {
      try {
        observation = parseVoteObservation(JSON.stringify(input.observation));
      } catch {
        throw new VoteInvalidError('observation');
      }
      requireVoteObservationProvider(input.questionId);
    }
    let guard: VoteReviewGuard | undefined;
    if (input.guard !== undefined) {
      try {
        guard = normalizeVoteReviewGuard(input.guard, input.targetId);
      } catch {
        throw new VoteInvalidError('guard');
      }
    }
    input = {
      questionId: input.questionId,
      targetId: input.targetId,
      units: input.units,
      ...(guard ? { guard } : {}),
      ...(observation ? { observation } : {}),
    };
    const initial = guard ? null : await prepareVoteTarget(config, actor, input, deadlineFor(5_000));

    try {
      const outcome = await (guard ? guardedRunner : runner).ownAccountPrepared(
        actor,
        {
          action: VOTE_SCOPE,
          kind: 'rating.vote.put',
          requestKey: idempotencyKey,
          input: {
            questionId: input.questionId,
            targetId: input.targetId,
            units: input.units,
            ...(guard ? { guard } : {}),
            ...(observation ? { observation } : {}),
          },
          // Current question provenance is checked again on each native attempt,
          // before ownAccountPrepared permits receipt disclosure or execution.
          prepare: async (attempt) => {
            const deadline = commandAttemptDeadline(attempt);
            // Current disclosure precedes replay; business review/scale/lifecycle evidence is deferred.
            const current = await prepareVoteTarget(
              config,
              actor,
              guard ? { questionId: input.questionId, targetId: input.targetId } : input,
              deadline,
            );
            if (observation) assertVoteObservation(observation, current.question, current.target.subjectId);
            if (initial && current.target.subjectId !== initial.target.subjectId)
              throw new IdentityRatingAdmissionPendingError(input.targetId, 'source-pending');
            let epochs: readonly VoteReviewEpoch[] = [];
            let error: VoteReviewUnavailableError | null = null;
            if (guard) {
              try {
                epochs = await readIdentityRatingEpochs(
                  pool,
                  [input.targetId, current.target.subjectId].map((id) => partitionOf(requireRoute(id))),
                  deadline,
                );
              } catch (failure) {
                if (!(failure instanceof VoteReviewUnavailableError)) throw failure;
                error = failure;
              }
            }
            return { ...current, epochs, error };
          },
        },
        async (tx, command, prepared) => {
          const { question, target: resolved } = observation ? prepared : (initial ?? prepared);
          if (observation) assertVoteObservation(observation, question, resolved.subjectId);
          if (guard) {
            if (
              question.revision !== guard.question.revision ||
              question.lifecycleRevision !== guard.question.lifecycleRevision
            )
              throw new VoteReviewStaleError('question_changed');
            if (resolved.subjectId !== guard.subject.canonicalId) throw new VoteReviewStaleError('subject_changed');
            if (prepared.error) throw prepared.error;
            compareIdentityRatingEpochs(guard.subject.epochs, prepared.epochs);
          }
          const route = requireRoute(owner.accountId);
          const previousRow = await voteLock.run(queryClient(tx), {
            route,
            voter_id: owner.accountId,
            question_id: question.id,
            target_id: resolved.subjectId,
          });
          const countedRow = await voteCountedTargetLock.run(queryClient(tx), {
            route,
            voter_id: owner.accountId,
            question_id: question.id,
            counted_target: resolved.subjectId,
          });
          if (guard) {
            const slots = await readVoteReviewSlots(tx, {
              ownerId: owner.accountId,
              questionId: question.id,
              targetIds: [input.targetId, resolved.subjectId],
            });
            const current = ownVoteReviewWitness({
              ownerId: owner.accountId,
              questionId: question.id,
              requestedTargetId: input.targetId,
              canonicalId: resolved.subjectId,
              original: slots.find((slot) => slot.targetId === input.targetId)!.vote,
              canonical: slots.find((slot) => slot.targetId === resolved.subjectId)!.vote,
              effective: asReviewRow(countedRow),
            });
            if (current.state !== guard.ownVote.state || current.observation !== guard.ownVote.observation)
              throw new VoteReviewStaleError('own_vote_changed');
            if (input.units !== null && question.lifecycleState === 'retired') throw new RatingQuestionRetiredError();
            validateUnits(question, input.units);
            // The native question lifecycle writer locks only its question home, and identity
            // publication has no released participant hold for this voter command. Account/shelf
            // admission and local vote locks cannot fence either foreign authority through commit.
            throw new VoteReviewUnavailableError('atomic_guard_unavailable');
          }
          const previous = previousRow ? asVote(previousRow) : null;
          const isAlreadyCurrent = previousRow?.countedTarget === resolved.subjectId;
          if (
            (!previous && !countedRow && input.units === null) ||
            (isAlreadyCurrent && previous?.units === input.units)
          )
            throw new VoteUnchanged(previous);

          const admission = await admitIdentityRatingEffect(tx, {
            requestedTargetId: input.targetId,
            resolvedTargetId: resolved.subjectId,
          });
          if (admission.status === 'pending')
            throw new IdentityRatingAdmissionPendingError(input.targetId, admission.reason);

          const time = authoritativeTimeValue(command.time);
          let nextRow: Awaited<ReturnType<typeof voteRead.run>>;
          const events: CommandEvent[] = [];
          let countedRevision = Number(previousRow?.countedRevision ?? 0) + 1;

          if (countedRow && countedRow.targetId !== resolved.subjectId) {
            const priorCountedRevision = Number(countedRow.countedRevision);
            const baseRevision = Math.max(priorCountedRevision, Number(previousRow?.countedRevision ?? 0));
            const removalRevision = baseRevision + 1;
            const nextCountedRevision = baseRevision + 2;
            const previousPopulations = await readVotePopulations(tx, {
              route,
              voterId: owner.accountId,
              questionId: question.id,
              targetId: countedRow.targetId,
            });
            const cleared = await voteCountedTargetSet.run(queryClient(tx), {
              route,
              voter_id: owner.accountId,
              question_id: question.id,
              target_id: countedRow.targetId,
              expected_counted_target: resolved.subjectId,
              counted_target: null,
              counted_revision: removalRevision,
            });
            if (!cleared) throw new Error('Rating vote count changed while its row was locked');
            events.push(
              changedVoteEvent({
                voterId: owner.accountId,
                questionId: question.id,
                sourceTargetId: countedRow.targetId,
                aggregateTargetId: resolved.subjectId,
                previous: countedRow.units === null ? null : Number(countedRow.units),
                units: null,
                revision: removalRevision,
                populations: previousPopulations,
              }),
            );
            countedRevision = nextCountedRevision;
          } else if (countedRow) countedRevision = Number(countedRow.countedRevision) + 1;

          if (previousRow) {
            nextRow = await voteUpdate.run(queryClient(tx), {
              route,
              voter_id: owner.accountId,
              question_id: question.id,
              target_id: resolved.subjectId,
              revision: previousRow.revision,
              counted_target: resolved.subjectId,
              counted_revision: countedRevision,
              units: input.units,
              changed_at: time,
              transaction_id: command.transactionId,
            });
          } else {
            nextRow = await voteInsert.run(queryClient(tx), {
              route,
              voter_id: owner.accountId,
              question_id: question.id,
              target_id: resolved.subjectId,
              counted_target: resolved.subjectId,
              counted_revision: countedRevision,
              units: input.units,
              changed_at: time,
              transaction_id: command.transactionId,
            });
          }
          if (!nextRow) throw new Error('Rating vote changed while its row was locked');
          const vote = asVote(nextRow);
          const populations = await readVotePopulations(tx, {
            route,
            voterId: owner.accountId,
            questionId: question.id,
            targetId: resolved.subjectId,
          });
          events.push(
            changedVoteEvent({
              voterId: owner.accountId,
              questionId: question.id,
              sourceTargetId: resolved.subjectId,
              aggregateTargetId: resolved.subjectId,
              previous: countedRow && countedRow.targetId !== resolved.subjectId ? null : (previous?.units ?? null),
              units: vote.units,
              revision: countedRevision,
              populations,
            }),
          );
          return {
            value: vote,
            events,
          };
        },
      );
      return {
        vote: outcome.value,
        component: {
          partition: outcome.partition,
          epoch: outcome.epoch,
          position: outcome.position,
        },
      };
    } catch (error) {
      if (error instanceof VoteUnchanged) return { vote: error.vote, component: null };
      throw error;
    }
  }

  async function putVote(actor: Actor, input: PutVoteInput, idempotencyKey: string): Promise<Vote | null> {
    return (await putVoteOutcome(actor, input, idempotencyKey)).vote;
  }

  async function readOwnVote(actor: Actor, questionId: string, targetId: string): Promise<Vote | null> {
    const owner = voteAccount(actor);
    if (routeOf(questionId) === null || routeOf(targetId) === null) return null;
    await findQuestion(config, actor, questionId);
    if (!(await resolveSubject(config, actor, targetId))) return null;
    const route = requireRoute(owner.accountId);
    return withConnection(pool, async (client) => {
      const current = await readAccount(client, route, owner.accountId);
      assertCurrentAccount(owner, current);
      const row = await voteRead.run(client, {
        route,
        voter_id: owner.accountId,
        question_id: questionId,
        target_id: targetId,
      });
      return row ? asVote(row) : null;
    });
  }

  async function readRatingQuestion(actor: Actor, questionId: string): Promise<RatingQuestion> {
    const owner = voteAccount(actor);
    await withConnection(pool, async (client) => {
      assertCurrentAccount(owner, await readAccount(client, requireRoute(owner.accountId), owner.accountId));
    });
    return findQuestion(config, actor, questionId);
  }

  return { putVote, putVoteOutcome, readOwnVote, readRatingQuestion };
}
