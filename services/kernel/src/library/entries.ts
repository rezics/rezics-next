import type { Pool, PoolClient } from 'pg';
import canonicalize from 'canonicalize';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  authoritativeTimeValue,
  CommandUnavailableError,
  mintReadTime,
  releaseOperationalTime,
  type CommandEvent,
  type CommandTransaction,
  type AuthoritativeTime,
} from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  createLibraryCommandRunner,
  LibraryNotFoundError,
  requireRoute,
  WORK_STEP_DEADLINE_MS,
} from './command-support.ts';
import { createShelfHeads } from './shelf-heads.ts';
import { createShelfCounters } from './shelf-counters.ts';
import { createShelfTypeKeys, type ShelfTypeDigest } from './shelf-type-keys.ts';
import { createTypePreparationPorts } from './type-preparation-contract.ts';
import type { PreparedType } from './type-preparation-contract.ts';
import { observePreparationSource, observePreparationIdentity } from './preparation-source.ts';
import { enterShelfWrite } from './shelf-counter-owner.ts';
import placement from './shelf-counter-placement.sql';
import type { Entry, EntryState, EntryDeletion } from './entry-model.ts';
import * as store from './entry-store.ts';
import entryPage from './entry-store-entry-page.sql';
import { createFollowCommands } from './follows.ts';
import { resolveSubject } from './subject-anchor.ts';
import { assertPreProfileLibraryRead, readLibraryProfileSourceObservation } from './profile-source.ts';
import { hasEntryState } from './profile.ts';
import { allocateOwnerWriteSeq } from './owner-write-sequence.ts';
import stampOwnerSequence from './entry-owner-write-sequence.sql';
import { admitEntryAttempt } from './entry-lifecycle.ts';
import { prepareEntryRestoration } from './entry-restore-preparation.ts';
import { retainEntryDeletion, restoreRetainedEntryDeletion } from './entry-retention-store.ts';
import stampLegacyIncarnation from './entry-legacy-incarnation-stamp.sql';
import restoreState from './entry-restore-state.sql';
import mutationState from './entry-mutation-state.sql';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import {
  captureEntryStateChange,
  pageEntryStateChanges,
  readEntryStateChange,
  type EntryStateChangeRow,
} from './entry-state-history.ts';

type Dependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock?: KernelClock;
  shelfTypeDigest?: ShelfTypeDigest;
  typeSourceObserved?: import('./type-preparation-contract.ts').TypePreparationSourceObserved;
};
export type ReviewedEntrySource = {
  release: string;
  epoch: string;
  acceptingType: string;
  importFence?: { id: string; row: number; version: string };
  binding?: { subject: string; route: number; source: string; externalId: string };
};

type PutEntryInput = { state: EntryState; revision?: number; incarnationId?: string };
type ListEntryOptions = { state?: EntryState; cursor?: string; limit?: number };
type EntryStateHistoryOptions = { cursor?: string; limit?: number };
type QueryClient = Pick<PoolClient, 'query'>;
type EntryPageRow = Awaited<ReturnType<typeof entryPage.run>>[number];
type StoredEntryStateChange = NonNullable<EntryStateChangeRow>;

const STATE_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const UPDATED_EVENT = 'com.rezics.library.entry.updated.v1';
const DELETED_EVENT = 'com.rezics.library.entry.deleted.v1';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_STATE_HISTORY_PAGE_SIZE = 50;

export class LibraryEntryInvalidError extends TypeError {
  constructor(message = 'Unknown library entry state') {
    super(message);
    this.name = 'LibraryEntryInvalidError';
  }
}

/** Unwinds the owner checkout before the independently committed preparation command. */
class TypePreparationRequired extends Error {}

export class LibraryConflictError extends Error {
  constructor() {
    super('Library entry revision conflicts');
    this.name = 'LibraryConflictError';
  }
}

export class LibraryEntryLifecycleConflictError extends LibraryConflictError {
  constructor(readonly reason: 'stale' | 'occupied' | 'expired') {
    super();
  }
}

export class LibraryEntryStateRestoreConflictError extends LibraryConflictError {
  constructor(readonly reason: 'stale' | 'unavailable' | 'unchanged') {
    super();
    this.name = 'LibraryEntryStateRestoreConflictError';
  }
}

function account(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action))
    throw new GrantDeniedError();
  return actor;
}

function state(value: unknown): EntryState {
  if (typeof value !== 'string' || STATE_ID.exec(value)?.[0] !== value) throw new LibraryEntryInvalidError();
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= 2_147_483_647)
    throw new RangeError('Entry revision must be a positive PostgreSQL integer');
  return value;
}

function incarnationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(value)?.[0] !== value
  )
    throw new LibraryEntryInvalidError('Entry incarnation must be a UUID');
  return value;
}

