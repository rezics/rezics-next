import { FILTER_LIMITS } from '@rezics/filter';
import * as v from 'valibot';

const facetValue = v.fallback(
  v.optional(
    v.union([
      v.string(),
      v.pipe(
        v.array(v.unknown()),
        v.transform((values) =>
          values.slice(0, FILTER_LIMITS.in).filter((value): value is string => typeof value === 'string'),
        ),
      ),
    ]),
  ),
  undefined,
);

/** Validated URL search params. Unknown keys are kept only as facet-shaped values and selected below. */
export const searchParams = v.objectWithRest(
  {
    q: v.fallback(v.pipe(v.string(), v.maxLength(256)), ''),
    type: v.fallback(v.optional(v.pipe(v.string(), v.maxLength(128))), undefined),
    cursor: v.fallback(v.optional(v.pipe(v.string(), v.maxLength(2048))), undefined),
    sort: v.fallback(v.optional(v.picklist(['rating'])), undefined),
  },
  facetValue,
);

export type SearchParams = v.InferOutput<typeof searchParams>;
export type SearchFacetValues = Record<string, string[]>;

export type SearchLoaderDeps = {
  query: string;
  type: string | undefined;
  facets: SearchFacetValues;
  cursor: string | undefined;
  sort: 'rating' | undefined;
};

export function facetValuesFromSearch(search: Record<string, unknown>): SearchFacetValues {
  const facets: SearchFacetValues = Object.create(null);
  for (const [key, value] of Object.entries(search)) {
    if (!key.startsWith('f.') || key.length <= 2) continue;
    const property = key.slice(2);
    if (typeof value === 'string') facets[property] = [value];
    else if (Array.isArray(value))
      facets[property] = value.slice(0, FILTER_LIMITS.in).filter((item): item is string => typeof item === 'string');
  }
  return facets;
}

/** The only URL params that affect the search loader's read. */
export function searchLoaderDeps(search: Record<string, unknown>): SearchLoaderDeps {
  return {
    query: typeof search.q === 'string' ? search.q : '',
    type: typeof search.type === 'string' ? search.type : undefined,
    facets: facetValuesFromSearch(search),
    cursor: typeof search.cursor === 'string' ? search.cursor : undefined,
    sort: search.sort === 'rating' ? 'rating' : undefined,
  };
}

/** Carry the route's supported conditions through the header's ordinary GET form; a new query drops its cursor. */
export function searchFormFields(search: Record<string, unknown>): [string, string][] {
  const { type, facets, sort } = searchLoaderDeps(search);
  return [
    ...(type ? [['type', type] as [string, string]] : []),
    ...(sort ? [['sort', sort] as [string, string]] : []),
    ...Object.entries(facets).flatMap(([property, values]) =>
      values.map((value): [string, string] => [`f.${property}`, value]),
    ),
  ];
}
