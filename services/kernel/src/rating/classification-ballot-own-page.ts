import type { RatingCapabilities } from './contract/capabilities.ts';
import { ratingCapabilities } from './adapters/ambient.ts';
import type { Pool, PoolClient } from 'pg';
import {
  readAccount,
  GrantDeniedError,
  readCurrentClassificationAssociation,
  type CurrentClassificationAssociation,
  withReadTransaction,
  readSubjectSummaryObservation,
  type SubjectSummary,
} from './dependencies.ts';

import { AccessUnavailableError, CommandUnavailableError } from '../access/unavailable.ts';
import type { KernelClock } from '../clock.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';

import { GLOBAL_CONTEXT } from '../semantic/contract/global-context.ts';

import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  CLASSIFICATION_BALLOT_READ_AGGREGATE,
  CLASSIFICATION_BALLOT_READ_OWN,
  CLASSIFICATION_BALLOT_SET,
  classificationBallotClearPrecondition,
  classificationAggregateView,
  readClassificationAggregateObservation,
  type Assessment,
} from './classification-ballot.ts';
import { classificationQualifiersDigest } from './source-classification-contract.ts';
import actorRead from './classification-ballot-own-page-actor.sql';
import selectRaw from './classification-ballot-own-page-raw.sql';
import selectSelected from './classification-ballot-own-page-selected.sql';
import selectCurrent from './classification-ballot-own-page-current.sql';
import selectContributions from './classification-ballot-own-page-contributions.sql';

export const CLASSIFICATION_BALLOT_OWN_PAGE_SIZE = 20;
export const CLASSIFICATION_BALLOT_OWN_PAGE_MAX_SELECTED = CLASSIFICATION_BALLOT_OWN_PAGE_SIZE + 1;
const MAX_RESPONSE_BYTES = 1_048_576;
const first = '00000000-0000-0000-0000-000000000000';
const digestPattern = /^[a-f0-9]{64}$/;

type Dependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  routeKey: Uint8Array;
  capabilities?: RatingCapabilities;
  clock?: KernelClock;
};
type Key = { subjectId: string; associationId: string };
type ActorState = { eligible: boolean; generation: string; tombstoned: boolean; cleanupPending: boolean };
type Slot = {
  subjectId: string;
  associationId: string;
  bindingHash: Uint8Array;
  assessment: Assessment;
  falsePositive: boolean;
  revision: string;
  eligibilityGeneration: string;
};
type Contribution = { subjectId: string; associationId: string; bindingHash: Uint8Array; revision: string };
type PageItemCommon = {
  subjectId: string;
  associationId: string;
  own: { assessment: Assessment; falsePositive: boolean; revision: string; pending: 'current' | 'pending' | 'unknown' };
  actions: {
    state: 'editable' | 'read-only' | 'withdraw-only' | 'withheld';
    readback: string | null;
    set: string | null;
    clear: string | null;
  };
};
type PageItem = PageItemCommon &
  (
    | {
        state: 'available';
        subject: { id: string; type: string; label: string | null; href: string };
        target: { id: string; type: string; label: string | null; href: string };
        association: {
          subjectId: string;
          associationId: string;
          slotId: string;
          property: string;
          targetId: string;
          contextId: typeof GLOBAL_CONTEXT;
          origin: 'global';
          release: string;
          revision: number;
          bindingHash: string;
          statementDigest: string;
          qualifiersDigest: string;
        };
        aggregate: ReturnType<typeof classificationAggregateView> | null;
      }
    | {
        state: 'withheld';
        subject: null;
        target: null;
        association: null;
        aggregate: null;
      }
  );
export type ClassificationBallotOwnPage = {
  viewer: { accountId: string };
  inventory: {
    kind: 'current-retained';
    complete: false;
    generation: string | null;
    cleanup: 'not-started' | 'pending' | 'settled';
  };
  items: PageItem[];
  traversal: 'more' | 'complete';
  next: string | null;
};

function ownerOf(actor: Actor): AccountActor {
  if (
    actor.kind !== 'account' ||
    !actor.scopes.includes(CLASSIFICATION_BALLOT_READ_OWN) ||
    routeOf(actor.accountId) === null
  )
    throw new GrantDeniedError();
  return actor;
}

