import type { RatingCapabilities } from './contract/capabilities.ts';
import { ratingCapabilities } from './adapters/ambient.ts';
import type { Pool, PoolClient } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount } from '../access/account-data.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, commandAttemptDeadline, type CommandEvent } from '../command/command.ts';
import type { SessionComponent } from '../tokens/session.ts';
import { withConnection } from '../database/pool.ts';
import type {
  IdentityRatingCommitPreparation,
  IdentityRatingCommitParticipant as CommitParticipant,
} from '../semantic/contract/index.ts';
import type { CommandTransaction } from '../command/command.ts';
import { ratingVoteSemantic, type RatingVoteSemantic } from './adapters/vote-semantic.ts';
type IdentityRatingCommitParticipant = CommitParticipant<CommandTransaction>;
import {
  LibraryNotFoundError,
  createLibraryCommandRunner,
  libraryCommandReceiptDigestForActor,
  requireRoute,
} from '../library/command-support.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { deadlineFor } from '../request/deadline.ts';
import { readVisibleRatingQuestion } from './question-directory.ts';
import { createOwnCountedVoteReader, type OwnCountedVoteObservation } from './own-votes-counted.ts';
import {
  ratingQuestionHistogramIndex,
  ratingQuestionHistogramSize,
  type RatingQuestionScale,
} from './question-scale.ts';
import { readVotePopulations } from './voter-realms.ts';
import { produceIdentityRatingVoteChange } from './vote-event.ts';
import { IdentityRatingAdmissionPendingError, compareVoteIdentityEpochs } from './vote-admission.ts';
import {
  normalizeVoteReviewGuard,
  ownVoteReviewWitness,
  readVoteReviewSlots,
  VOTE_SCOPE,
  VoteInvalidError,
  VoteReviewStaleError,
  VoteReviewUnavailableError,
  type VoteReviewGuard,
  type VoteReviewRow,
  type VoteReviewEpoch,
} from './own-votes-review.ts';
import { STANDARD_QUESTION_ID } from './standard-question.ts';
import { createQuestionVoteAdmission } from './question-vote-admission.ts';
export { STANDARD_QUESTION_ID } from './standard-question.ts';
export { VOTE_SCOPE, VoteInvalidError, VoteReviewStaleError, VoteReviewUnavailableError } from './own-votes-review.ts';
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

/** Trusted caller source operands join the receipt digest; admission runs only in a fresh native body. */
export type VoteCommandAdmission = {
  input: unknown;
  prepare(): Promise<(tx: import('../command/command.ts').CommandTransaction) => Promise<void>>;
};

/** Bounded native linkage retained after the provider input has been scrubbed. */
export type PutVoteReceipt = Readonly<{
  requestKey: string;
  digest: string;
  questionId: string;
  targetId: string;
}>;
export type PreparedPutVote = Readonly<{ input: PutVoteInput; receipt: PutVoteReceipt }>;

export type VoteReviewCurrentVote = Exclude<OwnCountedVoteObservation, { state: 'unavailable' }>;
export type VoteReview = Readonly<{
  question: RatingQuestion;
  currentVote: VoteReviewCurrentVote;
  guard: VoteReviewGuard;
}>;

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

type Dependencies = {
  pool: Pool;
  access: Access;
  capabilities?: RatingCapabilities;
  clock?: KernelClock;
  semantic?: RatingVoteSemantic;
};
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
  const target = await (config.semantic ?? ratingVoteSemantic()).resolve(config, actor, input.targetId, deadline);
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

const PUT_VOTE_KIND = 'rating.vote.put';

/** The producer owns the canonical command input for both execution and receipt linkage. */
function normalizePutVoteInput(input: PutVoteInput, participant: IdentityRatingCommitParticipant) {
  if (!input || typeof input !== 'object' || typeof input.questionId !== 'string' || typeof input.targetId !== 'string')
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
  let identityPreparation: IdentityRatingCommitPreparation | null = null;
  if (input.guard !== undefined) {
    try {
      guard = normalizeVoteReviewGuard(input.guard, input.targetId);
      const identity = guard.subject.identity;
      if (identity !== undefined) {
        identityPreparation = participant.prepare(identity);
        if (
          identity.requestedOriginalId !== input.targetId ||
          identity.canonicalTerminalId !== guard.subject.canonicalId
        )
          throw new TypeError('Identity review does not describe the requested vote');
      }
    } catch {
      throw new VoteInvalidError('guard');
    }
  }
  return {
    input: {
      questionId: input.questionId,
      targetId: input.targetId,
      units: input.units,
      ...(guard ? { guard } : {}),
      ...(observation ? { observation } : {}),
    },
    identityPreparation,
  };
}

