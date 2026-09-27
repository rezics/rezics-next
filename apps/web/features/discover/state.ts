import { type BrowseScope, iriOf, isUuid, parseScope, scopeQuery, type SearchParams, single,
  withQuery } from './scope.ts';
import type { DiscoveryQuery } from './types.ts';

/** The Work types discovery can filter by, in shelf order; Main's `discoveryType` literals. */
export const workTypes = [
  { key: 'book', iri: 'https://schema.org/Book' },
  { key: 'document', iri: 'https://schema.org/DigitalDocument' },
  { key: 'recipe', iri: 'https://schema.org/Recipe' },
] as const satisfies readonly { key: string; iri: NonNullable<DiscoveryQuery['type']> }[];
export type WorkTypeKey = (typeof workTypes)[number]['key'];

export const workTypeOf = (iri: string): WorkTypeKey | null =>
  workTypes.find(type => type.iri === iri)?.key ?? null;

/**
 * `/discover` as the URL gives it. `context` is the standing rating Context
 * (a question) that top-rated and Mine rank by; Main never picks one silently.
 * `term` is a classification Sense.
 */
export interface DiscoverState {
  scope: BrowseScope;
  context: string | null;
  type: WorkTypeKey | null;
  term: string | null;
}

/** The URL's discover state, or null when a value is malformed: a filtered view never widens. */
export function parseDiscoverState(params: SearchParams): DiscoverState | null {
  const scope = parseScope(params);
  if ([params.context, params.type, params.term].some(Array.isArray)) return null;
  const context = single(params.context) ?? null;
  const type = single(params.type) ?? null;
  const term = single(params.term) ?? null;
  if (!scope || (context !== null && !isUuid(context)) || (term !== null && !isUuid(term))) return null;
  if (type !== null && !workTypes.some(item => item.key === type)) return null;
  // Main defines no personal classification, so Mine never filters by term.
  if (scope.kind === 'mine' && term !== null) return null;
  return { scope, context, type: type as WorkTypeKey | null, term };
}

export function discoverHref(state: DiscoverState): string {
  return withQuery('/discover', { ...scopeQuery(state.scope), context: state.context, type: state.type,
    term: state.term });
}

/** One row of Works: an order, the filters it adds and the Context it ranks by. */
export interface ShelfSpec {
  key: string;
  sort: 'recent' | 'top-rated';
  type: WorkTypeKey | null;
  term: string | null;
}

/**
 * The shelves a state shows. A filtered view is one recent shelf (plus top rated
 * when a Context is chosen); the overview adds a recent shelf per Work type.
 * Mine ranks the person's own ratings, so without a Context it has no shelf.
 */
export function shelvesFor(state: DiscoverState): ShelfSpec[] {
  const ranked = state.context !== null;
  if (state.scope.kind === 'mine' && !ranked) return [];
  const focus = { type: state.type, term: state.term };
  const shelves: ShelfSpec[] = [{ key: 'recent', sort: 'recent', ...focus }];
  if (ranked) shelves.push({ key: 'top-rated', sort: 'top-rated', ...focus });
  if (state.type === null && state.term === null) {
    for (const type of workTypes) {
      shelves.push({ key: `recent-${type.key}`, sort: 'recent', type: type.key, term: null });
    }
  }
  return shelves;
}

/**
 * Main's query for one page of a shelf. Each (scope, Realm, Context) is its own
 * built population, so recent shelves read the Context-free one except in
 * Mine, whose population is always one Context's ratings.
 */
export function discoveryQuery(state: DiscoverState, shelf: ShelfSpec, options: { limit: number;
  language: string; actingSubject?: string; cursor?: string }): DiscoveryQuery {
  const { scope } = state;
  const ranked = shelf.sort === 'top-rated' || scope.kind === 'mine';
  return { scope: scope.kind, ...(scope.kind === 'realm' ? { realm: iriOf(scope.realm) } : {}),
    sort: shelf.sort, limit: options.limit, language: options.language,
    ...(ranked && state.context ? { context: iriOf(state.context) } : {}),
    ...(shelf.type ? { type: workTypes.find(type => type.key === shelf.type)!.iri } : {}),
    ...(shelf.term ? { term: iriOf(shelf.term) } : {}),
    ...(scope.kind === 'mine' && options.actingSubject ? { actingSubject: options.actingSubject } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}) };
}
