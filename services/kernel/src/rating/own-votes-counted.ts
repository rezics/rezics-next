import { identityMappingObservationValue } from '../semantic/identity-core/index.ts';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount, type Account } from '../access/account-data.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { identityEpochStore } from '../semantic/identity-adapters/index.ts';
import type { IdentityMapping } from '../semantic/identity-core/index.ts';
import { readableSubjects } from '../library/subject-anchor.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readVisibleRatingQuestion } from './question-directory.ts';
import { VOTE_SCOPE, VoteInvalidError } from './votes.ts';
import { STANDARD_QUESTION_ID } from './standard-question.ts';
import countedVotes from './own-votes-counted.sql';
import { readIdentityRatingEpochs } from '../semantic/identity-rating-admission.ts';
import {
  ownVoteReviewWitness,
  readVoteReviewSlots,
  VoteReviewUnavailableError,
  type VoteReviewGuard,
  type VoteReviewEpoch,
  type VoteReviewSlot,
} from './own-votes-review.ts';

export const OWN_COUNTED_VOTE_TARGET_LIMIT = 100;

export type StandardRatingMeasurement = Readonly<{
  questionId: typeof STANDARD_QUESTION_ID;
  revision: 1;
  minimumUnits: 0;
  maximumUnits: 20;
  stepUnits: 1;
}>;

export const STANDARD_RATING_MEASUREMENT: StandardRatingMeasurement = Object.freeze({
  questionId: STANDARD_QUESTION_ID,
  revision: 1,
  minimumUnits: 0,
  maximumUnits: 20,
  stepUnits: 1,
});

export type OwnCountedVoteRequest = Readonly<{
  actor: Actor;
  targetIds: readonly string[];
}>;

export type OwnCountedVoteIdentity = Readonly<{
  requestedTargetId: string;
  countingTargetId: string;
  sourceEpoch: string;
}>;

export type OwnCountedVotePreparedTarget =
  | OwnCountedVoteIdentity
  | Readonly<{
      requestedTargetId: string;
      state: 'unavailable';
    }>;

export type OwnCountedVoteQuestionObservation = Readonly<{
  questionId: string;
  revision: number;
  ownerId: string | null;
  realmId: string | null;
  meaning: string | null;
  grain: string;
  minimumUnits: number;
  maximumUnits: number;
  stepUnits: number;
  lifecycleState: string;
  lifecycleRevision: number;
}>;

export type OwnCountedVoteAccountObservation = Readonly<{
  route: number;
  accountId: string;
  kind: string;
  state: string;
  controllerId: string | null;
  minimumAuthnEpoch: string;
  fenced: boolean;
  transactionId: string;
}>;

export type OwnCountedVotePreparation = Readonly<{
  requestFingerprint: string;
  preparationFingerprint: string;
  identityFingerprint: string;
  visibilityFingerprint: string;
  requestedTargetIds: readonly string[];
  targets: readonly OwnCountedVotePreparedTarget[];
  account: OwnCountedVoteAccountObservation;
  question: OwnCountedVoteQuestionObservation | null;
}>;

export type OwnCountedVotePrepareResult =
  | Readonly<{ status: 'prepared'; preparation: OwnCountedVotePreparation }>
  | Readonly<{
      status: 'preparing';
      reason: 'identity-pending' | 'identity-changed' | 'question-changed';
      retry: 'same-input';
      targets: readonly Readonly<{ requestedTargetId: string; state: 'pending' }>[];
    }>;

export type OwnCountedVoteRow = Readonly<{
  countingTargetId: string;
  originalTargetId: string;
  units: number | null;
  revision: number;
  countedRevision: number;
  changedAt: string;
  transactionId: string;
}>;

