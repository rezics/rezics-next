import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount } from '../access/account-data.ts';
import type { KernelClock } from '../clock.ts';
import { noEffect, type CommandEvent, type CommandTransaction } from '../command/command.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readCurrentClassificationAssociation, type CurrentClassificationAssociation } from '../semantic/classification-association.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { createLibraryCommandRunner, requireRoute } from '../library/command-support.ts';
import { commandAttemptDeadline } from '../command/command.ts';
import { CLASSIFICATION_BALLOT_CHANGED, CLASSIFICATION_BALLOT_CLEANUP } from './events.ts';
import actorStateRead from './classification-ballot-actor-state-lock.sql';
import actorStateInsert from './classification-ballot-actor-state-insert.sql';
import actorStateActivate from './classification-ballot-actor-state-activate.sql';
import slotLock from './classification-ballot-slot-lock.sql';
import slotUpsert from './classification-ballot-slot-upsert.sql';
import ownSlotRead from './classification-ballot-own-read.sql';
import aggregateRead from './classification-ballot-aggregate-read.sql';
import contributionOwnRead from './classification-ballot-contribution-own-read.sql';

export const CLASSIFICATION_BALLOT_SET = 'classification_ballot:set';
export const CLASSIFICATION_BALLOT_READ_OWN = 'classification_ballot:read-own';
export const CLASSIFICATION_BALLOT_READ_AGGREGATE = 'classification_ballot:read-aggregate';
export const CLASSIFICATION_BALLOT_MINIMUM = 5;

export type Assessment = 'support' | 'oppose';
export type SetClassificationBallotInput = {
  subjectId: string;
  associationId: string;
  assessment: Assessment;
  falsePositive: boolean;
};
export type BallotSlot = {
  binding_hash: Buffer;
  assessment: Assessment | null;
  falsePositive: boolean;
  revision: string;
  eligibilityGeneration: string;
  eligible: boolean;
};
type ActorState = {
  eligible: boolean;
  generation: string;
  tombstoned: boolean;
  cleanup_pending: boolean;
};
type Aggregate = {
  supportCount: number;
  opposeCount: number;
  falsePositiveCount: number;
  generation: string;
  asOf: Date | string;
};
type Dependencies = { pool: Pool; access: Access; clock?: KernelClock };

export class ClassificationBallotNotFoundError extends Error {
  constructor() {
    super('Classification association not found');
    this.name = 'ClassificationBallotNotFoundError';
  }
}

