import type { PoolClient } from 'pg';
import copyDelete from './entry-store-copy-delete.sql';
import copyInsert from './entry-store-copy-insert.sql';
import copyPage from './entry-store-copy-page.sql';
import copySubjectPage from './entry-store-copy-subject-page.sql';
import copyRead from './entry-store-copy-read.sql';
import copyUpdate from './entry-store-copy-update.sql';
import entryDelete from './entry-store-entry-delete.sql';
import entryInsert from './entry-store-entry-insert.sql';
import entryPage from './entry-store-entry-page.sql';
import entryRead from './entry-store-entry-read.sql';
import entryUpdate from './entry-store-entry-update.sql';
import {
  MAX_LIBRARY_PAGE_SIZE,
  type Copy,
  type CopyChanges,
  type CopyDraft,
  type CopyPage,
  type CopyStatus,
  type Entry,
  type EntryDraft,
  type EntryPage,
  type EntryState,
} from './entry-model.ts';

type Client = Pick<PoolClient, 'query'>;
type WriteContext = { transactionId: string; time: string };
type EntryResult = Omit<NonNullable<Awaited<ReturnType<typeof entryRead.run>>>, 'state'> & { state: string };
type CopyResult = Omit<NonNullable<Awaited<ReturnType<typeof copyRead.run>>>, 'status'> & { status: string };

const ENTRY_STATES = new Set<string>(['planned', 'in_progress', 'completed', 'paused', 'dropped']);
const COPY_STATUSES = new Set<string>(['ordered', 'owned', 'lent', 'disposed']);

function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function asState(value: string): EntryState {
  return value;
}

function asStatus(value: string): CopyStatus {
  return value;
}

function asEntry(row: EntryResult): Entry {
  const { route: _route, ...entry } = row;
  return {
    ...entry,
    state: asState(entry.state),
    createdAt: iso(entry.createdAt),
    updatedAt: iso(entry.updatedAt),
  };
}

function asCopy(row: CopyResult): Copy {
  const { route: _route, ...copy } = row;
  return {
    ...copy,
    status: asStatus(copy.status),
    createdAt: iso(copy.createdAt),
    updatedAt: iso(copy.updatedAt),
  };
}

function assertState(state: string): void {
  if (!ENTRY_STATES.has(state as EntryState)) throw new TypeError('Unknown library entry state');
}

function assertStatus(status: string): void {
  if (!COPY_STATUSES.has(status as CopyStatus)) throw new TypeError('Unknown library copy status');
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Page limit must be a positive integer');
}

function write(context: WriteContext) {
  return { transaction_id: context.transactionId, time: context.time };
}

export async function insertEntry(
  client: Client,
  route: number,
  entry: EntryDraft,
  context: WriteContext,
): Promise<Entry> {
  assertState(entry.state);
  const rows = await entryInsert.run(queryClient(client), {
    route,
    account_id: entry.accountId,
    subject_id: entry.subjectId,
    requested_subject_id: entry.requestedSubjectId,
    state: entry.state,
    ...write(context),
  });
  const row = rows[0];
  if (!row) throw new Error('Library entry insert returned no row');
  return asEntry(row);
}

export async function readEntry(
  client: Client,
  route: number,
  accountId: string,
  subjectId: string,
): Promise<Entry | null> {
  const row = await entryRead.run(queryClient(client), { route, account_id: accountId, subject_id: subjectId });
  return row ? asEntry(row) : null;
}

export async function updateEntryState(
  client: Client,
  route: number,
  accountId: string,
  subjectId: string,
  revision: number,
  state: EntryState,
  context: WriteContext,
): Promise<Entry | null> {
  assertState(state);
  const row = await entryUpdate.run(queryClient(client), {
    route,
    account_id: accountId,
    subject_id: subjectId,
    revision,
    state,
    ...write(context),
  });
  return row ? asEntry(row) : null;
}

export async function deleteEntry(
  client: Client,
  route: number,
  accountId: string,
  subjectId: string,
  revision: number,
): Promise<Entry | null> {
  const row = await entryDelete.run(queryClient(client), {
    route,
    account_id: accountId,
    subject_id: subjectId,
    revision,
  });
  return row ? asEntry(row) : null;
}

export async function pageEntries(client: Client, route: number, accountId: string, page: EntryPage): Promise<Entry[]> {
  assertLimit(page.limit);
  if (page.state !== null) assertState(page.state);
  const rows = await entryPage.run(queryClient(client), {
    route,
    account_id: accountId,
    state: page.state,
    after_updated_at: page.after?.updatedAt ?? '2026-01-01T00:00:00.000Z',
    after_subject_id: page.after?.subjectId ?? '00000000-0000-0000-0000-000000000000',
    has_cursor: page.after !== null,
    limit: Math.min(MAX_LIBRARY_PAGE_SIZE, page.limit),
  });
  return rows.map((row) => asEntry(row));
}

export async function insertCopy(client: Client, route: number, copy: CopyDraft, context: WriteContext): Promise<Copy> {
  assertStatus(copy.status);
  const rows = await copyInsert.run(queryClient(client), {
    route,
    copy_id: copy.id,
    account_id: copy.accountId,
    subject_id: copy.subjectId,
    status: copy.status,
    location: copy.location,
    source: copy.source,
    acquired_on: copy.acquiredOn,
    disposed_on: copy.disposedOn,
    note: copy.note,
    ...write(context),
  });
  const row = rows[0];
  if (!row) throw new Error('Library copy insert returned no row');
  return asCopy(row);
}

export async function readCopy(client: Client, route: number, copyId: string): Promise<Copy | null> {
  const row = await copyRead.run(queryClient(client), { route, copy_id: copyId });
  return row ? asCopy(row) : null;
}

export async function updateCopy(
  client: Client,
  route: number,
  copyId: string,
  revision: number,
  changes: CopyChanges,
  context: WriteContext,
): Promise<Copy | null> {
  assertStatus(changes.status);
  const row = await copyUpdate.run(queryClient(client), {
    route,
    copy_id: copyId,
    revision,
    status: changes.status,
    location: changes.location,
    source: changes.source,
    acquired_on: changes.acquiredOn,
    disposed_on: changes.disposedOn,
    note: changes.note,
    ...write(context),
  });
  return row ? asCopy(row) : null;
}

export async function deleteCopy(
  client: Client,
  route: number,
  copyId: string,
  revision: number,
): Promise<Copy | null> {
  const row = await copyDelete.run(queryClient(client), { route, copy_id: copyId, revision });
  return row ? asCopy(row) : null;
}

export async function pageCopies(
  client: Client,
  route: number,
  accountId: string,
  page: CopyPage,
  subjectId: string | null = null,
): Promise<Copy[]> {
  assertLimit(page.limit);
  const parameters = {
    route,
    account_id: accountId,
    after_created_at: page.after?.createdAt ?? null,
    after_copy_id: page.after?.copyId ?? null,
    limit: Math.min(MAX_LIBRARY_PAGE_SIZE, page.limit),
  };
  const rows =
    subjectId === null
      ? await copyPage.run(queryClient(client), parameters)
      : await copySubjectPage.run(queryClient(client), { ...parameters, subject_id: subjectId });
  return rows.map((row) => asCopy(row));
}
