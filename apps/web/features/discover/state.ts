import { type BrowseScope, iriOf, isUuid, parseScope, scopeQuery, type SearchParams, single,
  withQuery } from './scope.ts';
import type { DiscoveryItem, DiscoveryQuery } from './types.ts';

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
 * `/discover` as the URL gives it. `context` pins a standing rating Context
 * (a question); without one the page ranks by the first Context Main lists
 * for the scope, so links never need it. `term` is a classification Sense.
 */
export interface DiscoverState {
  scope: BrowseScope;
  context: string | null;
  type: WorkTypeKey | null;
  term: string | null;
  conditions?: { include: string[]; exclude: string[]; match: 'all' | 'any' };
}

/** The URL's discover state, or null when a value is malformed: a filtered view never widens. */
export function parseDiscoverState(params: SearchParams): DiscoverState | null {
  const scope = parseScope(params);
  if ([params.context, params.type, params.term, params.ci, params.ce, params.cm].some(Array.isArray)) return null;
  const context = single(params.context) ?? null;
  const type = single(params.type) ?? null;
  const term = single(params.term) ?? null;
  const list = (raw: string | undefined) => raw === undefined || raw === '' ? [] : raw.split(',');
  const include = list(single(params.ci)), exclude = list(single(params.ce));
  const match = single(params.cm) ?? 'all';
  if (!scope || (context !== null && !isUuid(context)) || (term !== null && !isUuid(term))
    || ![...include, ...exclude].every(isUuid) || new Set([...include, ...exclude]).size
      !== include.length + exclude.length || (match !== 'all' && match !== 'any')) return null;
  if (type !== null && !workTypes.some(item => item.key === type)) return null;
  // Main defines no personal classification, so Mine never filters by term.
  if (scope.kind === 'mine' && term !== null) return null;
  return { scope, context, type: type as WorkTypeKey | null, term,
    ...(include.length || exclude.length || match !== 'all' ? { conditions: { include, exclude, match } } : {}) };
}

export function discoverHref(state: DiscoverState): string {
  return withQuery('/discover', { ...scopeQuery(state.scope), context: state.context, type: state.type,
    term: state.term, ci: state.conditions?.include.join(','), ce: state.conditions?.exclude.join(','),
    cm: (state.conditions?.include.length ?? 0) > 1 && state.conditions?.match === 'any' ? 'any' : null });
}

/**
 * What a shelf lists, which names it for readers: favorites (top rated),
 * recently added, or one genre (a classification term). Each shelf holds one
 * kind of Work unless the reader asked for all, so a novel never sits beside
 * a recipe.
 */
export type ShelfTopic =
  | { kind: 'favorites' | 'recent'; type: WorkTypeKey | null }
  | { kind: 'popular-in' | 'new-in'; type: WorkTypeKey | null; term: string }
  | { kind: 'mine'; type: WorkTypeKey | null };

/** One row of Works: its topic, Main's order and filters. */
export interface ShelfSpec {
  key: string;
  topic: ShelfTopic;
  sort: 'recent' | 'top-rated';
  type: WorkTypeKey | null;
  term: string | null;
}

const favorites = (type: WorkTypeKey | null): ShelfSpec =>
  ({ key: `favorites-${type ?? 'all'}`, topic: { kind: 'favorites', type }, sort: 'top-rated', type, term: null });
const recent = (type: WorkTypeKey | null): ShelfSpec =>
  ({ key: `recent-${type ?? 'all'}`, topic: { kind: 'recent', type }, sort: 'recent', type, term: null });

/** A genre shelf: top rated when the scope has a rating question, else newest first. */
export function termShelf(term: string, type: WorkTypeKey | null, ranked: boolean): ShelfSpec {
  return { key: `${ranked ? 'popular' : 'new'}-${term}`, topic: { kind: ranked ? 'popular-in' : 'new-in', type, term },
    sort: ranked ? 'top-rated' : 'recent', type, term };
}

/**
 * The shelves a state shows before genres are known. The overview leads with
 * readers' favorite books, then recently added books, guides and recipes; a
 * kind shows its favorites and newest; a genre its popular and newest. Top
 * rated needs a rating question (`ranked`); Mine is the reader's own ratings.
 */
export function shelvesFor(state: DiscoverState, ranked = false): ShelfSpec[] {
  if (state.conditions?.include.length || state.conditions?.exclude.length) {
    return state.type ? [recent(state.type)] : [recent('book'), recent('document'), recent('recipe')];
  }
  if (state.scope.kind === 'mine') {
    return ranked ? [{ key: 'mine', topic: { kind: 'mine', type: state.type }, sort: 'top-rated', type: state.type,
      term: null }] : [];
  }
  if (state.term) {
    return [...(ranked ? [termShelf(state.term, state.type, true)] : []), termShelf(state.term, state.type, false)];
  }
  if (state.type) return [...(ranked ? [favorites(state.type)] : []), recent(state.type)];
  return [...(ranked ? [favorites('book')] : []), recent('book'), recent('document'), recent('recipe')];
}

/** The overview's genre shelves: the terms most often on its first books, most frequent first. */
export function genreTerms(items: readonly DiscoveryItem[], limit = 2): { term: string; name: DiscoveryItem['classifications'][number]['name'] }[] {
  const counted = new Map<string, { count: number; name: DiscoveryItem['classifications'][number]['name'] }>();
  for (const tag of items.flatMap(item => item.classifications)) {
    const id = tag.sense.slice(-36);
    if (!isUuid(id)) continue;
    counted.set(id, { count: (counted.get(id)?.count ?? 0) + 1, name: tag.name });
  }
  return [...counted].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit).map(([term, entry]) => ({ term, name: entry.name }));
}

/**
 * Main's query for one page of a shelf. Each (scope, Realm, Context) is its
 * own built population, so recent shelves read the Context-free one except in
 * Mine, whose population is always one Context's ratings.
 */
export function discoveryQuery(state: DiscoverState, shelf: ShelfSpec, options: { limit: number;
  language: string; context?: string | null; actingSubject?: string; cursor?: string }): DiscoveryQuery {
  const { scope } = state;
  const ranked = shelf.sort === 'top-rated' || scope.kind === 'mine';
  return { scope: scope.kind, ...(scope.kind === 'realm' ? { realm: iriOf(scope.realm) } : {}),
    sort: shelf.sort, limit: options.limit, language: options.language,
    ...(ranked && options.context ? { context: iriOf(options.context) } : {}),
    ...(shelf.type ? { type: workTypes.find(type => type.key === shelf.type)!.iri } : {}),
    ...(shelf.term ? { term: iriOf(shelf.term) } : {}),
    ...(scope.kind === 'mine' && options.actingSubject ? { actingSubject: options.actingSubject } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}) };
}
