import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { authoritativeTimeValue, type CommandEvent } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute } from './command-support.ts';
import type { Entry, EntryState } from './entry-model.ts';
import * as store from './entry-store.ts';
import entryPage from './entry-store-entry-page.sql';
import { createFollowCommands } from './follows.ts';
import { resolveSubject } from './subject-anchor.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
type PutEntryInput = { state: EntryState; revision?: number };
type ListEntryOptions = { state?: EntryState; cursor?: string; limit?: number };
type QueryClient = Pick<PoolClient, 'query'>;
type EntryPageRow = Awaited<ReturnType<typeof entryPage.run>>[number];

const ENTRY_STATES = new Set<string>(['planned', 'in_progress', 'completed', 'paused', 'dropped']);
const UPDATED_EVENT = 'com.rezics.library.entry.updated.v1';
const DELETED_EVENT = 'com.rezics.library.entry.deleted.v1';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class LibraryEntryInvalidError extends TypeError {
  constructor() {
    super('Unknown library entry state');
    this.name = 'LibraryEntryInvalidError';
  }
}

export class LibraryConflictError extends Error {
  constructor() {
    super('Library entry revision conflicts');
    this.name = 'LibraryConflictError';
  }
}

function account(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action))
    throw new GrantDeniedError();
  return actor;
}

function state(value: unknown): EntryState {
  if (typeof value !== 'string' || !ENTRY_STATES.has(value))
    throw new LibraryEntryInvalidError();
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= 2_147_483_647)
    throw new RangeError('Entry revision must be a positive PostgreSQL integer');
  return value;
}

function putInput(input: unknown): PutEntryInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('Library entry input must be an object');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'state' && key !== 'revision'))
    throw new TypeError('Library entry input contains an unknown field');
  const parsed: PutEntryInput = { state: state(value.state) };
  if (value.revision !== undefined) parsed.revision = revision(value.revision);
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

/** Private account library entry writes and signed, account-scoped keyset reads. */
export function createEntryCommands(config: Dependencies) {
  const { pool, access, tokens, clock } = config;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });
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

  async function putEntry(actor: Actor, subjectId: string, input: unknown, requestKey: string) {
    const owner = account(actor, 'library_entry:update');
    const parsed = putInput(input);
    requireRoute(owner.accountId);
    requireRoute(subjectId);
    const existing = await snapshot(actor, 'library_entry:update', (client, accountOwner, route) =>
      store.readEntry(client, route, accountOwner.accountId, subjectId),
    );
    const resolved = existing
      ? { subjectId, requestedSubjectId: existing.requestedSubjectId }
      : await resolveSubject({ pool, access }, owner, subjectId);
    if (!resolved) throw new LibraryNotFoundError();

    const requestInput = {
      subjectId: resolved.subjectId,
      requestedSubjectId: resolved.requestedSubjectId,
      state: parsed.state,
      revision: parsed.revision ?? null,
    };
    const expectedRevision = parsed.revision;
    try {
      return await runner.ownAccount(
        actor,
        { action: 'library_entry:update', kind: 'library.entry.put', requestKey, input: requestInput },
        async (tx, command) => {
          const route = requireRoute(owner.accountId);
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
            );
            if (!changed) throw new LibraryConflictError();
            entry = changed;
          }

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
    } catch (error) {
      if (parsed.revision === undefined && isDuplicateEntry(error)) throw new LibraryConflictError();
      throw error;
    }
  }

  async function deleteEntry(actor: Actor, subjectId: string, expectedRevision: number, requestKey: string) {
    const owner = account(actor, 'library_entry:delete');
    const expected = revision(expectedRevision);
    requireRoute(owner.accountId);
    requireRoute(subjectId);
    const existing = await snapshot(actor, 'library_entry:delete', (client, accountOwner, route) =>
      store.readEntry(client, route, accountOwner.accountId, subjectId),
    );
    const resolved = existing ? { subjectId } : await resolveSubject({ pool, access }, owner, subjectId);
    if (!resolved) throw new LibraryNotFoundError();
    return runner.ownAccount(
      actor,
      {
        action: 'library_entry:delete',
        kind: 'library.entry.delete',
        requestKey,
        input: { subjectId, revision: expected },
      },
      async (tx, command) => {
        const route = requireRoute(owner.accountId);
        const removed = await store.deleteEntry(tx, route, owner.accountId, resolved.subjectId, expected);
        if (!removed) throw new LibraryConflictError();
        return { value: removed, events: [entryEvent(DELETED_EVENT, owner.accountId, removed.subjectId)] };
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

  return { putEntry, deleteEntry, readEntry, listEntries };
}
