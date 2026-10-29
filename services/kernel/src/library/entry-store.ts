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
import { decodeLibraryProfilePin } from './profile-pin.ts';
import type { LibraryProfilePin } from './profile.ts';
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
type EntryResult = Omit<NonNullable<Awaited<ReturnType<typeof entryRead.run>>>, 'state' | 'libraryProfilePin'> & {
  state: string;
  libraryProfilePin?: unknown;
};
type CopyResult = Omit<
  NonNullable<Awaited<ReturnType<typeof copyRead.run>>>,
  'status' | 'kind' | 'libraryProfilePin'
> & { status: string };
type CopyAcceptance = Readonly<{ pin: LibraryProfilePin; kind: string }>;

const ENTRY_STATES = new Set<string>(['planned', 'in_progress', 'completed', 'paused', 'dropped']);
const COPY_STATUSES = new Set<string>(['ordered', 'owned', 'lent', 'disposed']);

function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function asEntry(row: EntryResult): Entry {
  return {
    accountId: row.accountId,
    subjectId: row.subjectId,
    requestedSubjectId: row.requestedSubjectId,
    state: row.state,
    revision: row.revision,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    transactionId: row.transactionId,
  };
}

function asCopy(row: CopyResult): Copy {
  return {
    id: row.id,
    accountId: row.accountId,
    subjectId: row.subjectId,
    status: row.status,
    location: row.location,
    source: row.source,
    acquiredOn: row.acquiredOn,
    disposedOn: row.disposedOn,
    note: row.note,
    revision: row.revision,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    transactionId: row.transactionId,
  };
}

/** The caller owns current profile/access acceptance; storage only checks its private representation. */
function copyAcceptance(accepted: CopyAcceptance | undefined) {
  if (accepted === undefined) return { kind: null, library_profile_pin: null };
  const pin = decodeLibraryProfilePin(accepted.pin);
  if (pin === null) throw new Error('Invalid stored library profile pin');
  if (typeof accepted.kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}(?![\s\S])/.test(accepted.kind))
    throw new TypeError('Invalid library copy kind');
  return { kind: accepted.kind, library_profile_pin: pin };
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
  pin?: LibraryProfilePin,
): Promise<Entry> {
  const acceptedPin = pin === undefined ? null : decodeLibraryProfilePin(pin);
  if (acceptedPin === null) assertState(entry.state);
  const rows = await entryInsert.run(queryClient(client), {
    route,
    account_id: entry.accountId,
    subject_id: entry.subjectId,
    requested_subject_id: entry.requestedSubjectId,
    state: entry.state,
    library_profile_pin: acceptedPin,
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

export async function readEntryFact(
  client: Client,
  route: number,
  accountId: string,
  subjectId: string,
): Promise<{ entry: Entry; pin: LibraryProfilePin | null } | null> {
  const row = await entryRead.run(queryClient(client), { route, account_id: accountId, subject_id: subjectId });
  return row ? { entry: asEntry(row), pin: decodeLibraryProfilePin(row.libraryProfilePin) } : null;
}

export async function updateEntryState(
  client: Client,
  route: number,
  accountId: string,
  subjectId: string,
  revision: number,
  state: EntryState,
  context: WriteContext,
  pin?: LibraryProfilePin,
): Promise<Entry | null> {
  const acceptedPin = pin === undefined ? null : decodeLibraryProfilePin(pin);
  if (acceptedPin === null) assertState(state);
  const row = await entryUpdate.run(queryClient(client), {
    route,
    account_id: accountId,
    subject_id: subjectId,
    revision,
    state,
    library_profile_pin: acceptedPin,
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

export async function insertCopy(
  client: Client,
  route: number,
  copy: CopyDraft,
  context: WriteContext,
  accepted?: CopyAcceptance,
): Promise<Copy> {
  const acceptance = copyAcceptance(accepted);
  if (accepted === undefined) assertStatus(copy.status);
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
    ...acceptance,
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

/** Read the exact stored fact without resolving or revalidating current definitions. */
export async function readCopyFact(
  client: Client,
  route: number,
  copyId: string,
): Promise<{ copy: Copy; pin: LibraryProfilePin | null; kind: string | null } | null> {
  const row = await copyRead.run(queryClient(client), { route, copy_id: copyId });
  return row ? { copy: asCopy(row), pin: decodeLibraryProfilePin(row.libraryProfilePin), kind: row.kind } : null;
}

export async function updateCopy(
  client: Client,
  route: number,
  copyId: string,
  revision: number,
  changes: CopyChanges,
  context: WriteContext,
  accepted?: CopyAcceptance,
): Promise<Copy | null> {
  const acceptance = copyAcceptance(accepted);
  if (accepted === undefined) assertStatus(changes.status);
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
    ...acceptance,
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
