import type { Pool, PoolClient } from 'pg';
import { isCalendarDate } from '@rezics/filter';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  createLibraryCommandRunner,
  LibraryNotFoundError,
  requireRoute,
  sameAccountRoute,
  WORK_STEP_DEADLINE_MS,
} from './command-support.ts';
import type { Copy, CopyChanges, CopyStatus } from './entry-model.ts';
import * as store from './entry-store.ts';
import { hasCopyStatus, resolveLibraryProfilePin } from './profile.ts';
import { readRelease } from '../semantic/definitions.ts';
import { admitEntryAttempt } from './entry-lifecycle.ts';
import { resolveSubject } from './subject-anchor.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import retentionRead from './copy-retention-read.sql';
import retentionRestore from './copy-retention-restore.sql';
import { readLibraryProfileSource } from './profile-source.ts';
import { deadlineClient, within as withinDeadline } from '../access/authenticate.ts';
import type { CopyPresentation } from './copy-model.ts';
import { prepareCopyPresentation } from './copy-presentation.ts';
import { prepareCopyInventory, readCopyInventoryValues } from './copy-inventory.ts';
import copyDetailRead from './copy-store-read.sql';
import {
  CopyConditionInvalidError,
  copyConditionAdmission,
  decodeCopyConditionFacts,
  mergeCopyConditionFields,
  parseCopyConditionFields,
  type CopyConditionPatch,
} from './copy-condition.ts';

const UPDATED_EVENT = 'com.rezics.library.copy.updated.v1';
const DELETED_EVENT = 'com.rezics.library.copy.deleted.v1';
const CREATE_FIELDS = [
  'subjectId',
  'kind',
  'status',
  'location',
  'source',
  'acquiredOn',
  'disposedOn',
  'note',
  'mediaCondition',
  'packagingCondition',
] as const;
const UPDATE_FIELDS = [
  'revision',
  'status',
  'location',
  'source',
  'acquiredOn',
  'disposedOn',
  'note',
  'mediaCondition',
  'packagingCondition',
] as const;
const TEXT_LIMITS = { location: 200, source: 200, note: 1000 } as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
type TextField = keyof typeof TEXT_LIMITS;
type DateField = 'acquiredOn' | 'disposedOn';
type CopyInput = {
  subjectId: string;
  kind?: string;
  status?: CopyStatus;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
} & CopyConditionPatch;
type CopyPatch = { revision: number } & Partial<CopyChanges> & CopyConditionPatch;
type PageOptions = { cursor?: string; limit?: number; subjectId?: string; kind?: string; status?: string };

