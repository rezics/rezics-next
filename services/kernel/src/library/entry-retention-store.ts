import type { PoolClient } from 'pg';
import retain from './entry-retention-retain.sql';
import read from './entry-retention-read.sql';
import restore from './entry-retention-restore.sql';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import type { LibraryProfilePin } from './profile.ts';

type Client = Pick<PoolClient, 'query'>;
type Context = { transactionId: string; time: string };
type Slot = { route: number; accountId: string; subjectId: string };
type Deletion = Slot & { deletionId: string };
type StoredRetention = NonNullable<Awaited<ReturnType<typeof read.run>>>;
type StoredRestoration = Awaited<ReturnType<typeof restore.run>>[number];
type Decoded<T> = Omit<T, 'libraryProfilePin'> & { libraryProfilePin: LibraryProfilePin | null };

/** Private complete snapshot; bigint observations and sequences are lossless decimal text. */
export type RetainedEntryDeletion = Decoded<StoredRetention>;
/** Private native live row, including original user dates and accepted provenance. */
export type RestoredEntryFact = Decoded<StoredRestoration>;

function decode<T extends { libraryProfilePin: unknown }>(row: T): Decoded<T> {
  return { ...row, libraryProfilePin: decodeLibraryProfilePin(row.libraryProfilePin) };
}

function key(input: Slot) {
  return { route: input.route, account_id: input.accountId, subject_id: input.subjectId };
}

/**
 * Caller owns native authorization/owner guards, receipt/source checks and the supplied transaction.
 * Insert errors abort the move; this DAO neither allocates identity/owner sequence nor retries transactions.
 */
export async function retainEntryDeletion(
  client: Client,
  input: Slot & { incarnationId: string; revision: number },
  context: Context,
): Promise<RetainedEntryDeletion | null> {
  const rows = await retain.run(client, {
    ...key(input),
    incarnation_id: input.incarnationId,
    revision: input.revision,
    transaction_id: context.transactionId,
    time: context.time,
  });
  return rows[0] ? decode(rows[0]) : null;
}

/** Exact private locator only; finding a snapshot supplies no current authorization. */
export async function readRetainedEntryDeletion(
  client: Client,
  input: Deletion,
): Promise<RetainedEntryDeletion | null> {
  const row = await read.run(client, { ...key(input), deletion_id: input.deletionId });
  return row ? decode(row) : null;
}

/**
 * Same caller guards/transaction as retain. Native slot arbitration leaves occupied archives untouched.
 * The later Undo command must stamp its newly allocated owner sequence before committing this transaction.
 */
export async function restoreRetainedEntryDeletion(
  client: Client,
  input: Deletion & { deletedRevision: number },
  context: Context,
): Promise<RestoredEntryFact | null> {
  const rows = await restore.run(client, {
    ...key(input),
    deletion_id: input.deletionId,
    deleted_revision: input.deletedRevision,
    transaction_id: context.transactionId,
    time: context.time,
  });
  return rows[0] ? decode(rows[0]) : null;
}
