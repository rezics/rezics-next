import { commandLane, unresolved, type WriteRound } from '../../api/command.ts';
import type { RecordResult } from './types.ts';

export { commandInstance, writeNewest, type CommandInstance, type WriteRound } from '../../api/command.ts';

const lanes = new Map<string, ReturnType<typeof commandLane<unknown, RecordResult<unknown>>>>();

/** Drops lanes. Tests start from an empty map so one file's writes do not meet another's. */
export function resetRecordLanes(): void {
  lanes.clear();
}

/**
 * One write at a time for one record or one command instance. A newer intent
 * replaces any intent waiting behind the write in flight; nothing is queued
 * in browser storage. A settled command leaves the lane, so the next command
 * does not reuse its key.
 */
export function submitRecord<T, R>(record: string, choice: T,
  apply: (choice: T, round: WriteRound) => Promise<RecordResult<R>>): Promise<RecordResult<R>> {
  const failed: RecordResult<R> = { ok: false, failure: 'unavailable' };
  let existing = lanes.get(record) as ReturnType<typeof commandLane<T, RecordResult<R>>> | undefined;
  if (!existing) {
    existing = commandLane<T, RecordResult<R>>(failed);
    lanes.set(record, existing as ReturnType<typeof commandLane<unknown, RecordResult<unknown>>>);
  }
  return existing.submit(choice, apply).then(result => {
    if (!unresolved(result)) lanes.delete(record);
    return result;
  });
}