export class CopyInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid copy field: ${field}`);
    this.name = 'CopyInvalidError';
  }
}

export class CopyConflictError extends Error {
  constructor() {
    super('Copy revision conflicts');
    this.name = 'CopyConflictError';
  }
}

function conditionPatch(input: Readonly<Record<string, unknown>>): CopyConditionPatch {
  try {
    return parseCopyConditionFields(input);
  } catch (error) {
    if (error instanceof CopyConditionInvalidError) throw new CopyInvalidError(error.field);
    throw error;
  }
}

function plain(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CopyInvalidError('copy');
  return value as Record<string, unknown>;
}

function unexpected(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const permit = new Set<string>(allowed);
  let found: string | null = null;
  for (const key of Object.keys(value)) {
    if (permit.has(key)) continue;
    if (found === null || key < found) found = key;
  }
  return found;
}

function within(value: string, max: number): boolean {
  if (value.length <= max) return true;
  if (value.length > max * 2) return false;
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > max) return false;
  }
  return true;
}

/** Calendar date `YYYY-MM-DD`. PostgreSQL `char_length` and date checks reject the same bounds. */
function isoDate(value: string): boolean {
  if (value.length !== 10) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && isCalendarDate({ year, month, day });
}

function subjectId(value: unknown): string {
  if (typeof value !== 'string' || routeOf(value) === null) throw new CopyInvalidError('subjectId');
  return value;
}

function vocabularyValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}(?![\s\S])/.test(value)) throw new CopyInvalidError(field);
  return value;
}

function textValue(value: unknown, field: TextField): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !within(value, TEXT_LIMITS[field])) throw new CopyInvalidError(field);
  return value;
}

function dateValue(value: unknown, field: DateField): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !isoDate(value)) throw new CopyInvalidError(field);
  return value;
}

function revisionValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= 2_147_483_647) {
    throw new CopyInvalidError('revision');
  }
  return value;
}

function parseCreate(input: unknown): CopyInput {
  const value = plain(input);
  const foreign = unexpected(value, CREATE_FIELDS);
  if (foreign !== null) throw new CopyInvalidError(foreign);
  return {
    subjectId: subjectId(value.subjectId),
    ...(Object.hasOwn(value, 'kind') ? { kind: vocabularyValue(value.kind, 'kind') } : {}),
    ...(Object.hasOwn(value, 'status') ? { status: vocabularyValue(value.status, 'status') } : {}),
    location: textValue(Object.hasOwn(value, 'location') ? value.location : null, 'location'),
    source: textValue(Object.hasOwn(value, 'source') ? value.source : null, 'source'),
    acquiredOn: dateValue(Object.hasOwn(value, 'acquiredOn') ? value.acquiredOn : null, 'acquiredOn'),
    disposedOn: dateValue(Object.hasOwn(value, 'disposedOn') ? value.disposedOn : null, 'disposedOn'),
    note: textValue(Object.hasOwn(value, 'note') ? value.note : null, 'note'),
    ...conditionPatch(value),
  };
}

function parseUpdate(input: unknown): CopyPatch {
  const value = plain(input);
  const foreign = unexpected(value, UPDATE_FIELDS);
  if (foreign !== null) throw new CopyInvalidError(foreign);
  const patch: CopyPatch = { revision: revisionValue(value.revision) };
  if (Object.hasOwn(value, 'status')) patch.status = vocabularyValue(value.status, 'status');
  if (Object.hasOwn(value, 'location')) patch.location = textValue(value.location, 'location');
  if (Object.hasOwn(value, 'source')) patch.source = textValue(value.source, 'source');
  if (Object.hasOwn(value, 'acquiredOn')) patch.acquiredOn = dateValue(value.acquiredOn, 'acquiredOn');
  if (Object.hasOwn(value, 'disposedOn')) patch.disposedOn = dateValue(value.disposedOn, 'disposedOn');
  if (Object.hasOwn(value, 'note')) patch.note = textValue(value.note, 'note');
  Object.assign(patch, conditionPatch(value));
  return patch;
}

function conditionFields(input: CopyConditionPatch): CopyConditionPatch {
  const fields: {
    mediaCondition?: Exclude<CopyConditionPatch['mediaCondition'], undefined>;
    packagingCondition?: Exclude<CopyConditionPatch['packagingCondition'], undefined>;
  } = {};
  if (Object.hasOwn(input, 'mediaCondition') && input.mediaCondition !== undefined)
    fields.mediaCondition = input.mediaCondition;
  if (Object.hasOwn(input, 'packagingCondition') && input.packagingCondition !== undefined)
    fields.packagingCondition = input.packagingCondition;
  return fields;
}

function merged(current: Copy, patch: CopyPatch): CopyChanges {
  return {
    status: patch.status ?? current.status,
    location: patch.location === undefined ? current.location : patch.location,
    source: patch.source === undefined ? current.source : patch.source,
    acquiredOn: patch.acquiredOn === undefined ? current.acquiredOn : patch.acquiredOn,
    disposedOn: patch.disposedOn === undefined ? current.disposedOn : patch.disposedOn,
    note: patch.note === undefined ? current.note : patch.note,
    ...(current.conditionFacts === undefined ? {} : { conditionFacts: current.conditionFacts }),
  };
}

function requireActor(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action)) {
    throw new GrantDeniedError();
  }
  return actor;
}

async function admitAccount(client: Pick<PoolClient, 'query'>, owner: AccountActor): Promise<void> {
  const current = await readAccount(client, requireRoute(owner.accountId), owner.accountId);
  if (
    !current ||
    current.kind !== 'actor' ||
    current.state !== 'active' ||
    current.fenced ||
    !Number.isSafeInteger(owner.authnEpoch) ||
    owner.authnEpoch < 1 ||
    current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
  ) {
    throw new GrantDeniedError();
  }
}

function event(type: string, accountId: string, copyId: string) {
  return { type, subject: accountId, data: { copyId } };
}

/** A missing row and another account's row are the same result, so a conflict cannot disclose either. */
async function lockOwned(tx: CommandTransaction, route: number, accountId: string, copyId: string): Promise<Copy> {
  await tx.query('SELECT copy_id FROM library.copy WHERE route = $1 AND copy_id = $2 AND account_id = $3 FOR UPDATE', [
    route,
    copyId,
    accountId,
  ]);
  const current = await store.readCopy(tx, route, copyId);
  if (!current || current.accountId !== accountId) throw new LibraryNotFoundError();
  return current;
}

/** Copy loan creation locks the same copy row before inserting, so disposal and deletion serialize with lending. */
async function assertNoOpenLoan(
  tx: CommandTransaction,
  route: number,
  accountId: string,
  copyId: string,
): Promise<void> {
  const open = await tx.query(
    `SELECT loan_id FROM library.copy_loan
     WHERE route=$1 AND account_id=$2 AND copy_id=$3 AND returned_on IS NULL LIMIT 1`,
    [route, accountId, copyId],
  );
  if (open.rows.length) throw new CopyConflictError();
}

/** Private copy commands. Each copy is its own row in the owner's partition. */
export function createCopyCommands(config: Dependencies) {
  const { pool, access, tokens, clock } = config;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });

  async function gate(actor: Actor, action: string): Promise<AccountActor> {
    const owner = requireActor(actor, action);
    await withConnection(pool, (client) => admitAccount(client, owner));
    return owner;
  }

  async function readOnly<T>(
    owner: AccountActor,
    body: (client: CommandTransaction) => Promise<T>,
    deadline?: number,
  ): Promise<T> {
    return withConnection(pool, async (client) => {
      const bounded = deadline === undefined ? client : deadlineClient(client, deadline);
      await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await admitAccount(bounded, owner);
        const result = await body(bounded);
        await bounded.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function prepareSource(owner: AccountActor, subjectId: string, at: AuthoritativeTime) {
    try {
      return {
        source: await readLibraryProfileSource(
          { pool, access, actor: owner, at, deadline: deadlineFor(WORK_STEP_DEADLINE_MS) },
          subjectId,
        ),
      };
    } catch (error) {
      // Preparation cannot invalidate an authorized exact receipt.
      return { error };
    }
  }

  async function createCopy(actor: Actor, input: unknown, requestKey: string) {
    const owner = await gate(actor, 'copy:create');
    const parsed = parseCreate(input);
    return runner.ownAccountPrepared(
      owner,
      {
        action: 'copy:create',
        kind: 'library.copy.create',
        requestKey,
        input: parsed,
        async prepare(attempt) {
          await admitEntryAttempt(config, owner, 'copy:create', attempt, deadlineFor(WORK_STEP_DEADLINE_MS));
          return prepareSource(owner, parsed.subjectId, attempt.time);
        },
      },
      async (tx, command, prepared) => {
        if (parsed.kind === undefined) throw new CopyInvalidError('kind');
        if (parsed.status === undefined) throw new CopyInvalidError('status');
        if ('error' in prepared) throw prepared.error;
        const source = prepared.source;
        if (!source) throw new LibraryNotFoundError();
        if (source.kind !== 'supported' || !hasCopyStatus(source.profile, parsed.kind, parsed.status))
          throw new ProblemError('unsupported_library_profile');
        const requestedConditions = conditionFields(parsed);
        let conditionFacts;
        if (Object.keys(requestedConditions).length) {
          const acceptedKind = source.profile.copies?.kinds.find((candidate) => candidate.id === parsed.kind);
          if (!acceptedKind || copyConditionAdmission(acceptedKind).state !== 'supported')
            throw new ProblemError('unsupported_library_profile');
          conditionFacts = mergeCopyConditionFields({}, requestedConditions, { kind: acceptedKind, pin: source.pin });
        }
        const route = requireRoute(owner.accountId);
        const { mediaCondition: _mediaCondition, packagingCondition: _packagingCondition, ...copyInput } = parsed;
        const copy = await store.insertCopy(
          tx,
          route,
          {
            ...copyInput,
            status: parsed.status,
            subjectId: source.subjectId,
            id: newId(route),
            accountId: owner.accountId,
            ...(conditionFacts === undefined ? {} : { conditionFacts }),
          },
          { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
          { kind: parsed.kind, pin: source.pin },
        );
        return { value: copy, events: [event(UPDATED_EVENT, owner.accountId, copy.id)] };
      },
    );
  }

  async function updateCopy(actor: Actor, copyId: string, input: unknown, requestKey: string) {
    const owner = await gate(actor, 'copy:update');
    const patch = parseUpdate(input);
    const route = sameAccountRoute(owner.accountId, copyId);
    return runner.ownAccountPrepared(
      owner,
      {
        action: 'copy:update',
        kind: 'library.copy.update',
        requestKey,
        input: { copyId, ...patch },
        async prepare(attempt) {
          await admitEntryAttempt(config, owner, 'copy:update', attempt, deadlineFor(WORK_STEP_DEADLINE_MS));
          // Release the owner's read checkout before visiting source and Global anchors.
          const current = await readOnly(owner, (client) => store.readCopy(client, route, copyId));
          return current?.accountId === owner.accountId
            ? prepareSource(owner, current.subjectId, attempt.time)
            : { source: null };
        },
      },
      async (tx, command, prepared) => {
        const current = await lockOwned(tx, route, owner.accountId, copyId);
        if (current.revision !== patch.revision) throw new CopyConflictError();
        const fact = await store.readCopyFact(tx, route, copyId);
        if (!fact || fact.copy.accountId !== owner.accountId) throw new LibraryNotFoundError();
        const changes = merged(fact.copy, patch);
        if (changes.disposedOn !== null || changes.status === 'disposed')
          await assertNoOpenLoan(tx, route, owner.accountId, copyId);
        if ('error' in prepared) throw prepared.error;
        const source = prepared.source;
        if (!source || source.subjectId !== fact.copy.subjectId) throw new LibraryNotFoundError();
        if (
          source.kind !== 'supported' ||
          fact.kind === null ||
          !hasCopyStatus(source.profile, fact.kind, changes.status)
        )
          throw new ProblemError('unsupported_library_profile');
        const requestedConditions = conditionFields(patch);
        let conditionFacts = fact.copy.conditionFacts;
        if (Object.keys(requestedConditions).length) {
          const acceptedKind = source.profile.copies?.kinds.find((candidate) => candidate.id === fact.kind);
          if (!acceptedKind || copyConditionAdmission(acceptedKind).state !== 'supported')
            throw new ProblemError('unsupported_library_profile');
          conditionFacts = mergeCopyConditionFields(fact.copy.conditionFacts ?? {}, requestedConditions, {
            kind: acceptedKind,
            pin: source.pin,
          });
        }
        const nextChanges = {
          ...changes,
          ...(conditionFacts === undefined ? {} : { conditionFacts }),
        };
        const copy = await store.updateCopy(
          tx,
          route,
          copyId,
          patch.revision,
          nextChanges,
          {
            transactionId: command.transactionId,
            time: authoritativeTimeValue(command.time),
          },
          { kind: fact.kind, pin: source.pin, statusSupplied: Object.hasOwn(patch, 'status') },
        );
        if (!copy) throw new CopyConflictError();
        return { value: copy, events: [event(UPDATED_EVENT, owner.accountId, copy.id)] };
      },
    );
  }

  async function deleteCopy(actor: Actor, copyId: string, revision: number | undefined, requestKey: string) {
    const owner = await gate(actor, 'copy:delete');
    const expected = revision === undefined ? undefined : revisionValue(revision);
    const route = sameAccountRoute(owner.accountId, copyId);
    return runner.ownAccountPrepared(
      owner,
      {
        action: 'copy:delete',
        kind: 'library.copy.delete',
        requestKey,
        input: { copyId, ...(expected === undefined ? {} : { revision: expected }) },
        prepare: (attempt) =>
          admitEntryAttempt(config, owner, 'copy:delete', attempt, deadlineFor(WORK_STEP_DEADLINE_MS)),
      },
      async (tx, command) => {
        const current = await lockOwned(tx, route, owner.accountId, copyId);
        if (expected === undefined || current.revision !== expected || expected > 2_147_483_644)
          throw new CopyConflictError();
        await assertNoOpenLoan(tx, route, owner.accountId, copyId);
        const deletion = await store.deleteCopy(tx, route, copyId, expected, {
          transactionId: command.transactionId,
          time: authoritativeTimeValue(command.time),
        });
        if (!deletion) throw new CopyConflictError();
        // Preserve the existing native result/replay. HTTP returns no payload; its metadata
        // is the receipt transaction id and this exact original revision plus one.
        return { value: current, events: [event(DELETED_EVENT, owner.accountId, copyId)] };
      },
    );
  }

  async function restoreCopy(actor: Actor, copyId: string, input: unknown, requestKey: string) {
    const owner = await gate(actor, 'copy:update');
    const value = plain(input);
    const foreign = unexpected(value, ['deletionId', 'revision']);
    if (foreign !== null) throw new CopyInvalidError(foreign);
    if (
      typeof value.deletionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.deletionId)
    )
      throw new CopyInvalidError('deletionId');
    const selected = { copyId, deletionId: value.deletionId, revision: revisionValue(value.revision) };
    const route = sameAccountRoute(owner.accountId, copyId);
    return runner.ownAccountPrepared(
      owner,
      {
        action: 'copy:update',
        kind: 'library.copy.restore',
        requestKey,
        input: selected,
        async prepare(attempt) {
          await admitEntryAttempt(config, owner, 'copy:update', attempt, deadlineFor(WORK_STEP_DEADLINE_MS));
          try {
            // This exact read owns no checkout while immutable release and original/terminal
            // disclosure adapters visit their own anchors. Errors are deferred until receipt miss.
            const row = await readOnly(owner, async (client) => {
              const result = await client.query<{
                subject_id: string;
                kind: string | null;
                status: string;
                library_profile_pin: unknown;
                kind_profile_pin: unknown;
                status_profile_pin: unknown;
              }>(
                'SELECT subject_id, kind, status, library_profile_pin, kind_profile_pin, status_profile_pin FROM library.copy WHERE route=$1 AND copy_id=$2 AND account_id=$3',
                [route, copyId, owner.accountId],
              );
              return result.rows[0];
            });
            if (!row) throw new LibraryNotFoundError();
            const pin = decodeLibraryProfilePin(row.status_profile_pin ?? row.library_profile_pin);
            if (pin) {
              const release = await readRelease(pool, pin.releaseDigest);
              const profile = release ? resolveLibraryProfilePin({ digest: pin.releaseDigest, release }, pin) : null;
              if (!profile || row.kind === null || !hasCopyStatus(profile, row.kind, row.status))
                throw new Error('Retained copy accepted profile is unavailable');
            }
            const kindPin = decodeLibraryProfilePin(row.kind_profile_pin);
            if (kindPin) {
              const release = await readRelease(pool, kindPin.releaseDigest, { composed: false });
              const profile = release
                ? resolveLibraryProfilePin({ digest: kindPin.releaseDigest, release }, kindPin)
                : null;
              if (!profile?.copies?.kinds.some((kind) => kind.id === row.kind))
                throw new Error('Retained copy accepted kind profile is unavailable');
            }
            if (!(await resolveSubject(config, owner, row.subject_id, attempt.time))) throw new LibraryNotFoundError();
            return { error: null };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        const row = await retentionRead.run(tx, {
          route,
          copy_id: copyId,
          account_id: owner.accountId,
          time: authoritativeTimeValue(command.time),
        });
        if (!row) throw new LibraryNotFoundError();
        if (row.deletionId === null) throw new ProblemError('copy_restore_occupied');
        if (row.deletionId !== selected.deletionId || row.revision !== selected.revision)
          throw new ProblemError('copy_restore_stale');
        if (row.expired) throw new ProblemError('copy_restore_expired');
        if (prepared.error) throw prepared.error;
        const restored = await retentionRestore.run(tx, {
          route,
          account_id: owner.accountId,
          copy_id: copyId,
          deletion_id: selected.deletionId,
          revision: selected.revision,
          time: authoritativeTimeValue(command.time),
          transaction_id: command.transactionId,
        });
        if (!restored) throw new ProblemError('copy_restore_stale');
        const copy = await store.readCopy(tx, route, copyId);
        if (!copy) throw new Error('Restored copy is missing');
        return { value: copy, events: [event(UPDATED_EVENT, owner.accountId, copyId)] };
      },
    );
  }

  async function readCopy(actor: Actor, copyId: string): Promise<Copy> {
    const owner = requireActor(actor, 'copy:read');
    return readOnly(owner, async (client) => {
      const route = sameAccountRoute(owner.accountId, copyId);
      const copy = await store.readCopy(client, route, copyId);
      if (!copy || copy.accountId !== owner.accountId) throw new LibraryNotFoundError();
      return copy;
    });
  }

  function readPresentedCopy(
    actor: Actor,
    copyId: string,
    languages?: readonly string[],
  ): Promise<Copy & { presentation: CopyPresentation }>;
  function readPresentedCopy<T>(
    actor: Actor,
    copyId: string,
    languages: readonly string[],
    render: (copy: Copy, presentation: CopyPresentation, disclosure: { subject: boolean }) => Promise<T>,
  ): Promise<T>;
  /** Render between released observations so summaries cannot escape the final owner/source fence. */
  async function readPresentedCopy<T>(
    actor: Actor,
    copyId: string,
    languages: readonly string[] = [],
    render?: (copy: Copy, presentation: CopyPresentation, disclosure: { subject: boolean }) => Promise<T>,
  ): Promise<T | (Copy & { presentation: CopyPresentation })> {
    const owner = requireActor(actor, 'copy:read');
    const route = sameAccountRoute(owner.accountId, copyId);
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    return withRequestDeadline(deadline, () =>
      withinDeadline(deadline, async () => {
        const time = () => withConnection(pool, (client) => mintReadTime(deadlineClient(client, deadline), clock));
        async function observed(at: AuthoritativeTime) {
          requireActor(owner, 'copy:read');
          const check = await accessCheck(
            access,
            owner,
            'copy:read',
            { route, id: owner.accountId },
            { pool, deadline, time: at },
          );
          return readOnly(owner, async (client) => {
            const bounded = deadlineClient(client, deadline);
            if (!(await check(bounded, at))) throw new GrantDeniedError();
            const partition = await readPartition(bounded, partitionOf(route));
            const row = await copyDetailRead.run(bounded, { route, copy_id: copyId, account_id: owner.accountId });
            if (!partition || !row) throw new LibraryNotFoundError();
            const {
              libraryProfilePin,
              kindProfilePin,
              statusProfilePin,
              mediaCondition,
              packagingCondition,
              ...value
            } = row;
            const conditionFacts = decodeCopyConditionFacts(mediaCondition, packagingCondition);
            const copy: Copy = {
              ...value,
              createdAt: new Date(value.createdAt).toISOString(),
              updatedAt: new Date(value.updatedAt).toISOString(),
              ...(conditionFacts === undefined ? {} : { conditionFacts }),
            };
            return {
              fact: {
                copy,
                compatibilityPin: decodeLibraryProfilePin(libraryProfilePin),
                // The old mutable pin proves status only, never original kind.
                kindPin: decodeLibraryProfilePin(kindProfilePin),
                statusPin: decodeLibraryProfilePin(statusProfilePin ?? libraryProfilePin),
              },
              epoch: partition.epoch,
            };
          });
        }
        const at = await time();
        try {
          const before = await observed(at);
          const prepared = await prepareCopyPresentation(
            { pool, access, actor: owner, at, deadline },
            before.fact,
            languages,
          );
          const result = render
            ? await render(before.fact.copy, prepared.presentation, prepared.disclosure)
            : { ...before.fact.copy, presentation: prepared.presentation };
          const finalTime = await time();
          try {
            let sourceFailure: { error: unknown } | null = null;
            try {
              await prepared.verify(finalTime);
            } catch (error) {
              sourceFailure = { error };
            }
            // Recheck native owner authority even when a foreign source fence failed.
            const after = await observed(finalTime);
            if (before.epoch !== after.epoch || JSON.stringify(before.fact) !== JSON.stringify(after.fact))
              throw new CopyConflictError();
            if (sourceFailure) throw sourceFailure.error;
          } finally {
            releaseOperationalTime(finalTime);
          }
          return result;
        } finally {
          releaseOperationalTime(at);
        }
      }),
    );
  }

  async function listCopiesWithObservation(actor: Actor, options: PageOptions = {}, languages: readonly string[] = []) {
    const owner = requireActor(actor, 'copy:list');
    const filterSubjectId = options.subjectId === undefined ? null : subjectId(options.subjectId);
    const filterKind = options.kind === undefined ? null : vocabularyValue(options.kind, 'kind');
    const filterStatus = options.status === undefined ? null : vocabularyValue(options.status, 'status');
    const size = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT) throw new CopyInvalidError('limit');
    const accountRoute = requireRoute(owner.accountId);
    const binding: CursorBinding = {
      operation: 'copy.list',
      parameters: {
        accountId: owner.accountId,
        accountLifetime: owner.authnEpoch,
        clientId: owner.clientId,
        requestedBy: owner.requestedBy,
        route: accountRoute,
        subjectId: filterSubjectId,
        kind: filterKind,
        status: filterStatus,
        order: 'created_at:asc,copy_id:asc',
        basis: 'library.partition.epoch',
      },
    };
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    const readPage = () =>
      readOnly(
        owner,
        async (client) => {
          const partition = await readPartition(client, partitionOf(accountRoute));
          let after: { createdAt: string; copyId: string } | null = null;
          if (options.cursor !== undefined) {
            const cursor = decodeCursor(tokens, binding, options.cursor);
            const createdAt = cursor.ok ? cursor.after[0] : undefined;
            const cursorId = cursor.ok ? cursor.after[1] : undefined;
            if (
              !cursor.ok ||
              cursor.after.length !== 2 ||
              typeof createdAt !== 'string' ||
              !Number.isFinite(Date.parse(createdAt)) ||
              typeof cursorId !== 'string' ||
              routeOf(cursorId) !== accountRoute
            ) {
              throw new ProblemError('invalid_cursor');
            }
            if (cursor.epoch !== partition?.epoch) throw new ProblemError('stale_cursor');
            after = { createdAt, copyId: cursorId };
          }
          const rows = await store.pageCopies(
            client,
            accountRoute,
            owner.accountId,
            { after, limit: Math.min(MAX_LIMIT, size + 1) },
            filterSubjectId,
            filterKind,
            filterStatus,
          );
          const copies = rows.slice(0, size);
          const last = copies.at(-1);
          let more = rows.length > size;
          if (!more && size === MAX_LIMIT && last) {
            const probe = await store.pageCopies(
              client,
              accountRoute,
              owner.accountId,
              { after: { createdAt: last.createdAt, copyId: last.id }, limit: 1 },
              filterSubjectId,
              filterKind,
              filterStatus,
            );
            more = probe.length > 0;
          }
          const inventoryValues = await readCopyInventoryValues(client, accountRoute, owner.accountId);
          return {
            copies,
            next:
              more && last && partition
                ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [last.createdAt, last.id] })
                : null,
            accountEpoch: partition?.epoch ?? null,
            inventoryValues,
          };
        },
        deadline,
      );

    return withRequestDeadline(deadline, async () => {
      const first = await readPage();
      const filterOptions = await prepareCopyInventory(pool, first.inventoryValues, deadline, languages);
      const current = await readPage();
      if (
        JSON.stringify(first.copies) !== JSON.stringify(current.copies) ||
        first.next !== current.next ||
        first.accountEpoch !== current.accountEpoch ||
        JSON.stringify(first.inventoryValues) !== JSON.stringify(current.inventoryValues)
      )
        throw new ProblemError('semantic_not_ready');
      return {
        copies: first.copies,
        next: first.next,
        accountEpoch: first.accountEpoch,
        filterOptions,
      };
    });
  }

  async function listCopies(actor: Actor, options: PageOptions = {}) {
    const { copies, next } = await listCopiesWithObservation(actor, options);
    return { copies, next };
  }

  return {
    createCopy,
    updateCopy,
    deleteCopy,
    restoreCopy,
    readCopy,
    readPresentedCopy,
    listCopies,
    listCopiesWithObservation,
  };
}
