import { commandInstance, type CommandInstance, type WriteRound } from '../api/command.ts';
import type { MainClient } from '../studio/types.ts';
import { type Answer, createRecipe, readRecipe, writePlan } from './api.ts';
import { applyPlan, type Intent, plan, type Plan, type Reason } from './intents.ts';
import type { RecipeState } from './model.ts';

// The recipe's write path, with the rules every reader-side store in the app follows. Each record
// (a line, a step, a section's name, the yield, one timing) has at most one write in flight and at most
// one pending slot that every newer edit of that record overwrites. A refused write (409, the head
// moved) reads Main again and works out only the record's newest intent over what is there now: the
// pending one if there is one, never the stale original. Different records write independently,
// so nothing is queued across them and nothing drains a backlog; an add, move or removal is a record
// of its own. Nothing is kept in the browser.

export type Refusal =
  | { kind: 'sign-in' } | { kind: 'denied' } | { kind: 'unavailable' } | { kind: 'pending' }
  | { kind: 'invalid'; detail: string | null }
  /** The head kept moving, or Main refused for a reason reading again did not change. */
  | { kind: 'moved'; detail: string | null }
  | { kind: Reason };
export type Outcome = { kind: 'saved' } | { kind: 'unchanged' } | { kind: 'refused'; refusal: Refusal } | { kind: 'busy' };

export interface Snapshot {
  state: RecipeState;
  /** True while a write is on its way to Main. */
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
 * and moves are not edits of a record and have no key, so each is a lane of its own.
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
  type Entry = { intent: Intent; id: string; command: CommandInstance; flight: Flight | null; resolvers: Resolver[] };
  /** One record's write: the one in flight, and the newest edit waiting behind it. */
  type Lane = { current: Entry; pending: Entry | null };
  const lanes = new Map<string, Lane>();
  const listeners = new Set<() => void>();
  let idlers: (() => void)[] = [];
  let refreshes = 0;
  /** Successful writes. A read applies only when this is still the value it started with. */
  let confirmed = 0;
  let round = 0;
  const notify = () => {
    snapshot = { state, busy: lanes.size > 0, failure: failure ? { intent: failure.intent, refusal: failure.refusal } : null };
    for (const listener of listeners) listener();
  };

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

  /** The record's newest intent: what waits in its slot replaces the one that conflicted, and its callers wait for it. */
  function newest(lane: Lane) {
    if (!lane.pending) return;
    lane.current = { ...lane.pending, resolvers: [...lane.current.resolvers, ...lane.pending.resolvers] };
    lane.pending = null;
  }

  const open = (answer: Extract<Answer<unknown>, { ok: false }>) => answer.problem === 'unavailable' || answer.problem === 'pending';

  /** The idempotency key is the command's, from the cook's action until success or a definitive refusal. */
  function dispatch(lane: Lane, flight: Flight) {
    const commandRound: WriteRound = {
      seq: ++round, key: lane.current.command.id(), afterConfirmed: false,
      superseded: () => lane.pending !== null, confirm() {},
    };
    return writePlan(main(), { structure: state.structure!, head: flight.head, actingSubject, plan: flight.plan,
      key: commandRound.key });
  }

  /**
   * Applies a committed command. An insertion whose replay names no occurrences cannot be placed
   * locally, so the recipe is read again. A failed read of that replay stays unresolved.
   */
  async function adopt(flight: Flight, data: { revision: string; occurrences?: string[] }): Promise<boolean> {
    // Confirmed before the read that places an insertion, so that read cannot outrun a newer write.
    confirmed += 1;
    const created = data.occurrences ?? [];
    const inserts = flight.plan.kind === 'changes' ? flight.plan.operations.filter(operation => operation.op === 'insert').length : 0;
    if (inserts > created.length || state.head !== flight.head) {
      const read = await refresh();
      return inserts > created.length ? read : true;
    }
    state = applyPlan(state, flight.plan, data.revision, created);
    return true;
  }