function assertCurrentAccount(owner: AccountActor, row: Awaited<ReturnType<typeof readAccount>>): void {
  if (
    !row ||
    row.kind !== 'actor' ||
    row.state !== 'active' ||
    row.fenced ||
    !Number.isSafeInteger(owner.authnEpoch) ||
    owner.authnEpoch < 1 ||
    row.minimumAuthnEpoch > BigInt(owner.authnEpoch)
  )
    throw new GrantDeniedError();
}

async function currentActor(client: Pick<PoolClient, 'query'>, owner: AccountActor): Promise<ActorState | null> {
  const route = routeOf(owner.accountId)!;
  const row = await actorRead.run(client, { route, actor_id: owner.accountId });
  if (!row) return null;
  const state = row as ActorState;
  if (!state.eligible || state.tombstoned) throw new GrantDeniedError();
  return state;
}

function actorStateKey(state: ActorState | null): string {
  return state ? `${state.generation}:${state.eligible}:${state.tombstoned}:${state.cleanupPending}` : 'none';
}

function keyOf(slot: Key): string {
  return `${slot.subjectId}:${slot.associationId}`;
}

function validateKey(key: Key): void {
  const subjectRoute = routeOf(key.subjectId);
  if (subjectRoute === null || routeOf(key.associationId) !== subjectRoute) throw new ProblemError('invalid_request');
}

function validateSlot(row: Slot): void {
  validateKey(row);
  if (row.bindingHash.byteLength !== 32) throw new Error('Invalid ballot binding');
  if (row.assessment !== 'support' && row.assessment !== 'oppose') throw new Error('Invalid current ballot assessment');
  if (!/^[1-9][0-9]*$/.test(row.revision)) throw new Error('Invalid current ballot revision');
}

function sameAssociation(a: CurrentClassificationAssociation | null, b: CurrentClassificationAssociation | null) {
  return a === null ? b === null : b !== null && a.bindingHash === b.bindingHash;
}

function actionPath(key: Key, revision?: string): string {
  const base = `/v1/subjects/${key.subjectId}/classification-associations/${key.associationId}/assessment`;
  return revision ? `${base}?expectedRevision=${revision}` : base;
}

function compactSummary(summary: SubjectSummary): { id: string; type: string; label: string | null; href: string } {
  return {
    id: summary.id,
    type: summary.type,
    label: summary.label?.value ?? null,
    href: `/v1/subjects/${summary.id}`,
  };
}

function binding(owner: AccountActor, actorState: ActorState | null, selected: Key | null): CursorBinding {
  return {
    operation: 'rating.own-classification-ballots-page',
    parameters: {
      actor: owner.accountId,
      client: owner.clientId,
      delegator: owner.requestedBy,
      authnEpoch: owner.authnEpoch,
      scopes: JSON.stringify([...owner.scopes].sort()),
      actorGeneration: actorState?.generation ?? null,
      selectedSubject: selected?.subjectId ?? null,
      selectedAssociation: selected?.associationId ?? null,
      order: 'subject-association.v1',
    },
  };
}

type Continuation = { after: Key | null; selectedShown: boolean };

function parseCursor(
  tokens: KeyRing,
  cursor: string | undefined,
  scope: CursorBinding,
  now: number,
  homeEpoch: number,
  hasSelected: boolean,
): Continuation {
  if (cursor === undefined) return { after: null, selectedShown: false };
  const decoded = decodeCursor(tokens, scope, cursor, now);
  if (!decoded.ok) throw new ProblemError('invalid_cursor');
  if (decoded.epoch !== homeEpoch) throw new ProblemError('stale_cursor');
  if (
    decoded.after.length !== (hasSelected ? 3 : 2) ||
    decoded.after.slice(0, 2).some((value) => typeof value !== 'string') ||
    (hasSelected && decoded.after[2] !== '0' && decoded.after[2] !== '1')
  )
    throw new ProblemError('invalid_cursor');
  const after = { subjectId: decoded.after[0] as string, associationId: decoded.after[1] as string };
  validateKey(after);
  return { after, selectedShown: hasSelected && decoded.after[2] === '1' };
}

