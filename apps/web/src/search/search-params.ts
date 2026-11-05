import {
  isSearchResourceScope,
  parseSearchResourceScope,
  removeSearchResourceScope,
  searchFilterWithScope,
  type SearchResourceScope,
} from './advanced-scope';
import { searchInputDependency, searchLoaderDepsFromIntake, searchUrlIntake } from './search-input/intake';
import type { FilterDocument, FilterRange } from '@rezics/filter';
import { RATING_POPULATION_FIELD } from './rating-population';
import * as v from 'valibot';

/** The route boundary retains raw JSON and repeated shapes for local admission. */
export const searchParams = v.record(v.string(), v.unknown());

export type SearchParams = v.InferOutput<typeof searchParams>;
export type SearchFacetValues = Record<string, string[]>;
export type InvalidSearchInput = { key: string; value: string };

export type SearchLoaderDeps = {
  query: string;
  type: string | undefined;
  facets: SearchFacetValues;
  ranges?: Record<string, FilterRange>;
  condition?: FilterDocument | undefined;
  cursor: string | undefined;
  sort: 'rating' | undefined;
  kinds?: string[] | undefined;
  languages?: string[] | undefined;
  filter?: string | undefined;
  resourceScope?: SearchResourceScope | undefined;
  ratingPopulation?: string | undefined;
  invalidInput?: InvalidSearchInput | undefined;
};

export type { SearchInputIssue, SearchInputIssueReason, SearchUrlIntake } from './search-input/intake';
export { searchInputDependency, searchUrlIntake } from './search-input/intake';

export function searchLoaderDeps(search: Record<string, unknown>): SearchLoaderDeps {
  return searchLoaderDepsFromIntake(searchUrlIntake(search));
}

export { facetValuesFromSearch, rangeValuesFromSearch } from './search-input/intake';

/** Carry URL inputs through the header's ordinary GET form without parsing away an invalid predicate. */
export function searchFormFields(search: Record<string, unknown>): [string, string][] {
  const fields: [string, string][] = [];
  const append = (key: string, value: unknown) => {
    if (typeof value === 'string') fields.push([key, value]);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      for (const item of value) fields.push([key, item]);
    }
  };

  if (typeof search.type === 'string' && search.type) append('type', search.type);
  if (search.sort === 'rating') append('sort', 'rating');
  if (typeof search[RATING_POPULATION_FIELD] === 'string' && search[RATING_POPULATION_FIELD] !== '')
    append(RATING_POPULATION_FIELD, search[RATING_POPULATION_FIELD]);
  const scope = isSearchResourceScope(search.resourceScope)
    ? search.resourceScope
    : typeof search.filter === 'string'
      ? parseSearchResourceScope(search.filter).scope
      : undefined;
  const filter = typeof search.filter === 'string' ? searchFilterWithScope(search.filter, scope) : search.filter;
  if (filter !== undefined && filter !== '') append('filter', filter);
  else if (Array.isArray(search.filter)) append('filter', search.filter);
  append('condition', search.condition);
  for (const [key, value] of Object.entries(search)) {
    if (key.startsWith('r.')) append(key, value);
  }
  append('kinds', search.kinds);
  append('language', search.language);
  for (const [key, value] of Object.entries(search)) {
    if (key.startsWith('f.') && key.length > 2) append(key, value);
  }
  return fields;
}

export function correctSearchInput<Search extends object>(
  search: Search,
  key: string,
  value: string,
  occurrence?: number,
): Search {
  const next = { ...search } as Record<string, unknown>;
  const current = next[key];
  if (occurrence !== undefined && Array.isArray(current)) {
    const updated = [...current];
    updated[occurrence] = value;
    next[key] = updated;
  } else next[key] = value;
  next.cursor = undefined;
  return next as Search;
}

function isRepeatedListKey(key: string): boolean {
  return key === 'kinds' || key === 'language' || key.startsWith('f.');
}

export function removeSearchInput<Search extends object>(search: Search, key: string, occurrence?: number): Search {
  const next = { ...search, cursor: undefined } as Record<string, unknown>;
  const current = next[key];
  if (occurrence !== undefined && Array.isArray(current)) {
    const remaining = [...current];
    remaining.splice(occurrence, 1);
    if (!remaining.length) delete next[key];
    else next[key] = isRepeatedListKey(key) || remaining.length > 1 ? remaining : remaining[0];
  } else if (key === 'filter' && typeof next.filter === 'string') {
    const remaining = removeSearchResourceScope(next.filter);
    if (remaining !== undefined) next.filter = remaining;
    else delete next.filter;
  } else delete next[key];
  return next as Search;
}

/** Native opaque tokens are only encoded for transport, never decoded, trimmed or regenerated. */
export function discoverySearchHref(locale: string, state: SearchLoaderDeps): string {
  const params = new URLSearchParams(
    searchFormFields({
      q: state.query,
      type: state.type,
      sort: state.sort,
      [RATING_POPULATION_FIELD]: state.ratingPopulation,
      filter: state.filter,
      resourceScope: state.resourceScope,
      condition: state.condition ? JSON.stringify(state.condition) : undefined,
      ...Object.fromEntries(
        Object.entries(state.ranges ?? {}).map(([key, range]) => [`r.${key}`, JSON.stringify(range)]),
      ),
      kinds: state.kinds,
      language: state.languages,
      ...Object.fromEntries(Object.entries(state.facets).map(([key, values]) => [`f.${key}`, values])),
    }),
  );
  if (state.query) params.set('q', state.query);
  if (state.cursor) params.set('cursor', state.cursor);
  return `/${encodeURIComponent(locale)}/search${params.size ? `?${params}` : ''}`;
}