export type OwnCountedVoteReadResult =
  | Readonly<{
      status: 'read';
      requestFingerprint: string;
      preparationFingerprint: string;
      account: OwnCountedVoteAccountObservation;
      rows: readonly OwnCountedVoteRow[];
      slots: readonly VoteReviewSlot[];
      rowFingerprint: string;
    }>
  | Readonly<{
      status: 'preparing';
      reason: 'request-changed' | 'preparation-changed' | 'account-changed';
      retry: 'same-input';
    }>;

export type OwnCountedVoteObservation =
  | (OwnCountedVoteIdentity &
      Readonly<{
        state: 'counted';
        review: VoteReviewGuard;
        measurement: StandardRatingMeasurement;
        originalTargetId: string;
        units: number;
        revision: number;
        countedRevision: number;
        changedAt: string;
        transactionId: string;
      }>)
  | (OwnCountedVoteIdentity &
      Readonly<{
        state: 'clear';
        review: VoteReviewGuard;
        measurement: StandardRatingMeasurement;
        originalTargetId: string;
        units: null;
        revision: number;
        countedRevision: number;
        changedAt: string;
        transactionId: string;
      }>)
  | (OwnCountedVoteIdentity &
      Readonly<{
        state: 'absent';
        review: VoteReviewGuard;
        measurement: StandardRatingMeasurement;
      }>)
  | Readonly<{ requestedTargetId: string; state: 'unavailable' }>;

export type OwnCountedVoteResult =
  | Readonly<{
      status: 'current';
      measurement: StandardRatingMeasurement;
      requestedTargetIds: readonly string[];
      observations: readonly OwnCountedVoteObservation[];
    }>
  | Readonly<{
      status: 'preparing';
      reason:
        | 'request-changed'
        | 'preparation-changed'
        | 'account-changed'
        | 'question-changed'
        | 'identity-changed'
        | 'vote-changed';
      retry: 'same-input';
    }>;

type Queryable = Pick<Pool | PoolClient, 'query'>;
export type OwnCountedVoteReaderDependencies = Readonly<{ pool: Pool; access: Access }>;
export type OwnCountedVoteReader = Readonly<{
  prepare(request: OwnCountedVoteRequest, deadline: number): Promise<OwnCountedVotePrepareResult>;
  read(
    client: Pick<PoolClient, 'query'>,
    request: OwnCountedVoteRequest,
    preparation: OwnCountedVotePreparation,
  ): Promise<OwnCountedVoteReadResult>;
  finish(
    request: OwnCountedVoteRequest,
    preparation: OwnCountedVotePreparation,
    readResult: OwnCountedVoteReadResult,
    deadline: number,
  ): Promise<OwnCountedVoteResult>;
}>;
type QueryRow = NonNullable<Awaited<ReturnType<typeof countedVotes.run>>>[number];

function owner(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(VOTE_SCOPE))
    throw new GrantDeniedError();
  return actor;
}

function accountObservation(row: Account): OwnCountedVoteAccountObservation {
  return {
    route: row.route,
    accountId: row.accountId,
    kind: row.kind,
    state: row.state,
    controllerId: row.controllerId,
    minimumAuthnEpoch: row.minimumAuthnEpoch.toString(),
    fenced: row.fenced,
    transactionId: row.transactionId,
  };
}

async function readAccountObservation(
  client: Queryable,
  actor: AccountActor,
): Promise<OwnCountedVoteAccountObservation> {
  const route = routeOf(actor.accountId);
  if (route === null) throw new GrantDeniedError();
  const row = await readAccount(client, route, actor.accountId);
  if (
    !row ||
    row.kind !== 'actor' ||
    row.state !== 'active' ||
    row.fenced ||
    !Number.isSafeInteger(actor.authnEpoch) ||
    actor.authnEpoch < 1 ||
    row.minimumAuthnEpoch > BigInt(actor.authnEpoch)
  )
    throw new GrantDeniedError();
  return accountObservation(row);
}

function actorFingerprint(actor: Actor): string {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return JSON.stringify([
    actor.accountId,
    actor.clientId,
    [...actor.scopes].sort(),
    actor.authnEpoch,
    actor.requestedBy,
  ]);
}

