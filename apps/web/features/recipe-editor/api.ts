import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../studio/types.ts';
import { isPending, type Problem, problemOf } from '../work-levels-edit/write.ts';
import type { Operation, Plan } from './intents.ts';
import { type RecipePageLike, type RecipeState } from './model.ts';
import { loadRecipe, type RecipeFetch } from './pages.ts';

// The recipe editor's calls to Main, through the same operations every client uses: the Work's
// Composition for ingredients and steps, the Recipe measure routes for yield and timings.

export type Answer<T> = { ok: true; data: T } | { ok: false; status: number; problem: Problem | 'pending'; detail: string | null };

type Raw = { data: unknown; error: { status: number; value?: unknown } | null };

function settle<T>(raw: Raw): Answer<T> {
  if (raw.error) return { ok: false, status: raw.error.status, ...problemOf(raw.error) };
  if (isPending(raw.data)) return { ok: false, status: 202, problem: 'pending', detail: null };
  if (raw.data === null || raw.data === undefined) return { ok: false, status: 503, problem: 'unavailable', detail: null };
  return { ok: true, data: raw.data as T };
}

export interface Written { revision: string; occurrences?: string[] }
const idOf = (iri: string) => iri.slice(-36);

async function fetchRecipePage(main: MainClient, work: string, actingSubject: string, cursor?: string): Promise<RecipeFetch> {
  const raw = await main.v1.recipes.works({ id: idOf(work) }).get({ query: { actingSubject, ...(cursor ? { cursor } : {}) } }) as Raw;
  if (raw.error) return { ok: false, status: raw.error.status, value: raw.error.value ?? null };
  return { ok: true, page: (raw.data ?? null) as RecipePageLike | null };
}

/**
 * The recipe at its current head, or an empty recipe for a Work that has no Composition yet.
 * Every page is read: a save planned from the first page alone would drop the rest.
 */
export async function readRecipe(main: MainClient, work: string, actingSubject: string,
  report?: (loaded: number) => void): Promise<Answer<RecipeState>> {
  const loaded = await loadRecipe(cursor => fetchRecipePage(main, work, actingSubject, cursor), report);
  if (loaded.ok) return { ok: true, data: loaded.state };
  if (loaded.kind === 'stale') return { ok: false, status: 409, problem: 'stale', detail: null };
  return { ok: false, status: loaded.kind === 'too-large' ? 422 : 503, problem: 'unavailable',
    detail: loaded.kind === 'too-large' ? 'too-large' : null };
}

/** Starts the Work's recipe Composition. The key is the Work's own, so every tab starts the same one. */
export function createRecipe(main: MainClient, input: { work: string; mainVersion: string; actingSubject: string }) {
  return main.v1.compositions.post({ profile: 'recipe-composition', work: input.work, mainVersion: input.mainVersion,
    actingSubject: input.actingSubject }, { headers: { 'idempotency-key': `recipe-composition:${idOf(input.work)}` } })
    .then(raw => settle<{ structure: string; revision: string }>(raw as Raw));
}

/** Sends a planned change at `head`; `key` makes a repeat of this exact write at this head replay instead of double. */
export async function writePlan(main: MainClient, input: { structure: string; head: string; actingSubject: string; plan: Plan;
  key: string }): Promise<Answer<Written>> {
  const headers = { 'idempotency-key': input.key };
  const { plan, structure, head, actingSubject } = input;
  const id = idOf(structure);
  if (plan.kind === 'changes') {
    return settle<Written>(await main.v1.compositions({ id }).changes.post({ profile: 'recipe-composition', expectedHead: head,
      operations: plan.operations satisfies Operation[] as never, actingSubject }, { headers }) as Raw);
  }
  if (plan.kind === 'yield') {
    return settle<Written>(await main.v1.recipes({ id }).measures.post({ expectedHead: head, actingSubject, ...plan.body } as never,
      { headers }) as Raw);
  }
  if (plan.kind === 'timings') {
    return settle<Written>(await main.v1.recipes({ id }).timings.post({ expectedHead: head, actingSubject, ...plan.body } as never,
      { headers }) as Raw);
  }
  return { ok: false, status: 400, problem: 'invalid', detail: null };
}

export const browserMain = (): MainClient => browserMainApi();