function putInput(input: unknown): PutEntryInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('Library entry input must be an object');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'state' && key !== 'revision' && key !== 'incarnationId'))
    throw new TypeError('Library entry input contains an unknown field');
  const parsed: PutEntryInput = { state: state(value.state) };
  if (value.revision !== undefined) parsed.revision = revision(value.revision);
  if (value.incarnationId !== undefined) {
    if (parsed.revision === undefined) throw new LibraryEntryInvalidError('Entry incarnation requires a revision');
    parsed.incarnationId = incarnationId(value.incarnationId);
  }
  return parsed;
}

function entryEvent(type: string, accountId: string, subjectId: string): CommandEvent {
  return { type, subject: accountId, data: { subjectId } };
}

function asState(value: string): EntryState {
  return value;
}

function asEntry(row: EntryPageRow): Entry {
  return {
    accountId: row.accountId,
    subjectId: row.subjectId,
    requestedSubjectId: row.requestedSubjectId,
    incarnationId: row.incarnationId,
    state: asState(row.state),
    revision: row.revision,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    transactionId: row.transactionId,
  };
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    (!('constraint' in error) || error.constraint === 'entry_pkey')
  );
}

function validAfter(keys: CursorKey[]): keys is [string, string] {
  return (
    keys.length === 2 &&
    typeof keys[0] === 'string' &&
    Number.isFinite(Date.parse(keys[0])) &&
    typeof keys[1] === 'string' &&
    routeOf(keys[1]) !== null
  );
}

function binding(owner: AccountActor, selectedState: EntryState | null): CursorBinding {
  return {
    operation: 'library_entry.list',
    parameters: { accountId: owner.accountId, state: selectedState },
  };
}

function stateHistoryBinding(
  owner: AccountActor,
  subjectId: string,
  incarnation: string,
  limit: number,
): CursorBinding {
  return {
    operation: 'library_entry.state_history',
    parameters: { accountId: owner.accountId, subjectId, incarnation, limit },
  };
}

function validStateHistoryAfter(keys: CursorKey[]): keys is [string, string, string] {
  return (
    keys.length === 3 &&
    typeof keys[0] === 'string' &&
    /^[1-9][0-9]*$/.test(keys[0]) &&
    Number(keys[0]) < 2_147_483_647 &&
    typeof keys[1] === 'string' &&
    /^[1-9][0-9]*$/.test(keys[1]) &&
    Number(keys[1]) < 2_147_483_647 &&
    (keys[2] === 'complete' || keys[2] === 'partial')
  );
}

type EntryStateCommandKind = 'library.entry.put' | 'library.entry.state.restore';

function stateChangeView(
  change: Pick<StoredEntryStateChange, 'revision' | 'priorRevision' | 'beforeState' | 'afterState' | 'commandId' | 'commandKind' | 'changedAt'>,
) {
  return {
    revision: change.revision,
    priorRevision: change.priorRevision,
    beforeState: change.beforeState,
    afterState: change.afterState,
    commandId: change.commandId,
    commandKind: change.commandKind as EntryStateCommandKind,
    changedAt: new Date(change.changedAt).toISOString(),
  };
}

