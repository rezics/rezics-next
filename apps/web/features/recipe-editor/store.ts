import { type Answer, createRecipe, readRecipe, writePlan } from './api.ts';
import { applyPlan, type Intent, plan, type Plan, type Reason } from './intents.ts';
import type { RecipeState } from './model.ts';
import type { MainClient } from '../studio/types.ts';

// The recipe's write path, with the rules every reader-side store in the app follows: one write in
// flight, a refused write (409, the head moved) reads Main again and works out only the newest
// intent over what is there now, and nothing is queued or kept in the browser. Controls that add
// or remove things wait for the write in flight (`busy`); an edit to the field already being
// written replaces the one waiting behind it, so the newest wins.

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
  /** Resolves once no write is in flight; a form that adds something waits here instead of dropping the person's Enter. */
  whenIdle(): Promise<void>;
  /** Repeats the intent the last refusal belongs to; the same write at the same head replays. */
  retry(): Promise<Outcome>;
  dismiss(): void;
  dispose(): void;
}

/**
 * The record an edit writes. Edits of different records commute, so each record keeps its newest
 * waiting edit (a second edit of a record replaces the first); adds, removals and moves have no
 * key and are never held back.
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
  let writing = false;
  let failure: { intent: Intent; refusal: Refusal; id: string } | null = null;
  let snapshot: Snapshot = { state, busy: false, failure: null };
  let disposed = false;
  type Waiting = { intent: Intent; id: string; key: string; resolvers: ((outcome: Outcome) => void)[] };
  const waiting = new Map<string, Waiting>();
  const listeners = new Set<() => void>();
  let idlers: (() => void)[] = [];
  const notify = () => {
    snapshot = { state, busy: writing, failure: failure ? { intent: failure.intent, refusal: failure.refusal } : null };
    for (const listener of listeners) listener();
  };

  async function refresh(): Promise<boolean> {
    const read = await readRecipe(main(), work, actingSubject);
    if (!read.ok || disposed) return false;
    state = read.data;
    return true;
  }

  /** One intent to completion: plan it over the state held, send it, and after a refusal read Main and plan it once more. */
  async function write(intent: Intent, id: string): Promise<Outcome> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (disposed) return { kind: 'busy' };
      if (!state.structure || !state.head) {
        const created = await createRecipe(main(), { work, mainVersion, actingSubject });
        if (!created.ok) return { kind: 'refused', refusal: refusalOf(created) };
        // The Composition may already hold edits from another tab: read it rather than assume it is empty.
        state = { ...state, structure: created.data.structure, head: created.data.revision };
        await refresh();
      }
      const planned: Plan = plan(state, intent);
      if (planned.kind === 'moot') return { kind: 'unchanged' };
      if (planned.kind === 'invalid') return { kind: 'refused', refusal: { kind: planned.reason } };
      const answer = await writePlan(main(), { structure: state.structure!, head: state.head!, actingSubject, plan: planned,
        key: `recipe-edit:${id}:${state.head!.slice(-36)}` });
      if (answer.ok) {
        state = applyPlan(state, planned, answer.data.revision, answer.data.occurrences ?? []);
        return { kind: 'saved' };
      }
      if (answer.status !== 409) return { kind: 'refused', refusal: refusalOf(answer) };
      if (!await refresh()) return { kind: 'refused', refusal: { kind: 'unavailable' } };
    }
    return { kind: 'refused', refusal: { kind: 'moved', detail: null } };
  }

  async function drain(first: { intent: Intent; id: string; resolvers: ((outcome: Outcome) => void)[] }) {
    let current: { intent: Intent; id: string; resolvers: ((outcome: Outcome) => void)[] } | null = first;
    writing = true;
    notify();
    while (current && !disposed) {
      let outcome: Outcome;
      try { outcome = await write(current.intent, current.id); }
      catch { outcome = { kind: 'refused', refusal: { kind: 'unavailable' } }; }
      failure = outcome.kind === 'refused' ? { intent: current.intent, refusal: outcome.refusal, id: current.id } : failure;
      if (outcome.kind !== 'refused') failure = null;
      notify();
      for (const resolve of current.resolvers) resolve(outcome);
      const [key, next] = waiting.entries().next().value ?? [];
      if (key !== undefined) waiting.delete(key);
      current = next ?? null;
    }
    writing = false;
    waiting.clear();
    notify();
    for (const resolve of idlers.splice(0)) resolve();
  }

  function submit(intent: Intent, id = newId()): Promise<Outcome> {
    if (disposed) return Promise.resolve({ kind: 'busy' });
    const key = keyOf(intent);
    return new Promise<Outcome>(resolve => {
      if (!writing) { failure = null; void drain({ intent, id, resolvers: [resolve] }); return; }
      // An edit of a record waits for the write in flight, the newest per record; anything else waits for the person.
      if (key) {
        waiting.set(key, { intent, id, key, resolvers: [...(waiting.get(key)?.resolvers ?? []), resolve] });
        return;
      }
      resolve({ kind: 'busy' });
    });
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submit: intent => submit(intent),
    whenIdle: () => writing ? new Promise<void>(resolve => { idlers.push(resolve); }) : Promise.resolve(),
    retry() {
      if (!failure) return Promise.resolve<Outcome>({ kind: 'unchanged' });
      return submit(failure.intent, failure.id);
    },
    dismiss() { failure = null; notify(); },
    dispose() { disposed = true; listeners.clear(); for (const resolve of idlers.splice(0)) resolve(); },
  };
}
