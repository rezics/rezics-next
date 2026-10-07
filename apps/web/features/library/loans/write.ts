import type { RecordResult } from './types.ts';

/**
 * One round of a record's write lane, shared with the reader store: the newest
 * intent replaces anything waiting, and a round that was superseded after
 * reading the record tells the next round it may trust that read.
 */
export interface WriteRound {
  seq: number;
  superseded: () => boolean;
  confirm: () => void;
  afterConfirmed: boolean;
}

interface Ticket<T, R> {
  choice: T;
  seq: number;
  apply: (choice: T, round: WriteRound) => Promise<R>;
}

function lane<T, R>(failed: R) {
  let running = false;
  let latest: Ticket<T, R> | null = null;
  let waiting: ((result: R) => void)[] = [];
  let seq = 0;
  async function run() {
    running = true;
    let afterConfirmed = false;
    while (latest) {
      const current = latest;
      const batch = waiting;
      latest = null;
      waiting = [];
      let confirmed = false;
      const result = await current.apply(current.choice, {
        seq: current.seq, afterConfirmed, confirm: () => { confirmed = true; }, superseded: () => latest !== null,
      }).catch(() => failed);
      afterConfirmed = confirmed && latest !== null;
      // Callers of a replaced intent wait for the one that stood, and receive its outcome.
      if (latest) waiting = [...batch, ...waiting];
      else for (const resolve of batch) resolve(result);
    }
    running = false;
  }
  return {
    submit<U>(choice: T, apply: (choice: T, round: WriteRound) => Promise<U>): Promise<U> {
      return new Promise(resolve => {
        latest = { choice, seq: ++seq, apply: apply as unknown as Ticket<T, R>['apply'] };
        waiting.push(resolve as (result: R) => void);
        if (!running) void run();
      });
    },
  };
}

const lanes = new Map<string, ReturnType<typeof lane<unknown, RecordResult<unknown>>>>();

/** Drops lanes. Tests start from an empty map so one file's writes do not meet another's. */
export function resetRecordLanes(): void {
  lanes.clear();
}

/**
 * One write at a time for one record. A newer intent replaces any intent
 * waiting behind the write in flight; nothing is queued in browser storage.
 */
export function submitRecord<T, R>(record: string, choice: T,
  apply: (choice: T, round: WriteRound) => Promise<RecordResult<R>>): Promise<RecordResult<R>> {
  const failed: RecordResult<R> = { ok: false, failure: 'unavailable' };
  let existing = lanes.get(record) as ReturnType<typeof lane<T, RecordResult<R>>> | undefined;
  if (!existing) {
    existing = lane<T, RecordResult<R>>(failed);
    lanes.set(record, existing as ReturnType<typeof lane<unknown, RecordResult<unknown>>>);
  }
  return existing.submit(choice, apply);
}

/**
 * Writes `choice` at `version`. A 409 reads the record again and writes only
 * when this round is still the newest intent and the record does not already
 * hold it. `retry` is false for a create: a second insert would add another copy.
 */
export async function writeNewest<T>(round: WriteRound, version: number,
  write: (version: number) => Promise<RecordResult<T>>,
  read: () => Promise<RecordResult<T | null>>,
  matches: (current: T) => boolean,
  versionOf: (current: T) => number,
  retry = true): Promise<RecordResult<T>> {
  if (round.afterConfirmed) {
    const fresh = await read();
    if (!fresh.ok) return fresh;
    if (fresh.data && matches(fresh.data)) return { ok: true, data: fresh.data };
  }
  const written = await write(version);
  if (written.ok || (written.failure !== 'moved' && written.failure !== 'conflict')) return written;
  const fresh = await read();
  if (!fresh.ok) return fresh;
  if (round.superseded()) { round.confirm(); return written; }
  if (fresh.data && matches(fresh.data)) return { ok: true, data: fresh.data };
  if (!retry || !fresh.data || written.failure === 'conflict') return written;
  return write(versionOf(fresh.data));
}