function requestFingerprint(request: OwnCountedVoteRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([actorFingerprint(request.actor), [...request.targetIds]]))
    .digest('hex');
}

function questionObservation(
  row: NonNullable<Awaited<ReturnType<typeof readVisibleRatingQuestion>>>,
): OwnCountedVoteQuestionObservation {
  return {
    questionId: row.id,
    revision: Number(row.revision),
    ownerId: row.ownerId,
    realmId: row.realmId,
    meaning: row.meaning,
    grain: row.grain,
    minimumUnits: Number(row.minimumUnits),
    maximumUnits: Number(row.maximumUnits),
    stepUnits: Number(row.stepUnits),
    lifecycleState: row.lifecycleState,
    lifecycleRevision: Number(row.lifecycleRevision),
  };
}

async function readQuestionObservation(
  deps: OwnCountedVoteReaderDependencies,
  actor: Actor,
  deadline: number,
): Promise<OwnCountedVoteQuestionObservation> {
  const row = await readVisibleRatingQuestion(deps, actor, STANDARD_QUESTION_ID, deadline);
  if (!row) throw new ProblemError('not_found');
  return questionObservation(row);
}

function identityObservationsEqual(left: readonly IdentityMapping[], right: readonly IdentityMapping[]): boolean {
  return (
    JSON.stringify(left.map(identityMappingObservationValue)) ===
    JSON.stringify(right.map(identityMappingObservationValue))
  );
}

function identityFingerprint(mappings: readonly IdentityMapping[]): string {
  return createHash('sha256')
    .update(JSON.stringify(mappings.map(identityMappingObservationValue)))
    .digest('hex');
}

function visibilityFingerprint(ids: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex');
}

function accountObservationsEqual(left: OwnCountedVoteAccountObservation, right: OwnCountedVoteAccountObservation) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetIds(request: OwnCountedVoteRequest): string[] {
  const actor = owner(request.actor);
  if (request.targetIds.length > OWN_COUNTED_VOTE_TARGET_LIMIT) throw new VoteInvalidError('targetIds');
  if (routeOf(STANDARD_QUESTION_ID) === null) throw new Error('Standard Rating question has no native route');
  if (request.targetIds.some((id) => routeOf(id) === null)) throw new VoteInvalidError('targetIds');
  if (routeOf(actor.accountId) === null) throw new GrantDeniedError();
  return [...new Set(request.targetIds)];
}

function validStandardQuestion(row: OwnCountedVoteQuestionObservation): boolean {
  return (
    row.questionId === STANDARD_QUESTION_ID &&
    row.revision === STANDARD_RATING_MEASUREMENT.revision &&
    row.ownerId === null &&
    row.realmId === null &&
    row.meaning === null &&
    row.grain === 'work' &&
    row.minimumUnits === STANDARD_RATING_MEASUREMENT.minimumUnits &&
    row.maximumUnits === STANDARD_RATING_MEASUREMENT.maximumUnits &&
    row.stepUnits === STANDARD_RATING_MEASUREMENT.stepUnits
  );
}

function preparationFingerprint(
  requestHash: string,
  targets: readonly OwnCountedVotePreparedTarget[],
  account: OwnCountedVoteAccountObservation,
  question: OwnCountedVoteQuestionObservation | null,
  identities: string,
  visibility: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([requestHash, targets, account, question, identities, visibility]))
    .digest('hex');
}

function readFingerprint(
  requestHash: string,
  preparationHash: string,
  rows: readonly OwnCountedVoteRow[],
  slots: readonly VoteReviewSlot[],
): string {
  return createHash('sha256')
    .update(JSON.stringify([requestHash, preparationHash, rows, slots]))
    .digest('hex');
}

