/** Failures other than `unavailable` definitively settle a command. */
export type CommandResult<T, F extends string = string> = { ok: true; data: T } | { ok: false; failure: F };

/**
 * The newest intent replaces anything waiting. A superseded round can confirm
 * a read so the next round checks whether its complete intent is already held.
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
 * One command from the reader's action until it succeeds or is refused.
 * Separate create actions each own an instance, even with identical fields.
 */
export interface CommandInstance {
  id: () => string;
  finish: (result: { ok: boolean; failure?: string }) => void;
}

export function commandInstance(): CommandInstance {
  let current: string | null = null;
  return {
    id() {
      current ??= crypto.randomUUID();
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

export function unresolved(result: unknown): boolean {
  return !!result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok === false
    && 'failure' in result && (result as { failure?: string }).failure === 'unavailable';
}

interface Ticket<T, R> {
  choice: T;
  seq: number;
  apply: (choice: T, round: WriteRound) => Promise<R>;
}

/**
 * Caller-owned lane for one record or command instance; only the newest pending
 * intent survives. Choices are JSON request fields, and `failed` is unavailable.
 * Callers retain this lane across retries. No registry or persistence lives here.
 */
export function commandLane<T, R>(failed: R) {
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
    intentKey = crypto.randomUUID();
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
    submit(choice: T, apply: (choice: T, round: WriteRound) => Promise<R>): Promise<R> {
      return new Promise(resolve => {
        latest = { choice, seq: ++seq, apply };
        waiting.push(resolve);
        if (!running) void run();
      });
    },
  };
}

/**
 * Writes `choice` at `version`. A lost response is tried once more with the
 * same command key, so a committed command is replayed instead of abandoned.
 * A 409 reads the record again and writes only when this round is still the
 * newest intent and the record does not already hold the whole intent.
 * `matches` must compare every field the command sets.
 * `retry` is false for a create: a second insert would add another copy.
 */
export async function writeNewest<T, F extends string>(round: WriteRound, version: number,
  write: (version: number) => Promise<CommandResult<T, F>>,
  read: () => Promise<CommandResult<T | null, F>>,
  matches: (current: T) => boolean,
  versionOf: (current: T) => number,
  retry = true): Promise<CommandResult<T, F>> {
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
