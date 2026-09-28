import type { MainClient } from '../discover/types.ts';

// Main's Concept reads (`services/main/src/routes/concepts.ts`), Facets and
// follow state, taken from the typed Eden client so a contract change breaks this build.
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type ConceptRoute = ReturnType<MainClient['v1']['concepts']>;

export type ConceptRead = Ok<ConceptRoute['get']>;
export type ConceptLink = ConceptRead['broader'][number];
export type ConceptWorksPage = Ok<ConceptRoute['works']['get']>;
export type ConceptWorksQuery = NonNullable<NonNullable<Parameters<ConceptRoute['works']['get']>[0]>['query']>;
export type ConceptValue = ConceptWorksPage['values'][number];
export type ConceptSearchItem = Ok<MainClient['v1']['concepts']['get']>['items'][number];
export type FacetList = Ok<MainClient['v1']['facets']['get']>;
export type Facet = FacetList['facets'][number];
/** Followers of a Concept, and whether the reader follows it (`/v1/follows/{id}?kind=concept`). */
export type ConceptFollowState = Ok<ReturnType<MainClient['v1']['follows']>['get']>;

/**
 * Why a region has no data; each region shows its own and the page stays.
 * `missing` is Main's 404 (the Concept, or a value in the bar, is not public),
 * `unbuilt` its 503 while the scope's Works are not prepared, `moved` a 409
 * under a cursor, `invalid` a refused Condition bar.
 */
export type ReadFailure = 'missing' | 'moved' | 'invalid' | 'unbuilt' | 'unavailable';
export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };

export function failureOf(status: number, code?: string): ReadFailure {
  if (status === 404) return 'missing';
  if (status === 409) return 'moved';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 503 && code === 'discovery_unavailable') return 'unbuilt';
  return 'unavailable';
}