async function readRows(
  client: Queryable,
  actor: AccountActor,
  countingTargetIds: readonly string[],
): Promise<OwnCountedVoteRow[]> {
  if (!countingTargetIds.length) return [];
  const route = routeOf(actor.accountId);
  if (route === null) throw new GrantDeniedError();
  const rows = await countedVotes.run(client, {
    route,
    voter_id: actor.accountId,
    question_id: STANDARD_QUESTION_ID,
    counted_target_ids: [...new Set(countingTargetIds)],
  });
  const result = rows.map((row: QueryRow): OwnCountedVoteRow => {
    if (row.countingTargetId === null) throw new VoteReviewUnavailableError('own_vote_observation_unavailable');
    if (row.changedAt === null) throw new Error('Rating vote has no change time');
    const units = row.units === null ? null : Number(row.units);
    const revision = Number(row.revision);
    const countedRevision = Number(row.countedRevision);
    if (
      (units !== null && !Number.isSafeInteger(units)) ||
      !Number.isSafeInteger(revision) ||
      !Number.isSafeInteger(countedRevision)
    )
      throw new Error('Rating vote has an invalid native revision or unit value');
    return {
      countingTargetId: row.countingTargetId,
      originalTargetId: row.originalTargetId,
      units,
      revision,
      countedRevision,
      changedAt: row.changedAt,
      transactionId: row.transactionId,
    };
  });
  result.sort((left, right) => left.countingTargetId.localeCompare(right.countingTargetId));
  if (new Set(result.map((row) => row.countingTargetId)).size !== result.length)
    throw new Error('Rating counted target returned more than one native vote');
  return result;
}

function validPreparation(preparation: OwnCountedVotePreparation): boolean {
  return (
    preparation.preparationFingerprint ===
    preparationFingerprint(
      preparation.requestFingerprint,
      preparation.targets,
      preparation.account,
      preparation.question,
      preparation.identityFingerprint,
      preparation.visibilityFingerprint,
    )
  );
}

