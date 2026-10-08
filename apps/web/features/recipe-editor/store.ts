import { commandInstance, type CommandInstance, type WriteRound } from '../api/command.ts';
import type { MainClient } from '../studio/types.ts';
import { type Answer, createRecipe, readRecipe, writePlan } from './api.ts';
import { applyPlan, type Intent, plan, type Plan, type Reason } from './intents.ts';
import type { RecipeState } from './model.ts';

// The recipe's write path, with the rules every reader-side store in the app follows. One Composition
// write is in flight for the whole recipe. Each record (a line, a step, a section's name, the yield,
// one timing) keeps a single newest-intent slot: a later edit of that record replaces the slot, and
// nothing queues a backlog of stale intents. When the write in flight settles, the next slot is
// written against the head it confirmed, so edits from this tab do not refuse each other. A refusal
// because the head moved (another tab) reads Main again and writes only that record's newest intent.
// An add, move or removal is a record of its own. A read applies only when no later write has
// confirmed since the read started. Nothing is kept in the browser.

export type Refusal =
  | { kind: 'sign-in' } | { kind: 'denied' } | { kind: 'unavailable' } | { kind: 'pending' }
  | { kind: 'invalid'; detail: string | null }
  /** The head kept moving, or Main refused for a reason reading again did not change. */
  | { kind: 'moved'; detail: string | null }
  | { kind: Reason };
export type Outcome = { kind: 'saved' } | { kind: 'unchanged' } | { kind: 'refused'; refusal: Refusal } | { kind: 'busy' };

export interface Snapshot {
  state: RecipeState;
  /** True while a write is on its way to Main, or a slot is waiting for that write. */
  busy: boolean;
  /** What the last write ran into, until the next one starts. */
  failure: { intent: Intent; refusal: Refusal } | null;
}

export interface RecipeStore {
  /** The same object until something changes, so a component can subscribe to it. */
  snapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  submit(intent: Intent): Promise<Outcome>;
  /** Resolves once no write is in flight, so a form that adds something does not drop the person's Enter. */
  whenIdle(): Promise<void>;
  /** Resolves the last refusal. An unresolved command is sent again with its original key before it is replanned. */
  retry(): Promise<Outcome>;
  dismiss(): void;
  dispose(): void;
}

/**
 * The record an edit sets. A second edit of the same record overwrites the one waiting; adds, removals
 * and moves are not edits of a record and have no key, so each is a slot of its own.
 */
function keyOf(intent: Intent): string | null {
  switch (intent.kind) {
    case 'editLine': case 'editStep': case 'renameSection': return `${intent.kind}:${intent.occurrence}`;
    case 'yield': return 'yield';
    case 'timings': return `timings:${Object.keys(intent.times).sort().join(',')}`;
    default: return null;
  }
}

const refusalOf = (answer: Extract<Answer<unknown>, { ok: false }>): Refusal => {
  switch (answer.problem) {
    case 'sign-in': return { kind: 'sign-in' };
    case 'denied': return { kind: 'denied' };
    case 'invalid': return { kind: 'invalid', detail: answer.detail };
    case 'pending': return { kind: 'pending' };
    case 'stale': case 'conflict': return { kind: 'moved', detail: answer.detail };
    default: return { kind: 'unavailable' };
  }
};