  /** The lane's intent to completion. An unresolved command is resolved with its original key before anything is replanned. */
  async function write(lane: Lane): Promise<Outcome> {
    // Records race for one head, so a write may lose to another record's more than once.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (disposed) return { kind: 'busy' };
      const entry = lane.current;
      if (!entry.flight) {
        if (!state.structure || !state.head) {
          const created = await createRecipe(main(), { work, mainVersion, actingSubject });
          if (!created.ok) return { kind: 'refused', refusal: refusalOf(created) };
          // The Composition may already hold edits from another tab or record: read it rather than assume it is empty.
          if (!state.structure) {
            state = { ...state, structure: created.data.structure, head: created.data.revision };
            confirmed += 1;
          }
          await refresh();
        }
        const planned: Plan = plan(state, entry.intent);
        if (planned.kind === 'moot') return { kind: 'unchanged' };
        if (planned.kind === 'invalid') return { kind: 'refused', refusal: { kind: planned.reason } };
        entry.flight = { plan: planned, head: state.head! };
      }
      const flight = entry.flight;
      const answer = await dispatch(lane, flight);
      if (answer.ok) {
        if (!await adopt(flight, answer.data)) return { kind: 'refused', refusal: { kind: 'unavailable' } };
        entry.command.finish({ ok: true });
        entry.flight = null;
        return { kind: 'saved' };
      }
      // A lost or still-pending response keeps this command. Retry sends it again before planning a new one.
      if (open(answer)) return { kind: 'refused', refusal: refusalOf(answer) };
      entry.command.finish({ ok: false, failure: answer.problem });
      entry.flight = null;
      if (answer.status !== 409) return { kind: 'refused', refusal: refusalOf(answer) };
      if (!await refresh()) return { kind: 'refused', refusal: { kind: 'unavailable' } };
      newest(lane);
    }
    return { kind: 'refused', refusal: { kind: 'moved', detail: null } };
  }

  async function run(key: string, lane: Lane) {
    notify();
    while (!disposed) {
      let outcome: Outcome;
      try { outcome = await write(lane); }
      catch { outcome = { kind: 'refused', refusal: { kind: 'unavailable' } }; }
      const done = lane.current;
      if (outcome.kind === 'refused') failure = { intent: done.intent, refusal: outcome.refusal, id: done.id, key,
        command: done.command, flight: done.flight };
      else if (failure?.key === key) failure = null;
      notify();
      for (const resolve of done.resolvers) resolve(outcome);
      if (!lane.pending) break;
      lane.current = lane.pending;
      lane.pending = null;
    }
    lanes.delete(key);
    notify();
    if (lanes.size === 0) for (const resolve of idlers.splice(0)) resolve();
  }

  function submit(intent: Intent, carried?: { id: string; command: CommandInstance; flight: Flight | null }): Promise<Outcome> {
    if (disposed) return Promise.resolve({ kind: 'busy' });
    const id = carried?.id ?? newId();
    const command = carried?.command ?? commandInstance();
    const flight = carried?.flight ?? null;
    const key = keyOf(intent) ?? `once:${id}`;
    return new Promise<Outcome>(resolve => {
      const lane = lanes.get(key);
      // The record is being written: this edit takes the newest slot, and whoever waited there waits for it.
      if (lane) {
        lane.pending = { intent, id, command, flight, resolvers: [...(lane.pending?.resolvers ?? []), resolve] };
        return;
      }
      const fresh: Lane = { current: { intent, id, command, flight, resolvers: [resolve] }, pending: null };
      lanes.set(key, fresh);
      void run(key, fresh);
    });
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submit: intent => submit(intent),
    whenIdle: () => lanes.size > 0 ? new Promise<void>(resolve => { idlers.push(resolve); }) : Promise.resolve(),
    retry() {
      if (!failure) return Promise.resolve<Outcome>({ kind: 'unchanged' });
      return submit(failure.intent, { id: failure.id, command: failure.command, flight: failure.flight });
    },
    dismiss() { failure = null; notify(); },
    dispose() { disposed = true; listeners.clear(); for (const resolve of idlers.splice(0)) resolve(); },
  };
}