/** Ordinary deletion transition, on the caller's authorized native owner transaction. */
export async function deleteLibraryEntryInTransaction(
  tx: CommandTransaction,
  command: { transactionId: string; time: AuthoritativeTime },
  owner: AccountActor,
  subjectId: string,
  expected: number,
  guard?: string,
): Promise<{ value: EntryDeletion; events: readonly CommandEvent[] }> {
  const route = requireRoute(owner.accountId);
  const write = { client: tx, route, accountId: owner.accountId };
  const gate = await enterShelfWrite(write);
  await createShelfHeads().ensure(write, subjectId);
  const current = await mutationState.run(tx, {
    route,
    account_id: owner.accountId,
    subject_id: subjectId,
  });
  if (!current) throw new LibraryNotFoundError();
  if (
    current.revision !== expected ||
    expected > 2_147_483_644 ||
    (current.incarnationId != null && guard === undefined) ||
    (guard !== undefined && current.incarnationId !== guard)
  )
    throw new LibraryEntryLifecycleConflictError('stale');
  let incarnation = current.incarnationId;
  if (incarnation == null) {
    incarnation = newId(route);
    const stamped = await stampLegacyIncarnation.run(tx, {
      route,
      account_id: owner.accountId,
      subject_id: subjectId,
      revision: expected,
      transaction_id: current.transactionId,
      incarnation_id: incarnation,
    });
    if (stamped?.incarnationId !== incarnation) throw new LibraryEntryLifecycleConflictError('stale');
  }
  await allocateOwnerWriteSeq(tx, owner.accountId);
  const removed = await retainEntryDeletion(
    tx,
    { route, accountId: owner.accountId, subjectId, revision: expected, incarnationId: incarnation },
    { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
  );
  if (!removed) throw new LibraryEntryLifecycleConflictError('stale');
  if (gate.ready && !removed.typeId) throw new Error('Complete shelf deletion is missing its type');
  await createShelfCounters().transition(
    write,
    removed.typeId ? { state: removed.state, typeId: removed.typeId } : null,
    null,
  );
  return {
    value: { deletionId: removed.deletionId, revision: removed.deletedRevision, restoreUntil: removed.restoreUntil },
    events: [entryEvent(DELETED_EVENT, owner.accountId, subjectId)],
  };
}

/** Private account library entry writes and signed, account-scoped keyset reads. */
export function createEntryCommands(config: Dependencies) {
  const { pool, access, tokens, clock } = config;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });
  const heads = createShelfHeads(),
    counters = createShelfCounters();
  const types = createTypePreparationPorts({
    ...config,
    keys: createShelfTypeKeys(config.shelfTypeDigest === undefined ? undefined : { digest: config.shelfTypeDigest }),
    observe: (id) => observePreparationSource(config, id),
    observeIdentity: (id) => observePreparationIdentity(config, id),
  });
  const follows = createFollowCommands({ pool, access, ...(clock === undefined ? {} : { clock }) });

  async function admit(client: QueryClient, owner: AccountActor): Promise<number> {
    const route = requireRoute(owner.accountId);
    const current = await readAccount(client, route, owner.accountId);
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
    return route;
  }

  async function snapshot<T>(
    actor: Actor,
    action: string,
    body: (client: QueryClient, owner: AccountActor, route: number) => Promise<T>,
  ) {
    const owner = account(actor, action);
    requireRoute(owner.accountId);
    return withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const admittedRoute = await admit(client, owner);
        const value = await body(client, owner, admittedRoute);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function historicalStateAdmitted(owner: AccountActor, subjectId: string, historicalState: string) {
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    const time = await withConnection(pool, (client) => mintReadTime(client, clock));
    try {
      const observation = await readLibraryProfileSourceObservation(
        { pool, access, actor: owner, at: time, deadline },
        subjectId,
      );
      const source = observation?.source;
      return Boolean(
        source &&
          source.kind === 'supported' &&
          source.subjectId === subjectId &&
          hasEntryState(source.profile, historicalState),
      );
    } finally {
      releaseOperationalTime(time);
    }
  }

  async function putEntry(
    actor: Actor,
    subjectId: string,
    input: unknown,
    requestKey: string,
    guard?:
      | import('./list-import-bangumi-model.ts').BangumiGuard
      | ReviewedEntrySource
      | { subjectId: string; pin: unknown; epoch: string },
  ) {
    const reviewedSource = guard && 'release' in guard ? guard : undefined;
    const reviewGuard = guard && 'releaseDigest' in guard ? guard : undefined;
    const review = guard && 'pin' in guard ? guard : undefined;
    const owner = account(actor, 'library_entry:update');
    const parsed = putInput(input);
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    requireRoute(owner.accountId);
    requireRoute(subjectId);
    const existing = await snapshot(actor, 'library_entry:update', (client, accountOwner, route) =>
      store.readEntry(client, route, accountOwner.accountId, subjectId),
    );
    // Preserve the existing normalized receipt input. A missing current source must
    // reach owner authorization and receipt lookup before fresh admission fails.
    // Reviewed imports bind a canonical operand; receipt retries must never follow a new alias.
    const resolved =
      reviewedSource || review
        ? { subjectId, requestedSubjectId: null }
        : existing
          ? { subjectId, requestedSubjectId: existing.requestedSubjectId }
          : ((await resolveSubject({ pool, access }, owner, subjectId).catch(() => null)) ?? {
              subjectId,
              requestedSubjectId: null,
            });

    // Absence retains the exact pre-incarnation receipt input.
    const requestInput = {
      ...(reviewedSource ? { reviewedSource } : {}),
      subjectId: resolved.subjectId,
      requestedSubjectId: resolved.requestedSubjectId,
      state: parsed.state,
      ...(reviewGuard === undefined ? {} : { reviewGuard }),
      revision: parsed.revision ?? null,
      ...(parsed.incarnationId === undefined ? {} : { incarnationId: parsed.incarnationId }),
      ...(review === undefined ? {} : { importReview: review }),
    };
    const expectedRevision = parsed.revision;
    let preparedType: PreparedType | undefined;
    const execute = () =>
      runner.ownAccountPrepared(
        actor,
        {
          action: 'library_entry:update',
          kind: 'library.entry.put',
          requestKey,
          input: requestInput,
          async prepare(attempt) {
            try {
              const observation = await readLibraryProfileSourceObservation(
                { pool, access, actor: owner, at: attempt.time, deadline },
                subjectId,
              );
              const source = observation?.source;
              if (reviewedSource) {
                if (
                  !observation ||
                  source?.kind !== 'supported' ||
                  source.subjectId !== subjectId ||
                  source.pin.releaseDigest !== reviewedSource.release ||
                  observation.anchor.identityEpoch.toString() !== reviewedSource.epoch ||
                  observation.anchor.acceptingType !== reviewedSource.acceptingType
                )
                  throw new LibraryConflictError();
                if (reviewedSource.binding) {
                  const b = reviewedSource.binding;
                  const claim = await pool.query<{ subject_id: string }>(
                    'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
                    [b.route, b.source, b.externalId],
                  );
                  if (claim.rows[0]?.subject_id !== b.subject) throw new LibraryConflictError();
                }
              }
              if (
                review &&
                (!observation ||
                  source?.kind !== 'supported' ||
                  source.subjectId !== review.subjectId ||
                  String(observation.anchor.identityEpoch) !== review.epoch ||
                  canonicalize(source.pin) !== canonicalize(review.pin))
              )
                throw new LibraryConflictError();
              if (!source) throw new LibraryNotFoundError();
              if (
                reviewGuard &&
                (source.subjectId !== reviewGuard.subjectId ||
                  source.kind !== 'supported' ||
                  source.pin.releaseDigest !== reviewGuard.releaseDigest ||
                  String(observation!.anchor.identityEpoch) !== reviewGuard.identityEpoch)
              )
                throw new LibraryConflictError();
              if (source.kind !== 'supported' || !hasEntryState(source.profile, parsed.state))
                throw new ProblemError('unsupported_library_profile');
              if (preparedType) {
                if ((await types.revalidate(owner, preparedType)) !== 'current')
                  throw new CommandUnavailableError('contention', partitionOf(requireRoute(owner.accountId)));
              }
              return {
                preparedType,
                source,
              };
            } catch (error) {
              return { error };
            }
          },
        },
        async (tx, command, prepared) => {
          const route = requireRoute(owner.accountId);
          const write = { client: tx, route, accountId: owner.accountId };
          const gate = await enterShelfWrite(write);
          const head = await heads.ensure(write, resolved.subjectId);
          const before = await placement.run(tx, {
            route,
            account_id: owner.accountId,
            subject_id: resolved.subjectId,
          });
          let previous: Awaited<ReturnType<typeof mutationState.run>> = null;
          let updateIncarnationId = parsed.incarnationId;
          if (expectedRevision !== undefined) {
            // This exact locked row is the cutover evidence. Receipt replay has
            // already returned, and a concurrent stamp/replacement cannot race admission.
            const current = await mutationState.run(tx, {
              route,
              account_id: owner.accountId,
              subject_id: resolved.subjectId,
            });
            if (
              !current ||
              current.revision !== expectedRevision ||
              (current.incarnationId != null && parsed.incarnationId === undefined) ||
              (parsed.incarnationId !== undefined && current.incarnationId !== parsed.incarnationId)
            )
              throw new LibraryConflictError();
            let currentIncarnation = current.incarnationId;
            if (currentIncarnation == null) {
              currentIncarnation = newId(route);
              const stamped = await stampLegacyIncarnation.run(tx, {
                route,
                account_id: owner.accountId,
                subject_id: resolved.subjectId,
                revision: expectedRevision,
                transaction_id: current.transactionId,
                incarnation_id: currentIncarnation,
              });
              if (stamped?.incarnationId !== currentIncarnation) throw new LibraryConflictError();
            }
            previous = { ...current, incarnationId: currentIncarnation };
            updateIncarnationId = currentIncarnation;
          }
          if (reviewedSource?.importFence) {
            const fence = reviewedSource.importFence;
            // Serialize fresh admission with cancellation/deletion on the same owner home.
            // Original receipt replay has already returned before this fresh-command fence.
            const admitted = await tx.query(
              `SELECT id FROM library.list_import_mal
              WHERE route=$1 AND account_id=$2 AND id=$3 AND expires_at>clock_timestamp()
                AND NOT (document->>'canceled')::boolean
                AND document->'intents'->$4::text->'review'->>'version'=$5 FOR SHARE`,
              [route, owner.accountId, fence.id, String(fence.row), fence.version],
            );
            if (!admitted.rows.length) throw new LibraryConflictError();
          }
          if ('error' in prepared) throw prepared.error;
          const source = prepared.source;
          if (!source || (!existing && source.subjectId !== resolved.subjectId)) throw new LibraryNotFoundError();
          if (source.kind !== 'supported' || !hasEntryState(source.profile, parsed.state))
            throw new ProblemError('unsupported_library_profile');
          if (expectedRevision === undefined) {
            if (before) throw new LibraryConflictError();
            // Core has already authorized and checked the ordinary command receipt.
            // Replays, conflicting bodies and invalid requests never start metadata work.
            if (!prepared.preparedType) throw new TypePreparationRequired();
          }
          const acceptedType = prepared.preparedType ? await types.consume(tx, prepared.preparedType) : null;
          if (expectedRevision === undefined && acceptedType?.status !== 'ready')
            throw new CommandUnavailableError('contention', partitionOf(route));
          const seq = await allocateOwnerWriteSeq(tx, owner.accountId);
          const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
          let entry: Entry;
          if (expectedRevision === undefined) {
            entry = await store.insertEntry(
              tx,
              route,
              {
                accountId: owner.accountId,
                subjectId: resolved.subjectId,
                requestedSubjectId: resolved.requestedSubjectId,
                state: parsed.state,
              },
              context,
              source.pin,
              { head, ...(acceptedType?.status === 'ready' ? { type: acceptedType } : {}) },
            );
          } else {
            const changed = await store.updateEntryState(
              tx,
              route,
              owner.accountId,
              resolved.subjectId,
              expectedRevision,
              parsed.state,
              context,
              source.pin,
              updateIncarnationId,
            );
            if (!changed) throw new LibraryConflictError();
            entry = changed;
          }

          const incarnation = entry.incarnationId;
          if (!incarnation) throw new Error('Library entry mutation did not retain its incarnation');
          if (
            !previous ||
            previous.state !== entry.state ||
            canonicalize(previous.libraryProfilePin) !== canonicalize(source.pin)
          )
            await captureEntryStateChange(tx, {
              route,
              accountId: owner.accountId,
              subjectId: entry.subjectId,
              incarnationId: incarnation,
              priorRevision: previous?.revision ?? null,
              revision: entry.revision,
              beforeState: previous?.state ?? null,
              beforeProfilePin: previous?.libraryProfilePin ?? null,
              afterState: entry.state,
              afterProfilePin: source.pin,
              commandId: command.transactionId,
              commandKind: 'library.entry.put',
              changedAt: context.time,
            });

          const typeId = acceptedType?.status === 'ready' ? acceptedType.typeId : before?.typeId;
          if (gate.ready && (!typeId || (before && !before.typeId)))
            throw new Error('Complete shelf placement is missing a type');
          await counters.transition(
            write,
            before?.typeId ? { state: before.state, typeId: before.typeId } : null,
            typeId ? { state: entry.state, typeId } : null,
          );
          const stamped = await stampOwnerSequence.run(tx, {
            route,
            account_id: owner.accountId,
            subject_id: entry.subjectId,
            revision: entry.revision,
            transaction_id: command.transactionId,
            seq,
          });
          if (stamped.length !== 1) throw new Error('Library entry owner sequence stamp failed');
          const events = [entryEvent(UPDATED_EVENT, owner.accountId, entry.subjectId)];
          if (entry.state === 'in_progress') {
            const followed = await follows.followFromLibrary(tx, route, {
              accountId: owner.accountId,
              subjectId: entry.subjectId,
              transactionId: command.transactionId,
              time: context.time,
            });
            if (followed) events.push(followed);
          }
          return { value: { entry, created: expectedRevision === undefined }, events };
        },
      );
    try {
      try {
        return await execute();
      } catch (error) {
        if (!(error instanceof TypePreparationRequired)) throw error;
      }
      const preparation = await types.prepare(owner, { subjectId, requestKey });
      if (preparation.status !== 'ready')
        throw new CommandUnavailableError('contention', partitionOf(requireRoute(owner.accountId)));
      preparedType = preparation.prepared;
      return await execute();
    } catch (error) {
      if (parsed.revision === undefined && isDuplicateEntry(error)) throw new LibraryConflictError();
      throw error;
    }
  }

  async function listEntryStateHistory(
    actor: Actor,
    subjectId: string,
    options: EntryStateHistoryOptions = {},
  ) {
    const owner = account(actor, 'library_entry:read');
    requireRoute(subjectId);
    if (typeof options !== 'object' || options === null || Array.isArray(options))
      throw new TypeError('Entry state history options must be an object');
    if (Object.keys(options).some((key) => key !== 'cursor' && key !== 'limit'))
      throw new TypeError('Entry state history options contain an unknown field');
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_STATE_HISTORY_PAGE_SIZE)
      throw new RangeError(`History page limit must be an integer from 1 to ${MAX_STATE_HISTORY_PAGE_SIZE}`);
    if (options.cursor !== undefined && (typeof options.cursor !== 'string' || options.cursor.length > 4096))
      throw new ProblemError('invalid_cursor');

    return snapshot(actor, 'library_entry:read', async (client, accountOwner, route) => {
      const current = await store.readEntry(client, route, accountOwner.accountId, subjectId);
      if (!current) throw new LibraryNotFoundError();
      if (!current.incarnationId) {
        if (options.cursor !== undefined) throw new ProblemError('stale_cursor');
        return {
          incarnationId: null,
          currentRevision: current.revision,
          changes: [],
          coverage: 'unknown' as const,
          next: null,
        };
      }
      const partition = await readPartition(client as PoolClient, partitionOf(route));
      const cursorBinding = stateHistoryBinding(accountOwner, subjectId, current.incarnationId, limit);
      let afterRevision: number | null = null;
      let cursorCoverage: 'complete' | 'partial' | null = null;
      if (options.cursor !== undefined) {
        const cursor = decodeCursor(tokens, cursorBinding, options.cursor);
        if (!cursor.ok || !validStateHistoryAfter(cursor.after)) throw new ProblemError('invalid_cursor');
        if (!partition || cursor.epoch !== partition.epoch) throw new ProblemError('stale_cursor');
        afterRevision = Number(cursor.after[0]);
        if (Number(cursor.after[1]) !== current.revision) throw new ProblemError('stale_cursor');
        cursorCoverage = cursor.after[2] as 'complete' | 'partial';
      }
      const rows = await pageEntryStateChanges(client, {
        route,
        accountId: accountOwner.accountId,
        subjectId,
        incarnationId: current.incarnationId,
        afterRevision,
        limit: limit + 1,
      });
      const changes = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = changes.at(-1);
      const coverage: 'complete' | 'partial' | 'unknown' = changes.length
        ? changes[0]!.coverageComplete
          ? ('complete' as const)
          : ('partial' as const)
        : (cursorCoverage ?? 'unknown');
      if (hasMore && !partition) throw new CommandUnavailableError('fenced', partitionOf(route));
      return {
        incarnationId: current.incarnationId,
        currentRevision: current.revision,
        changes: changes.map(stateChangeView),
        coverage,
        next:
          hasMore && last && partition
            ? encodeCursor(tokens, cursorBinding, {
                epoch: partition.epoch,
                after: [String(last.revision), String(current.revision), coverage],
              })
            : null,
      };
    });
  }

  async function reviewEntryStateChange(actor: Actor, subjectId: string, selectedRevision: number) {
    const owner = account(actor, 'library_entry:read');
    requireRoute(subjectId);
    const selected = revision(selectedRevision);
    const reviewed = await snapshot(actor, 'library_entry:read', async (client, accountOwner, route) => {
      const current = await store.readEntry(client, route, accountOwner.accountId, subjectId);
      if (!current) throw new LibraryNotFoundError();
      if (!current.incarnationId) throw new LibraryNotFoundError();
      const change = await readEntryStateChange(client, {
        route,
        accountId: accountOwner.accountId,
        subjectId,
        incarnationId: current.incarnationId,
        revision: selected,
      });
      if (!change) throw new LibraryNotFoundError();
      return { current, change };
    });
    let availability: 'available' | 'no_prior_state' | 'state_unavailable';
    if (reviewed.change.beforeState === null) availability = 'no_prior_state';
    else
      availability = (await historicalStateAdmitted(owner, subjectId, reviewed.change.beforeState))
        ? 'available'
        : 'state_unavailable';
    return {
      change: stateChangeView(reviewed.change),
      current: {
        incarnationId: reviewed.current.incarnationId ?? null,
        revision: reviewed.current.revision,
        state: reviewed.current.state,
      },
      availability,
    };
  }

  async function restoreEntryState(actor: Actor, subjectId: string, selectedRevision: number, input: unknown, requestKey: string) {
    const owner = account(actor, 'library_entry:update');
    requireRoute(subjectId);
    const selected = revision(selectedRevision);
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new TypeError('Entry state restore input must be an object');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => key !== 'incarnationId' && key !== 'currentRevision'))
      throw new TypeError('Entry state restore input contains an unknown field');
    const request = {
      subjectId,
      changeRevision: selected,
      incarnationId: incarnationId(value.incarnationId),
      currentRevision: revision(value.currentRevision),
    };
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return runner.ownAccountPrepared(
      actor,
      {
        action: 'library_entry:update',
        kind: 'library.entry.state.restore',
        requestKey,
        input: request,
        async prepare(attempt) {
          try {
            const change = await withConnection(pool, (client) =>
              readEntryStateChange(client, {
                route: requireRoute(owner.accountId),
                accountId: owner.accountId,
                subjectId,
                incarnationId: request.incarnationId,
                revision: request.changeRevision,
              }),
            );
            if (!change) throw new LibraryNotFoundError();
            if (change.beforeState === null)
              throw new LibraryEntryStateRestoreConflictError('unavailable');
            const observation = await readLibraryProfileSourceObservation(
              { pool, access, actor: owner, at: attempt.time, deadline },
              subjectId,
            );
            const source = observation?.source;
            if (
              !source ||
              source.kind !== 'supported' ||
              source.subjectId !== subjectId ||
              !hasEntryState(source.profile, change.beforeState)
            )
              throw new LibraryEntryStateRestoreConflictError('unavailable');
            return { change, source };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if ('error' in prepared) throw prepared.error;
        const route = requireRoute(owner.accountId);
        const write = { client: tx, route, accountId: owner.accountId };
        const gate = await enterShelfWrite(write);
        const head = await heads.ensure(write, subjectId);
        const before = await placement.run(tx, { route, account_id: owner.accountId, subject_id: subjectId });
        const current = await mutationState.run(tx, {
          route,
          account_id: owner.accountId,
          subject_id: subjectId,
        });
        if (!current) throw new LibraryNotFoundError();
        if (
          current.revision !== request.currentRevision ||
          current.incarnationId !== request.incarnationId
        )
          throw new LibraryEntryStateRestoreConflictError('stale');
        const change = await readEntryStateChange(tx, {
          route,
          accountId: owner.accountId,
          subjectId,
          incarnationId: request.incarnationId,
          revision: request.changeRevision,
          lock: true,
        });
        if (!change) throw new LibraryNotFoundError();
        if (change.beforeState === null || change.beforeState !== prepared.change.beforeState)
          throw new LibraryEntryStateRestoreConflictError('unavailable');
        if (
          prepared.source.subjectId !== subjectId ||
          prepared.source.kind !== 'supported' ||
          !hasEntryState(prepared.source.profile, change.beforeState)
        )
          throw new LibraryEntryStateRestoreConflictError('unavailable');
        if (
          current.state === change.beforeState &&
          canonicalize(current.libraryProfilePin) === canonicalize(prepared.source.pin)
        )
          throw new LibraryEntryStateRestoreConflictError('unchanged');
        const sequence = await allocateOwnerWriteSeq(tx, owner.accountId);
        const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
        const entry = await store.updateEntryState(
          tx,
          route,
          owner.accountId,
          subjectId,
          request.currentRevision,
          state(change.beforeState),
          context,
          prepared.source.pin,
          request.incarnationId,
        );
        if (!entry) throw new LibraryEntryStateRestoreConflictError('stale');
        const typeId = before?.typeId;
        if (gate.ready && !typeId) throw new Error('Complete shelf placement is missing a type');
        await counters.transition(
          write,
          before?.typeId ? { state: before.state, typeId: before.typeId } : null,
          typeId ? { state: entry.state, typeId } : null,
        );
        const stamped = await stampOwnerSequence.run(tx, {
          route,
          account_id: owner.accountId,
          subject_id: entry.subjectId,
          revision: entry.revision,
          transaction_id: command.transactionId,
          seq: sequence,
        });
        if (stamped.length !== 1) throw new Error('Library entry owner sequence stamp failed');
        if (
          current.state !== entry.state ||
          canonicalize(current.libraryProfilePin) !== canonicalize(prepared.source.pin)
        )
          await captureEntryStateChange(tx, {
            route,
            accountId: owner.accountId,
            subjectId: entry.subjectId,
            incarnationId: request.incarnationId,
            priorRevision: current.revision,
            revision: entry.revision,
            beforeState: current.state,
            beforeProfilePin: current.libraryProfilePin,
            afterState: entry.state,
            afterProfilePin: prepared.source.pin,
            commandId: command.transactionId,
            commandKind: 'library.entry.state.restore',
            changedAt: context.time,
          });
        return { value: { entry }, events: [entryEvent(UPDATED_EVENT, owner.accountId, entry.subjectId)] };
      },
    );
  }

  async function deleteEntry(
    actor: Actor,
    subjectId: string,
    expectedRevision: number,
    requestKey: string,
    expectedIncarnationId?: string,
  ) {
    const owner = account(actor, 'library_entry:delete');
    const expected = revision(expectedRevision);
    const guard = expectedIncarnationId === undefined ? undefined : incarnationId(expectedIncarnationId);
    requireRoute(owner.accountId);
    requireRoute(subjectId);
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return runner.ownAccountPrepared<void, Entry | { deletionId: string; revision: number }>(
      actor,
      {
        action: 'library_entry:delete',
        kind: 'library.entry.delete',
        requestKey,
        input: { subjectId, revision: expected, ...(guard === undefined ? {} : { incarnationId: guard }) },
        prepare: (attempt) => admitEntryAttempt(config, actor, 'library_entry:delete', attempt, deadline),
      },
      async (tx, command) => {
        const removed = await deleteLibraryEntryInTransaction(tx, command, owner, subjectId, expected, guard);
        return {
          value: { deletionId: removed.value.deletionId, revision: removed.value.revision },
          events: removed.events,
        };
      },
    );
  }

  async function restoreEntry(actor: Actor, subjectId: string, input: unknown, requestKey: string) {
    const owner = account(actor, 'library_entry:update');
    requireRoute(subjectId);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'deletionId' && key !== 'revision')
    )
      throw new TypeError('Entry restore input must contain only deletionId and revision');
    const value = input as Record<string, unknown>;
    const selected = { subjectId, deletionId: incarnationId(value.deletionId), revision: revision(value.revision) };
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return runner.ownAccountPrepared(
      actor,
      {
        action: 'library_entry:update',
        kind: 'library.entry.restore',
        requestKey,
        input: selected,
        prepare: (attempt) => prepareEntryRestoration(config, actor, selected, attempt, deadline),
      },
      async (tx, command, prepared) => {
        if (prepared.kind === 'deferred') throw prepared.error;
        const route = requireRoute(owner.accountId);
        const write = { client: tx, route, accountId: owner.accountId };
        const gate = await enterShelfWrite(write);
        await heads.ensure(write, subjectId);
        const locator = { route, accountId: owner.accountId, subjectId, deletionId: selected.deletionId };
        const locked = await restoreState.run(tx, {
          route,
          account_id: owner.accountId,
          subject_id: subjectId,
          deletion_id: selected.deletionId,
          time: authoritativeTimeValue(command.time),
        });
        if (!locked) throw new LibraryNotFoundError();
        const { expired, ...snapshot } = locked;
        if (
          locked.deletedRevision !== selected.revision ||
          canonicalize({ ...snapshot, libraryProfilePin: decodeLibraryProfilePin(snapshot.libraryProfilePin) }) !==
            canonicalize(prepared.deletion)
        )
          throw new LibraryEntryLifecycleConflictError('stale');
        if (expired) throw new LibraryEntryLifecycleConflictError('expired');
        const restored = await restoreRetainedEntryDeletion(
          tx,
          { ...locator, deletedRevision: selected.revision },
          { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
        );
        if (!restored) {
          if (await store.readEntry(tx, route, owner.accountId, subjectId))
            throw new LibraryEntryLifecycleConflictError('occupied');
          throw new Error('Locked retained entry could not be restored');
        }
        if (gate.ready && !restored.typeId) throw new Error('Complete shelf restoration is missing its type');
        await counters.transition(
          write,
          null,
          restored.typeId ? { state: restored.state, typeId: restored.typeId } : null,
        );
        const seq = await allocateOwnerWriteSeq(tx, owner.accountId);
        const stamped = await stampOwnerSequence.run(tx, {
          route,
          account_id: owner.accountId,
          subject_id: subjectId,
          revision: restored.revision,
          transaction_id: command.transactionId,
          seq,
        });
        if (stamped.length !== 1) throw new Error('Restored entry owner sequence stamp failed');
        const entry = await store.readEntry(tx, route, owner.accountId, subjectId);
        if (!entry) throw new Error('Restored entry is missing');
        return { value: { entry }, events: [entryEvent(UPDATED_EVENT, owner.accountId, subjectId)] };
      },
    );
  }

  async function readEntry(actor: Actor, subjectId: string): Promise<Entry> {
    const owner = account(actor, 'library_entry:read');
    requireRoute(subjectId);
    const existing = await snapshot(actor, 'library_entry:read', (client, owner, route) =>
      store.readEntry(client, route, owner.accountId, subjectId),
    );
    if (existing) return existing;

    const resolved = await resolveSubject({ pool, access }, actor, subjectId);
    if (!resolved) throw new LibraryNotFoundError();
    const entry = await snapshot(actor, 'library_entry:read', (client, owner, route) =>
      store.readEntry(client, route, owner.accountId, resolved.subjectId),
    );
    if (!entry || entry.accountId !== owner.accountId) throw new LibraryNotFoundError();
    return entry;
  }

  async function listEntries(actor: Actor, options: ListEntryOptions = {}) {
    account(actor, 'library_entry:list');
    if (typeof options !== 'object' || options === null || Array.isArray(options))
      throw new TypeError('Library entry list options must be an object');
    if (Object.keys(options).some((key) => key !== 'state' && key !== 'cursor' && key !== 'limit'))
      throw new TypeError('Library entry list options contain an unknown field');
    const selectedState = options.state === undefined ? null : state(options.state);
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
      throw new RangeError(`Page limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    if (options.cursor !== undefined && (typeof options.cursor !== 'string' || options.cursor.length > 4096))
      throw new ProblemError('invalid_cursor');

    return snapshot(actor, 'library_entry:list', async (client, accountOwner, route) => {
      const partition = await readPartition(client as PoolClient, partitionOf(route));
      const cursorBinding = binding(accountOwner, selectedState);
      let after: [string, string] | null = null;
      if (options.cursor !== undefined) {
        const cursor = decodeCursor(tokens, cursorBinding, options.cursor);
        if (!cursor.ok || !validAfter(cursor.after)) throw new ProblemError('invalid_cursor');
        if (cursor.epoch !== partition?.epoch) throw new ProblemError('stale_cursor');
        after = cursor.after;
      }
      const rows = await entryPage.run(
        { query: client.query.bind(client) },
        {
          route,
          account_id: accountOwner.accountId,
          state: selectedState,
          after_updated_at: after?.[0] ?? '2026-01-01T00:00:00.000Z',
          after_subject_id: after?.[1] ?? '00000000-0000-0000-0000-000000000000',
          has_cursor: after !== null,
          limit: limit + 1,
        },
      );
      if (rows.some((row) => row.libraryProfilePin === null)) {
        await assertPreProfileLibraryRead(client, accountOwner.accountId);
        const legacyStates = ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
        if (rows.some((row) => row.libraryProfilePin === null && !legacyStates.includes(row.state)))
          throw new Error('Invalid pre-profile entry state');
      }
      const pageRows = rows.slice(0, limit).map(asEntry);
      const hasMore = rows.length > limit;
      const last = pageRows.at(-1);
      return {
        entries: pageRows,
        next:
          hasMore && last && partition
            ? encodeCursor(tokens, cursorBinding, {
                epoch: partition.epoch,
                after: [last.updatedAt, last.subjectId],
              })
            : null,
      };
    });
  }

  return {
    putEntry: (...args: Parameters<typeof putEntry>) =>
      withRequestDeadline(deadlineFor(WORK_STEP_DEADLINE_MS), () => putEntry(...args)),
    listEntryStateHistory,
    reviewEntryStateChange,
    restoreEntryState,
    deleteEntry,
    restoreEntry,
    readEntry,
    listEntries,
  };
}
