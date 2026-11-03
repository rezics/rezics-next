import { parseFilter, FILTER_LIMITS, type FilterDocument, type FilterRange } from '@rezics/filter';
import * as v from 'valibot';
import {
  isSearchResourceScope,
  parseSearchResourceScope,
  removeSearchResourceScope,
  searchFilterWithScope,
  type SearchResourceScope,
} from './advanced-scope';

const facetValue = v.optional(v.union([v.string(), v.pipe(v.array(v.string()), v.maxLength(FILTER_LIMITS.in))]));

const strings = (maximum: number) =>
  v.pipe(
    v.union([v.string(), v.array(v.string())]),
    v.transform((value) => (typeof value === 'string' ? [value] : value)),
    v.maxLength(maximum),
  );

/** Validated URL search params. Unknown keys are kept only as facet-shaped values and selected below. */
export const searchParams = v.objectWithRest(
  {
    q: v.optional(
      v.pipe(
        v.string(),
        v.check((text) => new TextEncoder().encode(text).length <= 512),
      ),
      '',
    ),
    type: v.optional(v.pipe(v.string(), v.maxLength(128))),
    cursor: v.optional(v.pipe(v.string(), v.maxLength(4864))),
    kinds: v.optional(strings(FILTER_LIMITS.in)),
    language: v.optional(
      v.pipe(
        strings(8),
        v.check((tags) => tags.every((tag) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(tag) && tag.length <= 35)),
      ),
    ),
    condition: v.optional(v.pipe(v.string(), v.maxLength(32768))),
    filter: v.optional(
      v.union([
        v.pipe(v.string(), v.maxLength(16384)),
        v.pipe(v.array(v.pipe(v.string(), v.maxLength(16384))), v.maxLength(8)),
      ]),
    ),
    sort: v.optional(
      v.pipe(
        v.union([v.picklist(['rating']), v.literal('')]),
        v.transform((sort) => (sort === '' ? undefined : sort)),
      ),
    ),
  },
  facetValue,
);

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
  invalidInput?: InvalidSearchInput | undefined;
};

function printableSearchValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function filterInputsFromSearch(search: Record<string, unknown>): {
  ranges: Record<string, FilterRange>;
  condition?: FilterDocument;
  invalidInput?: InvalidSearchInput;
} {
  const ranges: Record<string, FilterRange> = Object.create(null);
  let condition: FilterDocument | undefined;
  let invalidInput: InvalidSearchInput | undefined;
  const invalid = (key: string, value: unknown) => {
    invalidInput ??= { key, value: printableSearchValue(value) };
  };

  if (search.condition !== undefined) {
    if (typeof search.condition !== 'string') invalid('condition', search.condition);
    else {
      try {
        condition = parseFilter(JSON.parse(search.condition));
      } catch {
        invalid('condition', search.condition);
      }
    }
  }

  for (const [key, value] of Object.entries(search)) {
    if (!key.startsWith('r.')) continue;
    if (typeof value !== 'string') {
      invalid(key, value);
      continue;
    }
    try {
      const parsed = parseFilter({ statement: { property: key.slice(2), range: JSON.parse(value) } });
      if ('statement' in parsed && 'range' in parsed.statement) ranges[key.slice(2)] = parsed.statement.range;
      else invalid(key, value);
    } catch {
      invalid(key, value);
    }
  }

  return { ranges, ...(condition ? { condition } : {}), ...(invalidInput ? { invalidInput } : {}) };
}

export function facetValuesFromSearch(search: Record<string, unknown>): SearchFacetValues {
  const facets: SearchFacetValues = Object.create(null);
  for (const [key, value] of Object.entries(search)) {
    if (!key.startsWith('f.') || key.length <= 2) continue;
    const property = key.slice(2);
    if (typeof value === 'string') facets[property] = [value];
    else if (Array.isArray(value)) {
      if (value.length > FILTER_LIMITS.in || value.some((item) => typeof item !== 'string'))
        throw new Error('Invalid facet values');
      facets[property] = value;
    }
  }
  return facets;
}

export function rangeValuesFromSearch(search: Record<string, unknown>): Record<string, FilterRange> {
  return filterInputsFromSearch(search).ranges;
}

/** The only URL params that affect the search loader's read. */
export function searchLoaderDeps(search: Record<string, unknown>): SearchLoaderDeps {
  const filterInputs = filterInputsFromSearch(search);
  const filterValue = search.filter;
  const resourceScope =
    typeof filterValue === 'string' ? parseSearchResourceScope(filterValue) : { scope: undefined, invalidInput: undefined };
  const invalidFilter =
    filterValue !== undefined && typeof filterValue !== 'string'
      ? { key: 'filter', value: printableSearchValue(filterValue) }
      : resourceScope.invalidInput;
  return {
    query: typeof search.q === 'string' ? search.q : '',
    type: typeof search.type === 'string' ? search.type : undefined,
    facets: facetValuesFromSearch(search),
    ranges: filterInputs.ranges,
    ...(filterInputs.condition ? { condition: filterInputs.condition } : {}),
    ...(filterInputs.invalidInput ? { invalidInput: filterInputs.invalidInput } : invalidFilter ? { invalidInput: invalidFilter } : {}),
    cursor: typeof search.cursor === 'string' ? search.cursor : undefined,
    sort: search.sort === 'rating' ? 'rating' : undefined,
    ...(typeof search.filter === 'string' ? { filter: search.filter } : {}),
    ...(resourceScope.scope ? { resourceScope: resourceScope.scope } : {}),
    ...(search.kinds
      ? {
          kinds:
            typeof search.kinds === 'string'
              ? [search.kinds]
              : Array.isArray(search.kinds)
                ? search.kinds.filter((kind): kind is string => typeof kind === 'string')
                : [],
        }
      : {}),
    ...(search.language
      ? {
          languages:
            typeof search.language === 'string'
              ? [search.language]
              : Array.isArray(search.language)
                ? search.language.filter((tag): tag is string => typeof tag === 'string')
                : [],
        }
      : {}),
  };
}

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
  const scope = isSearchResourceScope(search.resourceScope)
    ? search.resourceScope
    : typeof search.filter === 'string'
      ? parseSearchResourceScope(search.filter).scope
      : undefined;
  const filter =
    typeof search.filter === 'string' ? searchFilterWithScope(search.filter, scope) : search.filter;
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

export function correctSearchInput<Search extends object>(search: Search, key: string, value: string): Search {
  return Object.assign({}, search, { [key]: value, cursor: undefined }) as Search;
}

export function removeSearchInput<Search extends object>(search: Search, key: string): Search {
  const next = { ...search, cursor: undefined } as Record<string, unknown>;
  if (key === 'filter' && typeof next.filter === 'string') {
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
