import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { authoritativeTimeValue, type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
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
import { hasCopyStatus } from './profile.ts';
import { readLibraryProfileSource } from './profile-source.ts';

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
] as const;
const UPDATE_FIELDS = ['revision', 'status', 'location', 'source', 'acquiredOn', 'disposedOn', 'note'] as const;
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
};
type CopyPatch = { revision: number } & Partial<CopyChanges>;
type PageOptions = { cursor?: string; limit?: number; subjectId?: string };

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
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
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
  return patch;
}

function merged(current: Copy, patch: CopyPatch): CopyChanges {
  return {
    status: patch.status ?? current.status,
    location: patch.location === undefined ? current.location : patch.location,
    source: patch.source === undefined ? current.source : patch.source,
    acquiredOn: patch.acquiredOn === undefined ? current.acquiredOn : patch.acquiredOn,
    disposedOn: patch.disposedOn === undefined ? current.disposedOn : patch.disposedOn,
    note: patch.note === undefined ? current.note : patch.note,
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

/** Private copy commands. Each copy is its own row in the owner's partition. */
export function createCopyCommands(config: Dependencies) {
  const { pool, access, tokens, clock } = config;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });

  async function gate(actor: Actor, action: string): Promise<AccountActor> {
    const owner = requireActor(actor, action);
    await withConnection(pool, (client) => admitAccount(client, owner));
    return owner;
  }

  async function readOnly<T>(owner: AccountActor, body: (client: PoolClient) => Promise<T>): Promise<T> {
    return withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await admitAccount(client, owner);
        const result = await body(client);
        await client.query('COMMIT');
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
      if (error instanceof ProblemError && error.code === 'semantic_not_ready') return { error };
      throw error;
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
        prepare: (attempt) => prepareSource(owner, parsed.subjectId, attempt.time),
      },
      async (tx, command, prepared) => {
        if (parsed.kind === undefined) throw new CopyInvalidError('kind');
        if (parsed.status === undefined) throw new CopyInvalidError('status');
        if ('error' in prepared) throw prepared.error;
        const source = prepared.source;
        if (!source) throw new LibraryNotFoundError();
        if (source.kind !== 'supported' || !hasCopyStatus(source.profile, parsed.kind, parsed.status))
          throw new ProblemError('unsupported_library_profile');
        const route = requireRoute(owner.accountId);
        const copy = await store.insertCopy(
          tx,
          route,
          {
            ...parsed,
            status: parsed.status,
            subjectId: source.subjectId,
            id: newId(route),
            accountId: owner.accountId,
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
        if ('error' in prepared) throw prepared.error;
        const source = prepared.source;
        if (!source || source.subjectId !== fact.copy.subjectId) throw new LibraryNotFoundError();
        if (
          source.kind !== 'supported' ||
          fact.kind === null ||
          !hasCopyStatus(source.profile, fact.kind, changes.status)
        )
          throw new ProblemError('unsupported_library_profile');
        const copy = await store.updateCopy(
          tx,
          route,
          copyId,
          patch.revision,
          changes,
          {
            transactionId: command.transactionId,
            time: authoritativeTimeValue(command.time),
          },
          { kind: fact.kind, pin: source.pin },
        );
        if (!copy) throw new CopyConflictError();
        return { value: copy, events: [event(UPDATED_EVENT, owner.accountId, copy.id)] };
      },
    );
  }

  async function deleteCopy(actor: Actor, copyId: string, revision: number, requestKey: string) {
    const owner = await gate(actor, 'copy:delete');
    const expected = revisionValue(revision);
    const route = sameAccountRoute(owner.accountId, copyId);
    return runner.ownAccount(
      owner,
      { action: 'copy:delete', kind: 'library.copy.delete', requestKey, input: { copyId, revision: expected } },
      async (tx) => {
        const current = await lockOwned(tx, route, owner.accountId, copyId);
        if (current.revision !== expected) throw new CopyConflictError();
        const copy = await store.deleteCopy(tx, route, copyId, expected);
        if (!copy) throw new CopyConflictError();
        return { value: copy, events: [event(DELETED_EVENT, owner.accountId, copy.id)] };
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

  async function listCopies(actor: Actor, options: PageOptions = {}) {
    const owner = requireActor(actor, 'copy:list');
    const filterSubjectId = options.subjectId === undefined ? null : subjectId(options.subjectId);
    return readOnly(owner, async (client) => {
      const size = options.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT) throw new CopyInvalidError('limit');
      const accountRoute = requireRoute(owner.accountId);
      const binding: CursorBinding = {
        operation: 'copy.list',
        parameters: { accountId: owner.accountId, subjectId: filterSubjectId },
      };
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
        {
          after,
          limit: Math.min(MAX_LIMIT, size + 1),
        },
        filterSubjectId,
      );
      const copies = rows.slice(0, size);
      const last = copies.at(-1);
      let more = rows.length > size;
      if (!more && size === MAX_LIMIT && last) {
        const probe = await store.pageCopies(
          client,
          accountRoute,
          owner.accountId,
          {
            after: { createdAt: last.createdAt, copyId: last.id },
            limit: 1,
          },
          filterSubjectId,
        );
        more = probe.length > 0;
      }
      return {
        copies,
        next:
          more && last && partition
            ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [last.createdAt, last.id] })
            : null,
      };
    });
  }

  return { createCopy, updateCopy, deleteCopy, readCopy, listCopies };
}
