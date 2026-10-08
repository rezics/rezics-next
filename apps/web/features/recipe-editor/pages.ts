import { emptyRecipe, type RecipePageLike, type RecipeState, stateOf } from './model.ts';

// Removing a section removes every child and rewrites every step that names those ingredients.
// Moving a line, a step or a section chooses its place among siblings, and editing a step drops
// any ingredient link that is not in hand. Those saves are planned from the recipe held here, so
// the editor reads every remaining page before it will save. The reader takes one page for the
// first view and one more page each time they ask for more. Nothing here is kept for a later visit.

/** The most occurrences the editor will assemble. A further page would still be unread, so nothing is saved. */
export const RECIPE_OCCURRENCE_CAP = 4096;

/**
 * Query for one recipe page. A continuation sends the cursor alone: servings are already pinned in
 * it, and sending both is refused. A new serving count starts again with no cursor.
 */
export function recipePageQuery(actingSubject: string | null | undefined,
  query: { cursor?: string; servings?: number }): Record<string, unknown> {
  const sent: Record<string, unknown> = { actingSubject: actingSubject ?? undefined };
  if (query.cursor) sent.cursor = query.cursor;
  else if (query.servings !== undefined) sent.servings = query.servings;
  return sent;
}

export function isStaleRecipePage(error: { status?: number; value?: unknown } | null | undefined): boolean {
  if (!error || error.status !== 409 || typeof error.value !== 'object' || error.value === null) return false;
  return (error.value as { profile?: unknown }).profile === 'recipe-work-page-stale';
}

function mergeById<T extends { occurrence: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(current.map(item => item.occurrence));
  const merged = [...current];
  for (const item of incoming) if (!seen.has(item.occurrence)) {
    seen.add(item.occurrence);
    merged.push(item);
  }
  return merged;
}

type RecipePageShape = { occurrences: readonly { occurrence: string }[];
  ingredients: readonly { occurrence: string }[]; measures: readonly unknown[]; next?: string };

/** One recipe page followed by the next, in the order they were read. A section started earlier stays that section. */
export function appendRecipePage<T extends RecipePageShape>(current: T, incoming: T): T {
  const merged = { ...incoming, occurrences: mergeById(current.occurrences, incoming.occurrences),
    ingredients: mergeById(current.ingredients, incoming.ingredients),
    measures: incoming.measures.length ? incoming.measures : current.measures };
  if (!incoming.next) delete merged.next;
  return merged;
}

/** The editor's recipe after one more page of the same revision. */
export function mergeRecipeState(current: RecipeState, page: RecipePageLike): RecipeState {
  const incoming = stateOf(page);
  const seen = new Set(current.nodes.map(node => node.occurrence));
  return {
    structure: current.structure ?? incoming.structure,
    head: incoming.head ?? current.head,
    nodes: [...current.nodes, ...incoming.nodes.filter(node => !seen.has(node.occurrence))],
    measures: incoming.measures.length ? incoming.measures : current.measures,
  };
}

export type RecipeFetch =
  | { ok: true; page: RecipePageLike | null }
  | { ok: false; status: number; value: unknown };

/** One page as the reader asked for it. A continuation carries the cursor alone. */
export type RecipePageAnswer<T> = {
  data: T | null;
  error: { status?: number; value?: unknown } | null;
};

/** One recipe page, or the failure of that one call. A failure holds no page. */
export type FilledRecipe<T> =
  | { ok: true; page: T | null }
  | { ok: false; stale: boolean; page: null; error: { status?: number; value?: unknown } };

/**
 * One recipe page. A kernel page already spans sections and holds the occurrences of one view,
 * so this does not follow `next`. A failure is only that call: the page already shown stays put.
 */
export async function readRecipePage<T>(
  read: (query: { cursor?: string; servings?: number }) => Promise<RecipePageAnswer<T>>,
  query: { cursor?: string; servings?: number }): Promise<FilledRecipe<T>> {
  const answer = await read(query);
  if (answer.error) return { ok: false, stale: isStaleRecipePage(answer.error), page: null, error: answer.error };
  return { ok: true, page: answer.data };
}

export type LoadedRecipe =
  | { ok: true; state: RecipeState }
  | { ok: false; kind: 'failed' | 'stale' | 'too-large' };

async function collect(first: RecipePageLike, read: (cursor: string) => Promise<RecipeFetch>,
  report?: (loaded: number) => void): Promise<LoadedRecipe> {
  let state = stateOf(first);
  let cursor = first.next;
  report?.(state.nodes.length);
  for (let guard = 0; cursor; guard += 1) {
    if (state.nodes.length >= RECIPE_OCCURRENCE_CAP || guard >= RECIPE_OCCURRENCE_CAP) return { ok: false, kind: 'too-large' };
    const next = await read(cursor);
    if (!next.ok) return { ok: false, kind: isStaleRecipePage(next) ? 'stale' : 'failed' };
    if (!next.page) return { ok: false, kind: 'failed' };
    const before = state.nodes.length;
    state = mergeRecipeState(state, next.page);
    cursor = next.page.next;
    report?.(state.nodes.length);
    // A cursor that adds nothing would spin. Stop rather than pretend the recipe is complete.
    if (cursor && state.nodes.length === before) return { ok: false, kind: 'failed' };
  }
  return { ok: true, state };
}

/**
 * Every page of one recipe, from the first. A cursor whose revision moved starts again from the
 * first page. Past {@link RECIPE_OCCURRENCE_CAP} the result is not a recipe that can be saved.
 */
export async function loadRecipe(read: (cursor?: string) => Promise<RecipeFetch>,
  report?: (loaded: number) => void): Promise<LoadedRecipe> {
  for (let restart = 0; restart < 3; restart += 1) {
    const first = await read();
    if (!first.ok) return { ok: false, kind: isStaleRecipePage(first) ? 'stale' : 'failed' };
    if (!first.page) {
      report?.(0);
      return { ok: true, state: emptyRecipe };
    }
    const loaded = await collect(first.page, cursor => read(cursor), report);
    if (loaded.ok || loaded.kind !== 'stale') return loaded;
  }
  return { ok: false, kind: 'stale' };
}
