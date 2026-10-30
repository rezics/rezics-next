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

/** PROVISIONAL agreed Accounts declaration. Its native receiving implementation replaces this adapter. */
export async function prepareRecordHistoryPurge(
  _deps: RecordHistoryPurgeDependencies,
  _authority: RecordPurgeAuthority,
  _context: RecordHistoryPurgeContext,
): Promise<PreparedRecordHistoryPurge | null> {
  throw new Error('history_record_purge_unavailable: prepareRecordHistoryPurge');
}

/** Never turn absent inventory, receiving custody or consumer completion into successful cleanup. */
export async function minimizeRecordHistoryPurge(
  _deps: RecordHistoryPurgeDependencies,
  _preparation: PreparedRecordHistoryPurge,
  _context: RecordHistoryPurgeContext,
): Promise<RecordHistoryPurgeResult> {
  throw new Error('history_record_purge_unavailable: minimizeRecordHistoryPurge');
}