export class ClassificationBallotInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid classification ballot field: ${field}`);
    this.name = 'ClassificationBallotInvalidError';
  }
}

export function classificationAggregateView(associationId: string, row: Aggregate | null) {
  if (!row || row.supportCount + row.opposeCount < CLASSIFICATION_BALLOT_MINIMUM)
    return { associationId, state: 'suppressed' as const, pending: 'unknown' as const };
  const denominator = row.supportCount + row.opposeCount;
  return {
    associationId,
    state: 'published' as const,
    supportCount: Number(row.supportCount),
    opposeCount: Number(row.opposeCount),
    falsePositiveCount: Number(row.falsePositiveCount),
    supportFraction: denominator === 0 ? null : Number(row.supportCount) / denominator,
    asOf: new Date(row.asOf).toISOString(),
    generation: String(row.generation),
    pending: 'unknown' as const,
  };
}

function account(actor: Actor, scope: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(scope))
    throw new GrantDeniedError();
  return actor;
}

function queryClient(tx: CommandTransaction) {
  return { query: tx.query.bind(tx) };
}

function hashBytes(value: Buffer): string {
  return value.toString('hex');
}

function nextRevision(value: string | undefined): string {
  const revision = BigInt(value ?? '0') + 1n;
  if (revision > 9_223_372_036_854_775_807n) throw new Error('Classification ballot revision exhausted');
  return revision.toString();
}

function changedEvent(input: {
  actorId: string;
  association: CurrentClassificationAssociation | Pick<CurrentClassificationAssociation, 'subjectId' | 'associationId' | 'bindingHash'>;
  assessment: Assessment | null;
  falsePositive: boolean;
  revision: string;
  eligibilityGeneration: string;
  eligible: boolean;
}): CommandEvent {
  return {
    type: CLASSIFICATION_BALLOT_CHANGED,
    subject: input.association.subjectId,
    data: {
      actorId: input.actorId,
      subjectId: input.association.subjectId,
      associationId: input.association.associationId,
      bindingHash: input.association.bindingHash,
      assessment: input.assessment,
      falsePositive: input.falsePositive,
      revision: input.revision,
      eligibilityGeneration: input.eligibilityGeneration,
      eligible: input.eligible,
    },
  };
}

async function ensureActorState(tx: CommandTransaction, route: number, actorId: string): Promise<ActorState> {
  let row = await actorStateRead.run(queryClient(tx), { route, actor_id: actorId });
  if (!row) {
    await actorStateInsert.run(queryClient(tx), { route, actor_id: actorId });
    row = await actorStateRead.run(queryClient(tx), { route, actor_id: actorId });
  }
  if (!row) throw new Error('Could not initialize classification ballot eligibility');
  return row as ActorState;
}

async function reactivateActorState(
  tx: CommandTransaction,
  route: number,
  actorId: string,
  state: ActorState,
): Promise<{ state: ActorState; event?: CommandEvent }> {
  if (state.tombstoned) throw new GrantDeniedError();
  if (state.eligible) return { state };
  const row = await actorStateActivate.run(queryClient(tx), { route, actor_id: actorId });
  if (!row) throw new GrantDeniedError();
  const next = row as ActorState;
  return {
    state: next,
    event: {
      type: CLASSIFICATION_BALLOT_CLEANUP,
      subject: actorId,
      data: { actorId, generation: next.generation },
    },
  };
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

export function createClassificationBallotCommands(config: Dependencies) {
  const { pool, access, clock } = config;
  // The shared runner supplies actor-home receipt ordering and the current Account floor.
  // Subject/resource admission is independently anchored in Semantic before each receipt lookup.
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });

  async function set(actor: Actor, input: SetClassificationBallotInput, idempotencyKey: string) {
    const owner = account(actor, CLASSIFICATION_BALLOT_SET);
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.subjectId !== 'string' ||
      typeof input.associationId !== 'string' ||
      (input.assessment !== 'support' && input.assessment !== 'oppose')
    )
      throw new ClassificationBallotInvalidError('assessment');
    if (typeof input.falsePositive !== 'boolean') throw new ClassificationBallotInvalidError('falsePositive');
    if (routeOf(input.subjectId) === null || routeOf(input.associationId) === null)
      throw new ClassificationBallotNotFoundError();

    const outcome = await runner.ownAccountPrepared(
      actor,
      {
        action: CLASSIFICATION_BALLOT_SET,
        kind: 'rating.classification-ballot.set',
        requestKey: idempotencyKey,
        input,
        prepare: async (attempt) => {
          const current = await readCurrentClassificationAssociation({
            pool,
            access,
            actor,
            subjectId: input.subjectId,
            associationId: input.associationId,
            action: CLASSIFICATION_BALLOT_SET,
            deadline: commandAttemptDeadline(attempt),
            time: attempt.time,
          });
          if (!current) throw new ClassificationBallotNotFoundError();
          return current;
        },
      },
      async (tx, _command, prepared): Promise<{
        value: { associationId: string; revision: string; delivery: 'unchanged' | 'enqueued' };
        events: readonly CommandEvent[];
      }> => {
        const route = requireRoute(owner.accountId);
        let state = await ensureActorState(tx, route, owner.accountId);
        const activation = await reactivateActorState(tx, route, owner.accountId, state);
        state = activation.state;
        const prior = (await slotLock.run(queryClient(tx), {
          route,
          actor_id: owner.accountId,
          subject_id: prepared.subjectId,
          association_id: prepared.associationId,
        })) as BallotSlot | null;
        if (prior && hashBytes(prior.binding_hash) !== prepared.bindingHash)
          throw new ClassificationBallotNotFoundError();
        const unchanged =
          prior?.assessment === input.assessment &&
          prior.falsePositive === input.falsePositive &&
          prior.eligible &&
          prior.eligibilityGeneration === state.generation;
        if (unchanged && !activation.event)
          return noEffect({ associationId: input.associationId, revision: prior.revision, delivery: 'unchanged' as const });

        const revision = nextRevision(prior?.revision);
        const bindingHash = Buffer.from(prepared.bindingHash, 'hex');
        await slotUpsert.run(queryClient(tx), {
          route,
          actor_id: owner.accountId,
          subject_id: prepared.subjectId,
          association_id: prepared.associationId,
          binding_hash: bindingHash,
          assessment: input.assessment,
          false_positive: input.falsePositive,
          revision,
          eligibility_generation: state.generation,
          eligible: true,
        });
        const events: CommandEvent[] = [];
        if (activation.event) events.push(activation.event);
        events.push(
          changedEvent({
            actorId: owner.accountId,
            association: prepared,
            assessment: input.assessment,
            falsePositive: input.falsePositive,
            revision,
            eligibilityGeneration: state.generation,
            eligible: true,
          }),
        );
        return { value: { associationId: input.associationId, revision, delivery: 'enqueued' as const }, events };
      },
    );
    return outcome.value;
  }

  /** DELETE is deliberately own-account only. It returns no slot state, so a person can withdraw
   * their own retained ballot after association visibility is lost without learning anything. */
  async function clear(actor: Actor, subjectId: string, associationId: string, idempotencyKey: string): Promise<void> {
    const owner = account(actor, CLASSIFICATION_BALLOT_SET);
    if (routeOf(subjectId) === null || routeOf(associationId) === null)
      throw new ClassificationBallotNotFoundError();
    await runner.ownAccountPrepared(
      actor,
      {
        action: CLASSIFICATION_BALLOT_SET,
        kind: 'rating.classification-ballot.clear',
        requestKey: idempotencyKey,
        input: { subjectId, associationId },
        prepare: async (attempt) =>
          readCurrentClassificationAssociation({
            pool,
            access,
            actor,
            subjectId,
            associationId,
            action: CLASSIFICATION_BALLOT_SET,
            deadline: commandAttemptDeadline(attempt),
            time: attempt.time,
          }),
      },
      async (tx, _command, current) => {
        const route = requireRoute(owner.accountId);
        let state = await ensureActorState(tx, route, owner.accountId);
        const activation = await reactivateActorState(tx, route, owner.accountId, state);
        state = activation.state;
        const prior = (await slotLock.run(queryClient(tx), {
          route,
          actor_id: owner.accountId,
          subject_id: subjectId,
          association_id: associationId,
        })) as BallotSlot | null;
        if (current && prior && hashBytes(prior.binding_hash) !== current.bindingHash)
          throw new ClassificationBallotNotFoundError();
        if (!prior || prior.assessment === null) {
          if (activation.event) return { value: null, events: [activation.event] };
          return noEffect(null);
        }
        const revision = nextRevision(prior.revision);
        const cleared = await slotUpsert.run(queryClient(tx), {
          route,
          actor_id: owner.accountId,
          subject_id: subjectId,
          association_id: associationId,
          binding_hash: prior.binding_hash,
          assessment: '',
          false_positive: false,
          revision,
          eligibility_generation: state.generation,
          eligible: state.eligible,
        });
        if (!cleared) throw new Error('Classification ballot clear lost its locked slot');
        const association = {
          subjectId,
          associationId,
          bindingHash: hashBytes(prior.binding_hash),
        };
        const events: CommandEvent[] = [];
        if (activation.event) events.push(activation.event);
        events.push(
          changedEvent({
            actorId: owner.accountId,
            association,
            assessment: null,
            falsePositive: false,
            revision,
            eligibilityGeneration: state.generation,
            eligible: state.eligible,
          }),
        );
        return { value: null, events };
      },
    );
  }

  async function readOwn(actor: Actor, subjectId: string, associationId: string, deadline: number) {
    const owner = account(actor, CLASSIFICATION_BALLOT_READ_OWN);
    const association = await readCurrentClassificationAssociation({
      pool,
      access,
      actor,
      subjectId,
      associationId,
      action: CLASSIFICATION_BALLOT_READ_OWN,
      deadline,
    });
    if (!association) throw new ClassificationBallotNotFoundError();
    const actorRoute = requireRoute(owner.accountId);
    const slot = await withReadTransaction(pool, async (client) => {
      const current = await readAccount(client, actorRoute, owner.accountId);
      assertCurrentAccount(owner, current);
      return (await ownSlotRead.run(client, {
        route: actorRoute,
        actor_id: owner.accountId,
        subject_id: subjectId,
        association_id: associationId,
      })) as BallotSlot | null;
    }, deadline);
    const currentSlot = slot && hashBytes(slot.binding_hash) === association.bindingHash ? slot : null;
    const contribution = currentSlot
      ? await withReadTransaction(pool, (client) =>
          contributionOwnRead.run(client, {
            route: association.subjectRoute,
            subject_id: subjectId,
            association_id: associationId,
            actor_route: actorRoute,
            actor_id: owner.accountId,
          }),
        deadline)
      : null;
    const currentContribution =
      contribution && Buffer.isBuffer(contribution.bindingHash) &&
      hashBytes(contribution.bindingHash) === association.bindingHash
        ? contribution
        : null;
    return {
      associationId,
      hasBallot: currentSlot?.assessment !== null && currentSlot?.assessment !== undefined,
      assessment: currentSlot?.assessment ?? null,
      falsePositive: currentSlot?.assessment ? currentSlot.falsePositive : false,
      revision: currentSlot?.revision ?? null,
      pending:
        currentSlot !== null &&
        (currentContribution === null || currentContribution.revision !== currentSlot.revision),
    };
  }

  async function readAggregate(actor: Actor, subjectId: string, associationId: string, deadline: number) {
    const association = await readCurrentClassificationAssociation({
      pool,
      access,
      actor,
      subjectId,
      associationId,
      action: CLASSIFICATION_BALLOT_READ_AGGREGATE,
      deadline,
    });
    if (!association) throw new ClassificationBallotNotFoundError();
    const rows = (await withReadTransaction(pool, (client) =>
      aggregateRead.run(client, {
        route: association.subjectRoute,
        subject_id: subjectId,
        association_id: associationId,
        binding_hash: Buffer.from(association.bindingHash, 'hex'),
      }),
    deadline)) as Aggregate[];
    const row = rows[0] ?? null;
    return classificationAggregateView(associationId, row);
  }

  return { set, clear, readOwn, readAggregate };
}