export function createRecipeStore({ work, mainVersion, actingSubject, initial, main, newId = () => crypto.randomUUID() }: {
  work: string; mainVersion: string; actingSubject: string; initial: RecipeState; main: () => MainClient; newId?: () => string;
}): RecipeStore {
  let state = initial;
  type Sent = Exclude<Plan, { kind: 'moot' } | { kind: 'invalid' }>;
  /** The command as it was sent. Retry resolves this before planning against a newer head. */
  type Flight = { plan: Sent; head: string };
  let failure: { intent: Intent; refusal: Refusal; id: string; key: string; command: CommandInstance; flight: Flight | null } | null = null;
  let snapshot: Snapshot = { state, busy: false, failure: null };
  let disposed = false;
  type Resolver = (outcome: Outcome) => void;
  type Entry = { key: string; intent: Intent; id: string; command: CommandInstance; flight: Flight | null; resolvers: Resolver[] };
  /**
   * One newest intent per record, in the order the records first became pending. Replacing a slot
   * keeps its place. The record in flight is not in this map; its newer edit is.
   */
  const slots = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let idlers: (() => void)[] = [];
  let refreshes = 0;
  /** Successful writes. A read applies only when this is still the value it started with. */
  let confirmed = 0;
  let round = 0;
  /** Entries whose callers have not been answered, including one whose body is still being read back. */
  let active = 0;
  let draining = false;
  const outstanding = () => active > 0 || slots.size > 0;
  const notify = () => {
    snapshot = { state, busy: outstanding(), failure: failure ? { intent: failure.intent, refusal: failure.refusal } : null };
    for (const listener of listeners) listener();
  };
  const wake = () => { if (!outstanding()) for (const resolve of idlers.splice(0)) resolve(); };

  /**
   * Reads Main again. The latest read started wins over an older one. A read may replace what is
   * held only when no write was confirmed after it started; otherwise the snapshot is an older head
   * and is discarded, and the recipe is read again.
   */
  async function refresh(): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const mine = ++refreshes;
      const baseline = confirmed;
      const read = await readRecipe(main(), work, actingSubject);
      if (!read.ok || disposed) return false;
      if (confirmed !== baseline) {
        if (mine !== refreshes) return true;
        continue;
      }
      if (mine === refreshes) state = read.data;
      return true;
    }
    return false;
  }

  const open = (answer: Extract<Answer<unknown>, { ok: false }>) => answer.problem === 'unavailable' || answer.problem === 'pending';

  /** The idempotency key is the command's, from the cook's action until success or a definitive refusal. */
  function dispatch(entry: Entry, flight: Flight) {
    const commandRound: WriteRound = {
      seq: ++round, key: entry.command.id(), afterConfirmed: false,
      superseded: () => slots.has(entry.key), confirm() {},
    };
    return writePlan(main(), { structure: state.structure!, head: flight.head, actingSubject, plan: flight.plan,
      key: commandRound.key });
  }

  type Phase = { kind: 'done'; outcome: Outcome } | { kind: 'refresh-body'; requireRead: boolean } | { kind: 'conflict' };

  /**
   * Sends the entry once. A confirmed write whose occurrences cannot be placed locally does not hold
   * the gate across the read that follows: the head is already known, and the next slot writes against it.
   */
  async function postOnce(entry: Entry): Promise<Phase> {
    if (!entry.flight) {
      if (!state.structure || !state.head) {
        const created = await createRecipe(main(), { work, mainVersion, actingSubject });
        if (!created.ok) return { kind: 'done', outcome: { kind: 'refused', refusal: refusalOf(created) } };
        // The Composition may already hold edits from another tab: read it rather than assume it is empty.
        if (!state.structure) {
          state = { ...state, structure: created.data.structure, head: created.data.revision };
          confirmed += 1;
        }
        await refresh();
      }
      const planned: Plan = plan(state, entry.intent);
      if (planned.kind === 'moot') return { kind: 'done', outcome: { kind: 'unchanged' } };
      if (planned.kind === 'invalid') return { kind: 'done', outcome: { kind: 'refused', refusal: { kind: planned.reason } } };
      entry.flight = { plan: planned, head: state.head! };
    }
    const flight = entry.flight;
    const answer = await dispatch(entry, flight);
    if (answer.ok) {
      confirmed += 1;
      const created = answer.data.occurrences ?? [];
      const inserts = flight.plan.kind === 'changes' ? flight.plan.operations.filter(operation => operation.op === 'insert').length : 0;
      if (inserts > created.length || state.head !== flight.head) {
        // Do not move the local head backwards if a newer confirmed write already advanced it.
        if (state.head === flight.head) state = { ...state, head: answer.data.revision };
        return { kind: 'refresh-body', requireRead: inserts > created.length };
      }
      state = applyPlan(state, flight.plan, answer.data.revision, created);
      entry.command.finish({ ok: true });
      entry.flight = null;
      return { kind: 'done', outcome: { kind: 'saved' } };
    }
    // A lost or still-pending response keeps this command. Retry sends it again before planning a new one.
    if (open(answer)) return { kind: 'done', outcome: { kind: 'refused', refusal: refusalOf(answer) } };
    entry.command.finish({ ok: false, failure: answer.problem });
    entry.flight = null;
    if (answer.status !== 409) return { kind: 'done', outcome: { kind: 'refused', refusal: refusalOf(answer) } };
    return { kind: 'conflict' };
  }

  /** The record's newest intent replaces the one that conflicted, and its callers wait for the outcome. */
  function adoptNewest(entry: Entry) {
    const newer = slots.get(entry.key);
    if (!newer) return;
    slots.delete(entry.key);
    entry.intent = newer.intent;
    entry.id = newer.id;
    entry.command = newer.command;
    entry.flight = newer.flight;
    entry.resolvers.push(...newer.resolvers);
  }

  /**
   * One record to its outcome. A 409 reads again and sends only the newest intent, still ahead of every
   * other record. A confirmed write that must read the body back lets the next slot post during that read.
   */
  async function settle(entry: Entry, openNext: () => void): Promise<Outcome> {
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (disposed) return { kind: 'busy' };
        const phase = await postOnce(entry);
        if (phase.kind === 'done') return phase.outcome;
        if (phase.kind === 'refresh-body') {
          openNext();
          const read = await refresh();
          // A replay that names no occurrences stays unresolved when the read fails, so retry sends it again.
          if (phase.requireRead && !read) return { kind: 'refused', refusal: { kind: 'unavailable' } };
          entry.command.finish({ ok: true });
          entry.flight = null;
          return { kind: 'saved' };
        }
        if (!await refresh()) return { kind: 'refused', refusal: { kind: 'unavailable' } };
        adoptNewest(entry);
      }
      return { kind: 'refused', refusal: { kind: 'moved', detail: null } };
    } catch { return { kind: 'refused', refusal: { kind: 'unavailable' } }; }
  }

  function take(): Entry | undefined {
    const key = slots.keys().next().value;
    if (key === undefined) return undefined;
    const entry = slots.get(key);
    slots.delete(key);
    return entry;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (!disposed) {
        const entry = take();
        if (!entry) break;
        active += 1;
        notify();
        let opened = false;
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = () => { if (!opened) { opened = true; resolve(); } }; });
        void settle(entry, release).then(outcome => {
          active -= 1;
          if (outcome.kind === 'refused') failure = { intent: entry.intent, refusal: outcome.refusal, id: entry.id,
            key: entry.key, command: entry.command, flight: entry.flight };
          else if (failure?.key === entry.key) failure = null;
          release();
          notify();
          const waiting = [...entry.resolvers];
          for (const resolve of waiting) resolve(outcome);
          wake();
        });
        await gate;
      }
    } finally {
      draining = false;
      if (!disposed && slots.size > 0) void drain();
    }
  }

  function submit(intent: Intent, carried?: { id: string; command: CommandInstance; flight: Flight | null }): Promise<Outcome> {
    if (disposed) return Promise.resolve({ kind: 'busy' });
    const id = carried?.id ?? newId();
    const command = carried?.command ?? commandInstance();
    const flight = carried?.flight ?? null;
    const key = keyOf(intent) ?? `once:${id}`;
    return new Promise<Outcome>(resolve => {
      const waiting = slots.get(key);
      // A second edit of a record that is waiting, or in flight, replaces that one slot and keeps its callers.
      slots.set(key, { key, intent, id, command, flight, resolvers: [...(waiting?.resolvers ?? []), resolve] });
      void drain();
    });
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submit: intent => submit(intent),
    whenIdle: () => outstanding() ? new Promise<void>(resolve => { idlers.push(resolve); }) : Promise.resolve(),
    retry() {
      if (!failure) return Promise.resolve<Outcome>({ kind: 'unchanged' });
      return submit(failure.intent, { id: failure.id, command: failure.command, flight: failure.flight });
    },
    dismiss() { failure = null; notify(); },
    dispose() { disposed = true; listeners.clear(); for (const resolve of idlers.splice(0)) resolve(); },
  };
}
