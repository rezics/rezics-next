import { withoutVerifiedImmutableObjectCache } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { assertWorkCostAtScales, type WorkCostContract, type WorkProfile } from './work-profile.ts';

export type RecipeReader = 'published-reader' | 'author-preview';
export type RecipePage = {
  profile: 'recipe-work-page-v1'; structure: string; revision: string;
  occurrences: Array<{ occurrence: string; role: string }>;
  next?: string;
  cost: { pages: number; pagesRead: number; occurrences: number };
};
export type RecipeTreeCensus = {
  structure: string; revision: string; occurrences: number; depth: number;
  nodeCount: number; manifestNodes: number; recordNodes: number; orderNodes: number;
  recordDepth: number; orderDepth: number;
  objectPaths: string[]; occurrenceOrder: string[];
};
export type RecipeFetch = { peer: string; origin: string; path: string; method: string; count: number };
export type RecipeCostSample = WorkProfile & { dimensions: { threads: number } };
export type RecipeCostSeries = Record<RecipeReader, {
  firstPages: RecipeCostSample[]; continuations: RecipeCostSample[];
}>;

export const RECIPE_GROWTH_COVERAGE = 'depth: not covered; continuation: medium/large only, small has no continuation';

export function recipeSectionDepthTodo(maxDepth: number): string {
  return `recipeSectionDepth at 1/${Math.floor(maxDepth / 2)}/${maxDepth}; unit: one nested Recipe section ancestor; `
    + 'expected class: linear in section depth, because cursor reads revalidate each ancestor; depth: not covered';
}

export function recipeRemoteCost(readBound: number): WorkCostContract {
  return {
    fusekiRequests: readBound * 4 + 16, fusekiSentBytes: 1_048_576, fusekiReceivedBytes: 16_777_216,
    postgresStatements: 256, accountCalls: 0, otherFetches: 0, unclassifiedFetches: 0,
    growth: Object.fromEntries(['mainCalls', 'fusekiRequests', 'fusekiSentBytes', 'fusekiReceivedBytes',
      'postgresStatements', 'accountCalls', 'otherFetches', 'unclassifiedFetches']
      .map(counter => [counter, { class: 'constant' as const, dimension: 'threads' as const }])),
  };
}

export function recipeCostSample(profile: WorkProfile, unrelatedWorks: number): RecipeCostSample {
  // The shared checker exposes a separate numeric dimension as `threads`.
  // It carries the corpus scale here; every measured counter stays intact.
  return { ...profile, dimensions: { threads: unrelatedWorks } };
}

export function assertRecipeSeriesCosts(series: RecipeCostSeries, contract: WorkCostContract): void {
  const failures: Error[] = [];
  for (const reader of ['published-reader', 'author-preview'] as const) {
    for (const read of ['firstPages', 'continuations'] as const) {
      const label = `recipe-work-page-${reader}-${read === 'firstPages' ? 'first-page' : 'continuation'}`;
      try { assertWorkCostAtScales(series[reader][read], contract, label); }
      catch (error) { failures.push(new Error(`${label}: ${String(error)}`, { cause: error })); }
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
}

export function recipeObjectBudget(census: RecipeTreeCensus, pageSize: number) {
  const keyedPathBudget = pageSize * (census.depth + 1);
  return { ...census, pageSize, keyedPathBudget,
    maximumDistinctKeys: Math.min(census.nodeCount, keyedPathBudget), fullWalkDetectable: census.nodeCount > keyedPathBudget };
}

export function budgetRecipeProfile(profile: WorkProfile, inventory: readonly RecipeFetch[],
  census: RecipeTreeCensus, objectOrigin: string, pageSize: number) {
  if (profile.otherFetches === null) throw new Error('Recipe other fetches are unobserved');
  const ownKeys = new Set(census.objectPaths);
  const ownFetches = inventory.filter(item => item.peer === 'other' && item.method === 'GET'
    && item.origin === objectOrigin && ownKeys.has(item.path));
  const gets = ownFetches.reduce((sum, item) => sum + item.count, 0);
  const distinctKeys = new Set(ownFetches.map(item => item.path)).size;
  if (gets > profile.otherFetches) throw new Error('Recipe object inventory exceeds measured other fetches');
  const budget = { ...recipeObjectBudget(census, pageSize), gets, distinctKeys,
    unknownOtherFetches: profile.otherFetches - gets };
  return { budget, profile: { ...profile, otherFetches: budget.unknownOtherFetches } };
}

export function assertRecipeObjectBudget(budget: ReturnType<typeof budgetRecipeProfile>['budget']): void {
  if (budget.distinctKeys > budget.maximumDistinctKeys)
    throw new Error(`Recipe distinct Structure keys: ${budget.distinctKeys} > ${budget.maximumDistinctKeys}`);
  // The measures read and child-page read each fetch the same immutable
  // manifest. Kernel permits this constant duplicate manifest GET per request.
  if (budget.gets > budget.distinctKeys + 1)
    throw new Error(`Recipe Structure GETs: ${budget.gets} > ${budget.distinctKeys} distinct keys + 1 duplicate manifest`);
}

export function assertRecipePageComplete(page: RecipePage, census: RecipeTreeCensus, offset: number, pageSize: number): void {
  if (page.profile !== 'recipe-work-page-v1' || page.structure !== census.structure || page.revision !== census.revision)
    throw new Error('Recipe page differs from the independently pinned census');
  const expected = census.occurrenceOrder.slice(offset, offset + pageSize);
  const actual = page.occurrences.map(item => item.occurrence);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Recipe page identities or order are incomplete');
  const more = offset + expected.length < census.occurrenceOrder.length;
  if (more ? !page.next : page.next !== undefined) throw new Error('Recipe continuation does not match remaining occurrences');
}

export function recipeReaderRequest(href: string, reader: RecipeReader, author: { token: string; actor: string },
  traceHeaders: Headers, cursor?: string): Request {
  const url = new URL(href, 'http://main.local');
  if (url.origin !== 'http://main.local' || !url.pathname.startsWith('/v1/recipes/works/'))
    throw new Error('Recipe selection must resolve to Main\'s Recipe Work read');
  const headers = new Headers(traceHeaders);
  if (reader === 'author-preview') {
    headers.set('authorization', `Bearer ${author.token}`);
    url.searchParams.set('actingSubject', author.actor);
  } else {
    headers.delete('authorization');
    headers.delete('cookie');
    url.searchParams.delete('actingSubject');
  }
  if (cursor) url.searchParams.set('cursor', cursor);
  return new Request(url, { headers, credentials: 'omit' });
}

export function coldRecipeRequest<T>(read: () => Promise<T>): Promise<T> {
  return withoutVerifiedImmutableObjectCache(read);
}

export async function finishRecipeGrowth(steps: readonly { name: string; run: () => unknown | Promise<unknown> }[],
  primaryFailure?: { error: unknown }): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try { await step.run(); }
    catch (error) { failures.push(new Error(`${step.name}: ${String(error)}`, { cause: error })); }
  }
  if (primaryFailure) {
    if (failures.length) console.error('Recipe growth cleanup failures:', failures.map(error => error.message).join('\n'));
    throw primaryFailure.error;
  }
  if (failures.length) throw new AggregateError(failures, 'Recipe growth artifacts or cleanup failed');
}