/** Writes and reads the signed-in person's current rating vote on the account's partition. */
export function createVoteCommands(config: Dependencies) {
  const { pool } = config;
  const capabilities = ratingCapabilities(config);
  const clock = config.capabilities?.clock ?? config.clock;
  const runner = createLibraryCommandRunner({
    ...(capabilities.command ? { command: capabilities.command } : {}),
    pool,
    ...(clock === undefined ? {} : { clock }),
  });
  // Guarded and unguarded votes share token-scope rating:vote authorization.
  // Access does not require a live account grant for this action; HTTP PUT votes
  // already admit on the authenticated account plus personal Library exposure.
  const guardedRunner = createLibraryCommandRunner({
    ...(capabilities.command ? { command: capabilities.command } : {}),
    pool,
    ...(clock === undefined ? {} : { clock }),
  });
  const semantic = config.semantic ?? ratingVoteSemantic();
  config = { ...config, semantic };
  const countedVoteReader = createOwnCountedVoteReader({ pool, access: config.access, semantic });
  const questionAdmission = createQuestionVoteAdmission();
  const identityParticipant = semantic.createCommitParticipant();

  /** Prepare once before starting a command; only receipt needs bounded retention after scrubbing. */
  function preparePutVote(
    actor: Actor,
    input: PutVoteInput,
    idempotencyKey: string,
    admission?: VoteCommandAdmission,
  ): PreparedPutVote {
    voteAccount(actor);
    const { input: normalized } = normalizePutVoteInput(input, identityParticipant);
    return {
      input: normalized,
      receipt: Object.freeze({
        requestKey: idempotencyKey,
        digest: libraryCommandReceiptDigestForActor(actor, PUT_VOTE_KIND, {
          ...normalized,
          ...(admission ? { admission: admission.input } : {}),
        }),
        questionId: normalized.questionId,
        targetId: normalized.targetId,
      }),
    };
  }

  /** Historical command evidence only; absence never executes or records a vote. */
  async function reconcilePutVote(actor: Actor, receipt: PutVoteReceipt): Promise<PutVoteOutcome | null> {
    voteAccount(actor);
    const outcome = await guardedRunner.ownAccountReceiptOnly<unknown, Vote | null>(actor, {
      action: VOTE_SCOPE,
      kind: PUT_VOTE_KIND,
      requestKey: receipt.requestKey,
      digest: receipt.digest,
      prepare: (attempt) => prepareVoteTarget(config, actor, receipt, commandAttemptDeadline(attempt)),
      async authorize() {},
    });
    return outcome
      ? {
          vote: outcome.value,
          component: { partition: outcome.partition, epoch: outcome.epoch, position: outcome.position },
        }
      : null;
  }

  async function putVoteOutcome(
    actor: Actor,
    input: PutVoteInput,
    idempotencyKey: string,
    admission?: VoteCommandAdmission,
  ): Promise<PutVoteOutcome> {
    const owner = voteAccount(actor);
    const normalized = normalizePutVoteInput(input, identityParticipant);
    input = normalized.input;
    const { guard, observation } = input;
    const questionPreparation = guard
      ? questionAdmission.prepare({ questionId: input.questionId, question: guard.question })
      : null;
    const initial = guard ? null : await prepareVoteTarget(config, actor, input, deadlineFor(5_000));

    try {
      const outcome = await (guard ? guardedRunner : runner).ownAccountPrepared(
        actor,
        {
          action: VOTE_SCOPE,
          kind: PUT_VOTE_KIND,
          requestKey: idempotencyKey,
          input: {
            ...input,
            ...(admission ? { admission: admission.input } : {}),
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
            if (observation && !guard) assertVoteObservation(observation, current.question, current.target.subjectId);
            if (initial && current.target.subjectId !== initial.target.subjectId)
              throw new IdentityRatingAdmissionPendingError(input.targetId, 'source-pending');
            let epochs: readonly VoteReviewEpoch[] = [];
            let error: VoteReviewUnavailableError | null = null;
            if (guard) {
              try {
                epochs = await semantic.epochs(
                  pool,
                  [input.targetId, current.target.subjectId].map((id) => partitionOf(requireRoute(id))),
                  deadline,
                );
              } catch (failure) {
                if (!(failure instanceof VoteReviewUnavailableError)) throw failure;
                error = failure;
              }
            }
            const admit = await admission?.prepare();
            return {
              ...current,
              epochs,
              error,
              admit,
              questionAdmission: questionPreparation,
              identityAdmission: normalized.identityPreparation,
            };
          },
        },
        async (tx, command, prepared) => {
          await prepared.admit?.(tx);
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
            compareVoteIdentityEpochs(guard.subject.epochs, prepared.epochs);
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
            // Historical guards keep their exact digest for receipt replay, but a
            // fresh effect requires the explicitly reviewed Semantic operand.
            if (!prepared.identityAdmission) throw new VoteReviewUnavailableError('atomic_guard_unavailable');
            await questionAdmission.admit(tx, prepared.questionAdmission!);
            await identityParticipant.admit(tx, prepared.identityAdmission);
            // Recompare the legacy published-home witness under the same owner
            // fence, including a matching no-op. Preparation alone cannot fence it.
            const identity = await semantic.admit(tx, {
              requestedTargetId: input.targetId,
              resolvedTargetId: resolved.subjectId,
              expectedEpochs: guard.subject.epochs,
            });
            if (identity.status === 'pending')
              throw new VoteReviewUnavailableError(
                identity.reason === 'epoch-pending' ? 'identity_pending' : 'identity_observation_unavailable',
              );
          }
          const previous = previousRow ? asVote(previousRow) : null;
          const isAlreadyCurrent = previousRow?.countedTarget === resolved.subjectId;
          if (
            (!previous && !countedRow && input.units === null) ||
            (isAlreadyCurrent && previous?.units === input.units)
          )
            throw new VoteUnchanged(previous);

          if (!guard) {
            const admission = await semantic.admit(tx, {
              requestedTargetId: input.targetId,
              resolvedTargetId: resolved.subjectId,
            });
            if (admission.status === 'pending')
              throw new IdentityRatingAdmissionPendingError(input.targetId, admission.reason);
          }

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
    const deadline = deadlineFor(5_000);
    await findQuestion(config, actor, questionId, deadline);
    if (!(await semantic.resolve(config, actor, targetId, deadline))) return null;
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

  /** Complete native review operands; observations confer no write authority. */
  async function readVoteReview(actor: Actor, questionId: string, targetId: string): Promise<VoteReview> {
    const question = await readRatingQuestion(actor, questionId);
    if (questionId !== STANDARD_QUESTION_ID) throw new VoteReviewUnavailableError('atomic_guard_unavailable');

    const deadline = deadlineFor(5_000);
    const request = Object.freeze({ actor, targetIds: Object.freeze([targetId]) });
    const prepared = await countedVoteReader.prepare(request, deadline);
    if (prepared.status !== 'prepared')
      throw new VoteReviewUnavailableError(
        prepared.reason === 'identity-pending'
          ? 'identity_pending'
          : prepared.reason === 'question-changed'
            ? 'question_observation_unavailable'
            : 'identity_observation_unavailable',
      );
    const preparation = prepared.preparation;
    if (
      !preparation.question ||
      preparation.question.questionId !== question.id ||
      preparation.question.revision !== question.revision ||
      preparation.question.lifecycleRevision !== question.lifecycleRevision
    )
      throw new VoteReviewUnavailableError('question_observation_unavailable');

    const readResult = await semantic.snapshot(
      pool,
      (client) => countedVoteReader.read(client, request, preparation),
      deadline,
    );
    const current = await countedVoteReader.finish(request, preparation, readResult, deadline);
    if (current.status !== 'current')
      throw new VoteReviewUnavailableError(
        current.reason === 'question-changed'
          ? 'question_observation_unavailable'
          : current.reason === 'identity-changed'
            ? 'identity_observation_unavailable'
            : current.reason === 'vote-changed'
              ? 'own_vote_observation_unavailable'
              : 'own_vote_observation_unavailable',
      );
    const observation = current.observations[0]!;
    if (observation.state === 'unavailable') throw new VoteReviewUnavailableError('identity_observation_unavailable');
    const identity = await semantic.review(pool, {
      requestedOriginalId: targetId,
      canonicalTerminalId: observation.countingTargetId,
      deadline,
    });
    if (identity.state !== 'reviewed')
      throw new VoteReviewUnavailableError(
        identity.state === 'pending' ? 'identity_pending' : 'identity_observation_unavailable',
      );
    const guard = normalizeVoteReviewGuard(
      { ...observation.review, subject: { ...observation.review.subject, identity: identity.operand } },
      targetId,
    );
    const currentVote = Object.freeze({ ...observation, review: guard });
    return Object.freeze({ question, currentVote, guard });
  }

  return { preparePutVote, reconcilePutVote, putVote, putVoteOutcome, readOwnVote, readRatingQuestion, readVoteReview };
}