export function createOwnCountedVoteReader(deps: OwnCountedVoteReaderDependencies): OwnCountedVoteReader {
  const identityWitnesses = new WeakMap<OwnCountedVotePreparation, readonly IdentityMapping[]>();
  const visibilityWitnesses = new WeakMap<OwnCountedVotePreparation, readonly string[]>();
  const epochWitnesses = new WeakMap<OwnCountedVotePreparation, readonly VoteReviewEpoch[]>();

  function homes(targets: readonly OwnCountedVotePreparedTarget[]) {
    return targets.flatMap((target) =>
      'countingTargetId' in target
        ? [target.requestedTargetId, target.countingTargetId].map((id) => partitionOf(routeOf(id)!))
        : [],
    );
  }

  function slotIds(targets: readonly OwnCountedVotePreparedTarget[]) {
    return targets.flatMap((target) =>
      'countingTargetId' in target ? [target.requestedTargetId, target.countingTargetId] : [],
    );
  }

  async function prepare(request: OwnCountedVoteRequest, deadline: number): Promise<OwnCountedVotePrepareResult> {
    const ids = targetIds(request);
    const actor = owner(request.actor);
    const account = await withReadTransaction(
      deps.pool,
      async (client) => {
        await partitionReadClient(client, partitionOf(routeOf(actor.accountId)!));
        return readAccountObservation(client, actor);
      },
      deadline,
    );
    if (!ids.length) {
      const requestHash = requestFingerprint(request);
      const targets: OwnCountedVotePreparedTarget[] = [];
      const identities: IdentityMapping[] = [];
      const identityHash = identityFingerprint(identities);
      const visibleIds: string[] = [];
      const visibleHash = visibilityFingerprint(visibleIds);
      const preparation = {
        requestFingerprint: requestHash,
        identityFingerprint: identityHash,
        visibilityFingerprint: visibleHash,
        requestedTargetIds: targets.map((target) => target.requestedTargetId),
        targets,
        account,
        question: null,
        preparationFingerprint: preparationFingerprint(requestHash, targets, account, null, identityHash, visibleHash),
      } satisfies OwnCountedVotePreparation;
      identityWitnesses.set(preparation, identities);
      visibilityWitnesses.set(preparation, visibleIds);
      epochWitnesses.set(preparation, []);
      return { status: 'prepared', preparation };
    }

    const question = await readQuestionObservation(deps, actor, deadline);
    if (!validStandardQuestion(question))
      return { status: 'preparing', reason: 'question-changed', retry: 'same-input', targets: [] };

    const first = await identityEpochStore.readMappings(deps.pool, ids);
    const visible = new Set(
      await readableSubjects(
        { pool: deps.pool, access: deps.access },
        actor,
        ids.filter((_, index) => first[index]?.state === 'mapped'),
      ),
    );
    const last = await identityEpochStore.readMappings(deps.pool, ids);
    if (!identityObservationsEqual(first, last))
      return { status: 'preparing', reason: 'identity-changed', retry: 'same-input', targets: [] };

    const pending = ids.flatMap((requestedTargetId, index) =>
      last[index]?.state === 'pending' ? [{ requestedTargetId, state: 'pending' as const }] : [],
    );
    if (pending.length)
      return { status: 'preparing', reason: 'identity-pending', retry: 'same-input', targets: pending };

    const targets: OwnCountedVotePreparedTarget[] = ids.map((requestedTargetId, index) => {
      const mapping = last[index];
      if (
        !mapping ||
        mapping.state !== 'mapped' ||
        mapping.original !== requestedTargetId ||
        !visible.has(requestedTargetId)
      )
        return { requestedTargetId, state: 'unavailable' };
      return {
        requestedTargetId,
        countingTargetId: mapping.terminal,
        sourceEpoch: mapping.epoch.toString(),
      };
    });
    let epochs: VoteReviewEpoch[];
    try {
      epochs = await readIdentityRatingEpochs(deps.pool, homes(targets), deadline);
    } catch (error) {
      if (!(error instanceof VoteReviewUnavailableError)) throw error;
      return {
        status: 'preparing',
        reason: error.reason === 'identity_pending' ? 'identity-pending' : 'identity-changed',
        retry: 'same-input',
        targets: [],
      };
    }
    const requestHash = requestFingerprint(request);
    const identityHash = identityFingerprint(last);
    const visibleIds = ids.filter((id) => visible.has(id));
    const visibleHash = visibilityFingerprint(visibleIds);
    const preparation = {
      requestFingerprint: requestHash,
      identityFingerprint: identityHash,
      visibilityFingerprint: visibleHash,
      requestedTargetIds: ids,
      targets,
      account,
      question,
      preparationFingerprint: preparationFingerprint(
        requestHash,
        targets,
        account,
        question,
        identityHash,
        visibleHash,
      ),
    } satisfies OwnCountedVotePreparation;
    identityWitnesses.set(preparation, last);
    visibilityWitnesses.set(preparation, visibleIds);
    epochWitnesses.set(preparation, epochs);
    return { status: 'prepared', preparation };
  }

  async function read(
    client: Pick<PoolClient, 'query'>,
    request: OwnCountedVoteRequest,
    preparation: OwnCountedVotePreparation,
  ): Promise<OwnCountedVoteReadResult> {
    const requestHash = requestFingerprint(request);
    if (requestHash !== preparation.requestFingerprint)
      return { status: 'preparing', reason: 'request-changed', retry: 'same-input' };
    if (!validPreparation(preparation) || !identityWitnesses.has(preparation) || !visibilityWitnesses.has(preparation))
      return { status: 'preparing', reason: 'preparation-changed', retry: 'same-input' };
    const actor = owner(request.actor);
    await partitionReadClient(client, partitionOf(routeOf(actor.accountId)!));
    const account = await readAccountObservation(client, actor);
    if (!accountObservationsEqual(account, preparation.account))
      return { status: 'preparing', reason: 'account-changed', retry: 'same-input' };
    const countingTargetIds = preparation.targets.flatMap((target) =>
      'countingTargetId' in target ? [target.countingTargetId] : [],
    );
    const rows = await readRows(client, actor, countingTargetIds);
    const slots = await readVoteReviewSlots(client, {
      ownerId: actor.accountId,
      questionId: STANDARD_QUESTION_ID,
      targetIds: slotIds(preparation.targets),
    });
    return {
      status: 'read',
      requestFingerprint: requestHash,
      preparationFingerprint: preparation.preparationFingerprint,
      account,
      rows,
      slots,
      rowFingerprint: readFingerprint(requestHash, preparation.preparationFingerprint, rows, slots),
    };
  }

  async function finish(
    request: OwnCountedVoteRequest,
    preparation: OwnCountedVotePreparation,
    readResult: OwnCountedVoteReadResult,
    deadline: number,
  ): Promise<OwnCountedVoteResult> {
    const requestHash = requestFingerprint(request);
    if (requestHash !== preparation.requestFingerprint)
      return { status: 'preparing', reason: 'request-changed', retry: 'same-input' };
    if (readResult.status === 'preparing')
      return { status: 'preparing', reason: readResult.reason, retry: 'same-input' };
    if (readResult.requestFingerprint !== requestHash)
      return { status: 'preparing', reason: 'request-changed', retry: 'same-input' };
    if (
      !validPreparation(preparation) ||
      !identityWitnesses.has(preparation) ||
      !visibilityWitnesses.has(preparation) ||
      readResult.preparationFingerprint !== preparation.preparationFingerprint
    )
      return { status: 'preparing', reason: 'preparation-changed', retry: 'same-input' };
    if (!accountObservationsEqual(readResult.account, preparation.account))
      return { status: 'preparing', reason: 'account-changed', retry: 'same-input' };
    if (
      readFingerprint(requestHash, preparation.preparationFingerprint, readResult.rows, readResult.slots) !==
      readResult.rowFingerprint
    )
      return { status: 'preparing', reason: 'preparation-changed', retry: 'same-input' };

    const actor = owner(request.actor);
    const ids = targetIds(request);
    if (ids.length) {
      const question = await readQuestionObservation(deps, actor, deadline);
      if (!validStandardQuestion(question) || JSON.stringify(question) !== JSON.stringify(preparation.question))
        return { status: 'preparing', reason: 'question-changed', retry: 'same-input' };
    }

    const first = await identityEpochStore.readMappings(deps.pool, ids);
    const visible = new Set(
      await readableSubjects(
        { pool: deps.pool, access: deps.access },
        actor,
        ids.filter((_, index) => first[index]?.state === 'mapped'),
      ),
    );
    const last = await identityEpochStore.readMappings(deps.pool, ids);
    if (!identityObservationsEqual(first, last))
      return { status: 'preparing', reason: 'identity-changed', retry: 'same-input' };
    const originalWitnesses = identityWitnesses.get(preparation);
    const originalVisibility = visibilityWitnesses.get(preparation);
    const currentVisibility = ids.filter((id) => visible.has(id));
    if (
      !originalWitnesses ||
      !identityObservationsEqual(originalWitnesses, first) ||
      identityFingerprint(first) !== preparation.identityFingerprint ||
      !originalVisibility ||
      JSON.stringify(originalVisibility) !== JSON.stringify(currentVisibility) ||
      visibilityFingerprint(currentVisibility) !== preparation.visibilityFingerprint
    )
      return { status: 'preparing', reason: 'identity-changed', retry: 'same-input' };
    if (first.some((mapping) => mapping.state === 'pending'))
      return { status: 'preparing', reason: 'identity-changed', retry: 'same-input' };
    if (preparation.targets.some((target) => 'countingTargetId' in target && !visible.has(target.requestedTargetId)))
      return { status: 'preparing', reason: 'identity-changed', retry: 'same-input' };

    let epochs: VoteReviewEpoch[];
    try {
      epochs = await readIdentityRatingEpochs(deps.pool, homes(preparation.targets), deadline);
    } catch (error) {
      if (!(error instanceof VoteReviewUnavailableError)) throw error;
      return { status: 'preparing', reason: 'identity-changed', retry: 'same-input' };
    }
    if (JSON.stringify(epochs) !== JSON.stringify(epochWitnesses.get(preparation)))
      return { status: 'preparing', reason: 'identity-changed', retry: 'same-input' };

    const current = await withReadTransaction(
      deps.pool,
      async (client) => {
        await partitionReadClient(client, partitionOf(routeOf(actor.accountId)!));
        const account = await readAccountObservation(client, actor);
        const countingTargetIds = preparation.targets.flatMap((target) =>
          'countingTargetId' in target ? [target.countingTargetId] : [],
        );
        const rows = await readRows(client, actor, countingTargetIds);
        const slots = await readVoteReviewSlots(client, {
          ownerId: actor.accountId,
          questionId: STANDARD_QUESTION_ID,
          targetIds: slotIds(preparation.targets),
        });
        return { account, rows, slots };
      },
      deadline,
    );
    if (!accountObservationsEqual(current.account, preparation.account))
      return { status: 'preparing', reason: 'account-changed', retry: 'same-input' };
    if (
      JSON.stringify(current.rows) !== JSON.stringify(readResult.rows) ||
      JSON.stringify(current.slots) !== JSON.stringify(readResult.slots)
    )
      return { status: 'preparing', reason: 'vote-changed', retry: 'same-input' };

    const rowsByCountingTarget = new Map(current.rows.map((row) => [row.countingTargetId, row]));
    const slotsByTarget = new Map(current.slots.map((slot) => [slot.targetId, slot.vote]));
    const observations: OwnCountedVoteObservation[] = preparation.targets.map((target) => {
      if (!('countingTargetId' in target)) return target;
      const row = rowsByCountingTarget.get(target.countingTargetId);
      const review: VoteReviewGuard = {
        version: 1,
        question: {
          revision: preparation.question!.revision,
          lifecycleRevision: preparation.question!.lifecycleRevision,
        },
        subject: {
          canonicalId: target.countingTargetId,
          epochs: epochs.filter((epoch) => homes([target]).includes(epoch.partition)),
        },
        ownVote: ownVoteReviewWitness({
          ownerId: actor.accountId,
          questionId: STANDARD_QUESTION_ID,
          requestedTargetId: target.requestedTargetId,
          canonicalId: target.countingTargetId,
          original: slotsByTarget.get(target.requestedTargetId) ?? null,
          canonical: slotsByTarget.get(target.countingTargetId) ?? null,
          effective: row ? { ...row, targetId: row.originalTargetId, countedTarget: row.countingTargetId } : null,
        }),
      };
      const base = {
        requestedTargetId: target.requestedTargetId,
        countingTargetId: target.countingTargetId,
        sourceEpoch: target.sourceEpoch,
        measurement: STANDARD_RATING_MEASUREMENT,
        review,
      };
      if (!row) return { ...base, state: 'absent' };
      if (row.units === null)
        return {
          ...base,
          state: 'clear',
          originalTargetId: row.originalTargetId,
          units: null,
          revision: row.revision,
          countedRevision: row.countedRevision,
          changedAt: row.changedAt,
          transactionId: row.transactionId,
        };
      return {
        ...base,
        state: 'counted',
        originalTargetId: row.originalTargetId,
        units: row.units,
        revision: row.revision,
        countedRevision: row.countedRevision,
        changedAt: row.changedAt,
        transactionId: row.transactionId,
      };
    });
    return {
      status: 'current',
      measurement: STANDARD_RATING_MEASUREMENT,
      requestedTargetIds: preparation.requestedTargetIds,
      observations,
    };
  }

  return { prepare, read, finish };
}
