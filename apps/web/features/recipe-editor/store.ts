import { type Answer, createRecipe, readRecipe, writePlan } from './api.ts';
import { applyPlan, type Intent, plan, type Plan, type Reason } from './intents.ts';
import type { RecipeState } from './model.ts';
import type { MainClient } from '../studio/types.ts';

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
  /** Repeats the intent the last refusal belongs to; the same write at the same head replays. */
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
  let failure: { intent: Intent; refusal: Refusal; id: string; key: string } | null = null;
  let snapshot: Snapshot = { state, busy: false, failure: null };
  let disposed = false;
  type Resolver = (outcome: Outcome) => void;
  type Entry = { intent: Intent; id: string; resolvers: Resolver[] };
  /** One record's write: the one in flight, and the newest edit waiting behind it. */
  type Lane = { current: Entry; pending: Entry | null };
  const lanes = new Map<string, Lane>();
  const listeners = new Set<() => void>();
  let idlers: (() => void)[] = [];
  let refreshes = 0;
  const notify = () => {
    snapshot = { state, busy: lanes.size > 0, failure: failure ? { intent: failure.intent, refusal: failure.refusal } : null };
    for (const listener of listeners) listener();
  };

  /** Reads Main again. Only the latest read started may replace what is held, so a slow older read never puts back an older state. */
  async function refresh(): Promise<boolean> {
    const mine = ++refreshes;
    const read = await readRecipe(main(), work, actingSubject);
    if (!read.ok || disposed) return false;
    if (mine === refreshes) state = read.data;
    return true;
  }

  /** The record's newest intent: what waits in its slot replaces the one that conflicted, and its callers wait for it. */
  function newest(lane: Lane) {
    if (!lane.pending) return;
    lane.current = { ...lane.pending, resolvers: [...lane.current.resolvers, ...lane.pending.resolvers] };
    lane.pending = null;
  }

  /** The lane's intent to completion. After a refusal Main is read and the newest intent is planned over it. */
  async function write(lane: Lane): Promise<Outcome> {
    // Records race for one head, so a write may lose to another record's more than once.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (disposed) return { kind: 'busy' };
      const { intent, id } = lane.current;
      if (!state.structure || !state.head) {
        const created = await createRecipe(main(), { work, mainVersion, actingSubject });
        if (!created.ok) return { kind: 'refused', refusal: refusalOf(created) };
        // The Composition may already hold edits from another tab or record: read it rather than assume it is empty.
        if (!state.structure) state = { ...state, structure: created.data.structure, head: created.data.revision };
        await refresh();
      }
      const planned: Plan = plan(state, intent);
      if (planned.kind === 'moot') return { kind: 'unchanged' };
      if (planned.kind === 'invalid') return { kind: 'refused', refusal: { kind: planned.reason } };
      const sentHead = state.head!;
      const answer = await writePlan(main(), { structure: state.structure!, head: sentHead, actingSubject, plan: planned,
        key: `recipe-edit:${id}:${sentHead.slice(-36)}` });
      if (answer.ok) {
        // Another record's write may have moved the head meanwhile: then Main, not this plan, is what the page shows.
        if (state.head === sentHead) state = applyPlan(state, planned, answer.data.revision, answer.data.occurrences ?? []);
        else await refresh();
        return { kind: 'saved' };
      }
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
      if (outcome.kind === 'refused') failure = { intent: done.intent, refusal: outcome.refusal, id: done.id, key };
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

  function submit(intent: Intent, id = newId()): Promise<Outcome> {
    if (disposed) return Promise.resolve({ kind: 'busy' });
    const key = keyOf(intent) ?? `once:${id}`;
    return new Promise<Outcome>(resolve => {
      const lane = lanes.get(key);
      // The record is being written: this edit takes the newest slot, and whoever waited there waits for it.
      if (lane) { lane.pending = { intent, id, resolvers: [...(lane.pending?.resolvers ?? []), resolve] }; return; }
      const fresh: Lane = { current: { intent, id, resolvers: [resolve] }, pending: null };
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
      return submit(failure.intent, failure.id);
    },
    dismiss() { failure = null; notify(); },
    dispose() { disposed = true; listeners.clear(); for (const resolve of idlers.splice(0)) resolve(); },
  };
}
