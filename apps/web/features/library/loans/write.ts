import { commandKey } from '../../feed/api.ts';
import type { RecordResult } from './types.ts';

/**
 * One round of a record's write lane, shared with the reader store: the newest
 * intent replaces anything waiting, and a round that was superseded after
 * reading the record tells the next round it may trust that read.
 * `key` is this command's Idempotency-Key. Retries of the unresolved command
 * reuse it. A confirmed success or a definitive refusal retires it.
 */
export interface WriteRound {
  seq: number;
  key: string;
  superseded: () => boolean;
  confirm: () => void;
  afterConfirmed: boolean;
}

/**
 * One create or other command, from the reader's action until it succeeds or
 * is refused. The lane is this instance, not a Work and not a shared create lane.
 */
export interface CommandInstance {
  id: () => string;
  finish: (result: { ok: boolean; failure?: string }) => void;
}

export function commandInstance(): CommandInstance {
  let current: string | null = null;
  return {
    id() {
      current ??= commandKey();
      return current;
    },
    finish(result) {
      if (result.ok || result.failure !== 'unavailable') current = null;
    },
  };
}

/** Field order does not make a new intent. Undefined fields are absent. */
function intentText(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(intentText).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${intentText(item)}`).join(',')}}`;
}

function unresolved(result: unknown): boolean {
  return !!result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok === false
    && 'failure' in result && (result as { failure?: string }).failure === 'unavailable';
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
  let open = false;
  let intentChoice = '';
  let intentKey = '';
  const keyFor = (choice: T) => {
    const text = intentText(choice);
    if (open && text === intentChoice && intentKey) return intentKey;
    intentChoice = text;
    intentKey = commandKey();
    open = true;
    return intentKey;
  };
  const retire = (result: R) => {
    if (unresolved(result)) return;
    open = false;
    intentKey = '';
  };
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
        seq: current.seq, key: keyFor(current.choice), afterConfirmed, confirm: () => { confirmed = true; },
        superseded: () => latest !== null,
      }).catch(() => failed);
      retire(result);
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
 * One write at a time for one record or one command instance. A newer intent
 * replaces any intent waiting behind the write in flight; nothing is queued
 * in browser storage. A settled command leaves the lane, so the next command
 * does not reuse its key.
 */
export function submitRecord<T, R>(record: string, choice: T,
  apply: (choice: T, round: WriteRound) => Promise<RecordResult<R>>): Promise<RecordResult<R>> {
  const failed: RecordResult<R> = { ok: false, failure: 'unavailable' };
  let existing = lanes.get(record) as ReturnType<typeof lane<T, RecordResult<R>>> | undefined;
  if (!existing) {
    existing = lane<T, RecordResult<R>>(failed);
    lanes.set(record, existing as ReturnType<typeof lane<unknown, RecordResult<unknown>>>);
  }
  return existing.submit(choice, apply).then(result => {
    if (!unresolved(result)) lanes.delete(record);
    return result;
  });
}

/**
 * Writes `choice` at `version`. A lost response is tried once more with the
 * same command key, so a committed command is replayed instead of abandoned.
 * A 409 reads the record again and writes only when this round is still the
 * newest intent and the record does not already hold the whole intent.
 * `retry` is false for a create: a second insert would add another copy.
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
  let written = await write(version);
  if (!written.ok && written.failure === 'unavailable' && !round.superseded()) written = await write(version);
  if (written.ok || (written.failure !== 'moved' && written.failure !== 'conflict')) return written;
  const fresh = await read();
  if (!fresh.ok) return fresh;
  if (round.superseded()) { round.confirm(); return written; }
  if (fresh.data && matches(fresh.data)) return { ok: true, data: fresh.data };
  if (!retry || !fresh.data || written.failure === 'conflict') return written;
  return write(versionOf(fresh.data));
}