async function readAccountSnapshot<T>(
  deps: Dependencies,
  owner: AccountActor,
  deadline: number,
  read: (client: PoolClient, state: ActorState | null, homeEpoch: number) => Promise<T>,
  expectedHomeEpoch?: number,
): Promise<T> {
  const actorRoute = routeOf(owner.accountId)!;
  const home = partitionOf(actorRoute)!;
  return withReadTransaction(
    deps.pool,
    async (client) => {
      const currentHome = await readPartition(client, home);
      if (!currentHome) throw new CommandUnavailableError('deadline', home);
      if (currentHome.writeState === 'moved') throw new CommandUnavailableError('moved', home, currentHome.movedTo);
      if (!Number.isSafeInteger(currentHome.epoch) || currentHome.epoch < 1)
        throw new CommandUnavailableError('contention', home);
      if (expectedHomeEpoch !== undefined && currentHome.epoch !== expectedHomeEpoch)
        throw new ProblemError('stale_cursor');
      assertCurrentAccount(owner, await readAccount(client, actorRoute, owner.accountId));
      return read(client, await currentActor(client, owner), currentHome.epoch);
    },
    deadline,
  );
}

async function associations(
  deps: Dependencies,
  owner: AccountActor,
  slots: readonly Slot[],
  action: string,
  deadline: number,
): Promise<Map<string, CurrentClassificationAssociation | null>> {
  const homes = new Map<number, Slot[]>();
  for (const slot of slots) {
    const route = routeOf(slot.subjectId)!;
    const home = partitionOf(route)!;
    homes.set(home, [...(homes.get(home) ?? []), slot]);
  }
  const result = new Map<string, CurrentClassificationAssociation | null>();
  for (const [, group] of homes) {
    const resolved = await Promise.all(
      group.map(async (slot) => {
        const association = await readCurrentClassificationAssociation({
          pool: deps.pool,
          access: deps.access,
          actor: owner,
          subjectId: slot.subjectId,
          associationId: slot.associationId,
          action,
          deadline,
        });
        return [keyOf(slot), association] as const;
      }),
    );
    for (const [key, association] of resolved) result.set(key, association);
  }
  return result;
}

async function associationRows<Input, Result>(
  deps: Dependencies,
  rows: readonly Input[],
  idOf: (row: Input) => Key,
  query: (client: Pick<PoolClient, 'query'>, route: number, keys: string) => Promise<Result[]>,
  deadline: number,
): Promise<Result[]> {
  const groups = new Map<number, Input[]>();
  for (const row of rows) {
    const route = routeOf(idOf(row).subjectId)!;
    groups.set(route, [...(groups.get(route) ?? []), row]);
  }
  const result: Result[] = [];
  for (const [route, group] of groups) {
    const home = partitionOf(route)!;
    result.push(
      ...(await withReadTransaction(
        deps.pool,
        async (client) => {
          await partitionReadClient(client, home);
          return query(client, route, JSON.stringify(group));
        },
        deadline,
      )),
    );
  }
  return result;
}

function currentSlotMap(rows: readonly Slot[]): Map<string, Slot> {
  const result = new Map<string, Slot>();
  for (const row of rows) {
    validateSlot(row);
    result.set(keyOf(row), row);
  }
  return result;
}

