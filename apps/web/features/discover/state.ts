import { type BrowseScope, iriOf, isUuid, parseScope, scopeQuery, type SearchParams, single,
  withQuery } from './scope.ts';
import { registryEntries, type TypeEntry } from '../catalogue/types.ts';
import type { DiscoveryItem, DiscoveryQuery } from './types.ts';

/** A filter identity is the served type IRI. Shelf order is presentation only. */
export type WorkTypeKey = string;
export interface WorkTypeChoice { key: WorkTypeKey; iri: string; entry: TypeEntry }
const preferredShelves = ['book', 'guide', 'recipe'];
export function workTypes(): readonly WorkTypeChoice[] {
  const order = (entry: TypeEntry) => {
    const preferred = preferredShelves.indexOf(entry.presentation);
    return preferred < 0 ? preferredShelves.length : preferred;
  };
  return registryEntries().filter(entry => entry.base === 'work' && !entry.default)
    .map(entry => ({ key: entry.type, iri: entry.type, entry }))
    .sort((a, b) => order(a.entry) - order(b.entry) || a.entry.priority - b.entry.priority
      || a.iri.localeCompare(b.iri));
}
export const workTypeKeys = () => workTypes().map(type => type.iri);
/** Migrate the three historical URL aliases without creating another type inventory. */
export function workTypeIri(value: string): string | null {
  return workTypes().find(type => type.iri === value
    || type.entry.presentation === (value === 'document' ? 'guide' : value))?.iri ?? null;
}

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
  if (type !== null && !workTypeIri(type)) return null;
  // Main defines no personal classification, so Mine never filters by term.
  if (scope.kind === 'mine' && term !== null) return null;
  return { scope, context, type: type === null ? null : workTypeIri(type), term,
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
 * readers' favorite books, then recent Works of each served type; a
 * kind shows its favorites and newest; a genre its popular and newest. Top
 * rated needs a rating question (`ranked`); Mine is the reader's own ratings.
 */
export function shelvesFor(input: DiscoverState, ranked = false): ShelfSpec[] {
  // Without the registry no type has an IRI to filter by: show generic, unfiltered shelves.
  const types = workTypeKeys();
  const known = types.length > 0;
  const state = { ...input, type: input.type === null ? null : workTypeIri(input.type) ?? input.type };
  if (state.conditions?.include.length || state.conditions?.exclude.length) {
    if (state.scope.kind === 'mine') {
      return ranked ? [{ key: 'mine', topic: { kind: 'mine', type: state.type }, sort: 'top-rated', type: state.type,
        term: null }] : [];
    }
    const selected = state.type ? [state.type] : known ? types : [null];
    return selected.flatMap(type => [...(ranked ? [favorites(type)] : []), recent(type)]);
  }
  if (state.scope.kind === 'mine') {
    return ranked ? [{ key: 'mine', topic: { kind: 'mine', type: state.type }, sort: 'top-rated', type: state.type,
      term: null }] : [];
  }
  if (state.term) {
    return [...(ranked ? [termShelf(state.term, state.type, true)] : []), termShelf(state.term, state.type, false)];
  }
  if (state.type) return [...(ranked ? [favorites(state.type)] : []), recent(state.type)];
  if (!known) return [...(ranked ? [favorites(null)] : []), recent(null)];
  return [...(ranked ? [favorites(types[0]!)] : []), ...types.map(recent)];
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
  // A retained type filter stays explicit if the served registry is temporarily unavailable.
  const typeIri = shelf.type ? workTypeIri(shelf.type) ?? shelf.type : undefined;
  return { scope: scope.kind, ...(scope.kind === 'realm' ? { realm: iriOf(scope.realm) } : {}),
    sort: shelf.sort, limit: options.limit, language: options.language,
    ...(ranked && options.context ? { context: iriOf(options.context) } : {}),
    ...(typeIri ? { type: typeIri as NonNullable<DiscoveryQuery['type']> } : {}),
    ...(shelf.term ? { term: iriOf(shelf.term) } : {}),
    ...(scope.kind === 'mine' && options.actingSubject ? { actingSubject: options.actingSubject } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}) };
}
