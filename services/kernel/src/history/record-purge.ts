import type { Pool } from 'pg';
import type { RecordPurgeAuthority } from '../semantic/record-purge-authority.ts';

export type RecordHistoryPurgeDependencies = Readonly<{ pool: Pool; clock?: () => Date }>;
export type RecordHistoryPurgeContext = Readonly<{ deadline: number }>;
declare const recordHistoryPurge: unique symbol;
export type PreparedRecordHistoryPurge = { readonly [recordHistoryPurge]: true };
export type RecordHistoryPurgeResult = Readonly<{
  state: 'pending' | 'progress' | 'complete';
  examined: number;
  minimized: number;
}>;

/**
 * The Semantic owner source reader and record-to-copy inventory are not delivered in this
 * checkout. Until both exist, this port cannot safely distinguish a complete empty inventory
 * from unknown copies and must not issue a preparation capability.
 */
export async function prepareRecordHistoryPurge(
  _deps: RecordHistoryPurgeDependencies,
  _authority: RecordPurgeAuthority,
  _context: RecordHistoryPurgeContext,
): Promise<PreparedRecordHistoryPurge | null> {
  throw new Error('Record history purge source and copy inventory unavailable');
}

/** No persisted source-bound receiving job can be advanced until its native inventory is delivered. */
export async function minimizeRecordHistoryPurge(
  _deps: RecordHistoryPurgeDependencies,
  _preparation: PreparedRecordHistoryPurge,
  _context: RecordHistoryPurgeContext,
): Promise<RecordHistoryPurgeResult> {
  throw new Error('Record history purge receiving custody unavailable');
}