/** One private page over the account-home retained-slot index. Hidden associations never hydrate old labels. */
export function createClassificationBallotOwnPageReader(deps: Dependencies) {
  return {
    async page(
      actor: Actor,
      input: { cursor?: string; selected?: Key },
      deadline: number,
    ): Promise<ClassificationBallotOwnPage> {
      const owner = ownerOf(actor);
      const actorRoute = routeOf(owner.accountId)!;
      const now = () => ratingCapabilities(deps).clock().getTime();
      const selected = input.selected ?? null;
      if (selected) validateKey(selected);
      const initial = await readAccountSnapshot(deps, owner, deadline, async (_client, state, homeEpoch) => ({
        state,
        homeEpoch,
      }));
      const initialState = initial.state;
      const initialHomeEpoch = initial.homeEpoch;
      const scope = binding(owner, initialState, selected);
      const continuation = parseCursor(deps.tokens, input.cursor, scope, now(), initialHomeEpoch, selected !== null);

      // Read the raw selection and continuation together so sparse visibility can never move its frontier.
      const pageResult = await readAccountSnapshot(
        deps,
        owner,
        deadline,
        async (client, state) => {
          if (actorStateKey(state) !== actorStateKey(initialState)) throw new AccessUnavailableError('contention');
          if (!state)
            return {
              raw: [],
              selectedSlot: null,
              selectedShown: continuation.selectedShown,
              hasMore: false,
            };
          const selectedSlot =
            selected && !continuation.selectedShown
              ? await selectSelected.run(client, {
                  route: actorRoute,
                  actor_id: owner.accountId,
                  subject_id: selected.subjectId,
                  association_id: selected.associationId,
                  generation: state.generation,
                })
              : null;
          const rawRows = await selectRaw.run(client, {
            route: actorRoute,
            actor_id: owner.accountId,
            generation: state.generation,
            after_subject: continuation.after?.subjectId ?? first,
            after_association: continuation.after?.associationId ?? first,
            selected_subject: selected && (continuation.selectedShown || selectedSlot) ? selected.subjectId : null,
            selected_association:
              selected && (continuation.selectedShown || selectedSlot) ? selected.associationId : null,
          });
          const rawPage = rawRows.slice(0, CLASSIFICATION_BALLOT_OWN_PAGE_SIZE);
          return {
            raw: rawPage,
            selectedSlot,
            selectedShown: continuation.selectedShown || selectedSlot !== null,
            hasMore: rawRows.length > rawPage.length,
          };
        },
        initialHomeEpoch,
      );
      const rawSlots = pageResult.raw;
      const seedSlots = [...(pageResult.selectedSlot ? [pageResult.selectedSlot] : []), ...rawSlots];
      for (const slot of seedSlots) validateSlot(slot);

      if (!seedSlots.length) {
        await readAccountSnapshot(
          deps,
          owner,
          deadline,
          async (_client, state) => {
            if (actorStateKey(state) !== actorStateKey(initialState)) throw new AccessUnavailableError('contention');
          },
          initialHomeEpoch,
        );
        return {
          viewer: { accountId: owner.accountId },
          inventory: {
            kind: 'current-retained',
            complete: false,
            generation: initialState?.generation ?? null,
            cleanup: initialState ? (initialState.cleanupPending ? 'pending' : 'settled') : 'not-started',
          },
          items: [],
          traversal: 'complete',
          next: null,
        };
      }

      const initialAssociations = await associations(deps, owner, seedSlots, CLASSIFICATION_BALLOT_READ_OWN, deadline);
      const readableSlots = seedSlots.filter((slot) => initialAssociations.get(keyOf(slot)) !== null);
      const setAssociations = owner.scopes.includes(CLASSIFICATION_BALLOT_SET)
        ? await associations(deps, owner, seedSlots, CLASSIFICATION_BALLOT_SET, deadline)
        : new Map<string, CurrentClassificationAssociation | null>();
      const aggregateAssociations = owner.scopes.includes(CLASSIFICATION_BALLOT_READ_AGGREGATE)
        ? await associations(deps, owner, readableSlots, CLASSIFICATION_BALLOT_READ_AGGREGATE, deadline)
        : new Map<string, CurrentClassificationAssociation | null>();

      const readable = readableSlots.filter((slot) => {
        const key = keyOf(slot);
        const association = initialAssociations.get(key)!;
        if (Buffer.from(slot.bindingHash).toString('hex') !== association.bindingHash) return false;
        for (const current of [setAssociations.get(key), aggregateAssociations.get(key)])
          if (current && current.bindingHash !== association.bindingHash)
            throw new AccessUnavailableError('contention');
        return true;
      });
      const summaries = readSubjectSummaryObservation(
        { pool: deps.pool, routeKey: deps.routeKey, access: deps.access, actor: owner, deadline },
        [
          ...new Set(
            readable.flatMap((slot) => {
              const association = initialAssociations.get(keyOf(slot))!;
              return [slot.subjectId, association.targetId];
            }),
          ),
        ],
      );
      const summaryObservation = await summaries;
      const summaryById = summaryObservation.summaries;

      const contributionInputs = readable.map((slot) => ({
        subjectId: slot.subjectId,
        associationId: slot.associationId,
        binding_hash: Buffer.from(slot.bindingHash).toString('hex'),
      }));
      const contributionRows = await associationRows(
        deps,
        contributionInputs,
        (row) => row,
        (client, route, keys) =>
          selectContributions.run(client, {
            route,
            keys,
            actor_route: actorRoute,
            actor_id: owner.accountId,
          }),
        deadline,
      );
      const contributionByKey = new Map(contributionRows.map((row): [string, Contribution] => [keyOf(row), row]));

      const aggregateInputs = readable
        .filter(
          (slot) =>
            aggregateAssociations.get(keyOf(slot))?.bindingHash === initialAssociations.get(keyOf(slot))?.bindingHash,
        )
        .map((slot) => ({
          subjectId: slot.subjectId,
          associationId: slot.associationId,
          binding_hash: Buffer.from(slot.bindingHash).toString('hex'),
        }));
      const aggregateObservations = new Map<
        string,
        Awaited<ReturnType<typeof readClassificationAggregateObservation>>
      >();
      for (const input of aggregateInputs) {
        const association = aggregateAssociations.get(keyOf(input))!;
        aggregateObservations.set(
          keyOf(input),
          await readClassificationAggregateObservation(deps.pool, association, deadline),
        );
      }

      const finalAssociations = await associations(deps, owner, seedSlots, CLASSIFICATION_BALLOT_READ_OWN, deadline);
      const finalSetAssociations = owner.scopes.includes(CLASSIFICATION_BALLOT_SET)
        ? await associations(deps, owner, seedSlots, CLASSIFICATION_BALLOT_SET, deadline)
        : new Map<string, CurrentClassificationAssociation | null>();
      const finalAggregateAssociations = owner.scopes.includes(CLASSIFICATION_BALLOT_READ_AGGREGATE)
        ? await associations(deps, owner, readableSlots, CLASSIFICATION_BALLOT_READ_AGGREGATE, deadline)
        : new Map<string, CurrentClassificationAssociation | null>();
      for (const slot of seedSlots) {
        const key = keyOf(slot);
        if (!sameAssociation(initialAssociations.get(key) ?? null, finalAssociations.get(key) ?? null))
          throw new AccessUnavailableError('contention');
        if (
          owner.scopes.includes(CLASSIFICATION_BALLOT_SET) &&
          !sameAssociation(setAssociations.get(key) ?? null, finalSetAssociations.get(key) ?? null)
        )
          throw new AccessUnavailableError('contention');
        if (readableSlots.includes(slot)) {
          if (!sameAssociation(aggregateAssociations.get(key) ?? null, finalAggregateAssociations.get(key) ?? null))
            throw new AccessUnavailableError('contention');
        }
      }
      if (!(await summaryObservation.current())) throw new AccessUnavailableError('contention');

      const finalSlots = await readAccountSnapshot(
        deps,
        owner,
        deadline,
        async (client, state) => {
          if (actorStateKey(state) !== actorStateKey(initialState)) throw new AccessUnavailableError('contention');
          if (!state) return [];
          return selectCurrent.run(client, {
            route: actorRoute,
            actor_id: owner.accountId,
            generation: state.generation,
            keys: JSON.stringify(
              seedSlots.map(({ subjectId, associationId }) => ({
                subject_id: subjectId,
                association_id: associationId,
              })),
            ),
          });
        },
        initialHomeEpoch,
      );
      const currentSlots = currentSlotMap(finalSlots);
      const items: PageItem[] = [];
      for (const selectedSlot of seedSlots) {
        const key = keyOf(selectedSlot);
        const slot = currentSlots.get(key);
        if (!slot) continue;
        const observedAssociation = initialAssociations.get(key) ?? null;
        const current =
          observedAssociation && Buffer.from(slot.bindingHash).toString('hex') === observedAssociation.bindingHash
            ? observedAssociation
            : null;
        const clearPreparation = finalSetAssociations.get(key) ?? null;
        const visibleBindingMismatch = observedAssociation !== null && current === null;
        const canClear =
          owner.scopes.includes(CLASSIFICATION_BALLOT_SET) &&
          !visibleBindingMismatch &&
          classificationBallotClearPrecondition(slot.bindingHash, clearPreparation);
        const canSet = current !== null && finalSetAssociations.get(key)?.bindingHash === current.bindingHash;
        const path = actionPath(selectedSlot, slot.revision);
        const readback = current ? actionPath(selectedSlot) : null;
        const actions = {
          state: current
            ? canSet && canClear
              ? ('editable' as const)
              : canClear
                ? ('withdraw-only' as const)
                : ('read-only' as const)
            : canClear
              ? ('withdraw-only' as const)
              : ('withheld' as const),
          readback,
          set: canSet ? path : null,
          clear: canClear ? path : null,
        };
        const contribution = contributionByKey.get(key);
        const pending = current
          ? contribution?.revision === slot.revision &&
            Buffer.from(contribution.bindingHash).toString('hex') === Buffer.from(slot.bindingHash).toString('hex')
            ? ('current' as const)
            : ('pending' as const)
          : ('unknown' as const);
        if (!current) {
          if (!canClear && !visibleBindingMismatch) continue;
          items.push({
            state: 'withheld',
            subjectId: slot.subjectId,
            associationId: slot.associationId,
            subject: null,
            target: null,
            association: null,
            own: { assessment: slot.assessment, falsePositive: slot.falsePositive, revision: slot.revision, pending },
            aggregate: null,
            actions,
          });
          continue;
        }
        const subjectSummary = summaryById.get(slot.subjectId) ?? null;
        const targetSummary = summaryById.get(current.targetId) ?? null;
        if (!subjectSummary || !targetSummary) {
          if (!canClear) continue;
          items.push({
            state: 'withheld',
            subjectId: slot.subjectId,
            associationId: slot.associationId,
            subject: null,
            target: null,
            association: null,
            own: { assessment: slot.assessment, falsePositive: slot.falsePositive, revision: slot.revision, pending },
            aggregate: null,
            actions: { ...actions, state: canClear ? 'withdraw-only' : 'withheld', readback: null, set: null },
          });
          continue;
        }
        const associationIdentity = {
          subjectId: current.subjectId,
          associationId: current.associationId,
          slotId: current.slotId,
          property: current.property,
          targetId: current.targetId,
          contextId: current.contextId,
          origin: 'global' as const,
          release: current.release,
          revision: current.revision,
          bindingHash: current.bindingHash,
          statementDigest: current.statementDigest,
          qualifiersDigest: classificationQualifiersDigest(
            current.qualifiers as Parameters<typeof classificationQualifiersDigest>[0],
          ),
        };
        if (
          ![
            associationIdentity.bindingHash,
            associationIdentity.statementDigest,
            associationIdentity.qualifiersDigest,
          ].every((value) => digestPattern.test(value))
        )
          throw new Error('Invalid current classification association digest');
        const aggregateAllowed = aggregateAssociations.get(key)?.bindingHash === current.bindingHash;
        const aggregate = aggregateAllowed ? (aggregateObservations.get(key)?.value ?? null) : null;
        items.push({
          state: 'available',
          subjectId: slot.subjectId,
          associationId: slot.associationId,
          subject: compactSummary(subjectSummary),
          target: compactSummary(targetSummary),
          association: associationIdentity,
          own: { assessment: slot.assessment, falsePositive: slot.falsePositive, revision: slot.revision, pending },
          aggregate,
          actions,
        });
      }

      for (const observation of aggregateObservations.values()) {
        if (!(await observation.current())) throw new AccessUnavailableError('contention');
      }
      const last = rawSlots.at(-1);
      const next =
        pageResult.hasMore && last
          ? encodeCursor(
              deps.tokens,
              scope,
              {
                epoch: initialHomeEpoch,
                after: selected
                  ? [last.subjectId, last.associationId, pageResult.selectedShown ? '1' : '0']
                  : [last.subjectId, last.associationId],
              },
              now(),
            )
          : null;
      const response: ClassificationBallotOwnPage = {
        viewer: { accountId: owner.accountId },
        inventory: {
          kind: 'current-retained',
          complete: false,
          generation: initialState?.generation ?? null,
          cleanup: initialState ? (initialState.cleanupPending ? 'pending' : 'settled') : 'not-started',
        },
        items,
        traversal: next ? 'more' : 'complete',
        next,
      };
      if (Buffer.byteLength(JSON.stringify(response)) > MAX_RESPONSE_BYTES)
        throw new AccessUnavailableError('overloaded');
      return response;
    },
  };
}
