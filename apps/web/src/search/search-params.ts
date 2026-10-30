import { parseFilter, FILTER_LIMITS, type FilterDocument, type FilterRange } from '@rezics/filter';
import * as v from 'valibot';

const facetValue = v.optional(v.union([v.string(), v.pipe(v.array(v.string()), v.maxLength(FILTER_LIMITS.in))]));

/** Validated URL search params. Unknown keys are kept only as facet-shaped values and selected below. */
export const searchParams = v.objectWithRest(
  {
    q: v.fallback(v.pipe(v.string(), v.maxLength(256)), ''),
    type: v.fallback(v.optional(v.pipe(v.string(), v.maxLength(128))), undefined),
    cursor: v.fallback(v.optional(v.pipe(v.string(), v.maxLength(2048))), undefined),
    condition: v.optional(v.pipe(v.string(), v.maxLength(32768))),
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
  ranges?: Record<string, FilterRange>;
  condition?: FilterDocument;
  cursor: string | undefined;
  sort: 'rating' | undefined;
};

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
  const ranges: Record<string, FilterRange> = Object.create(null);
  for (const [key, value] of Object.entries(search)) {
    if (!key.startsWith('r.') || typeof value !== 'string') continue;
    const parsed = parseFilter({ statement: { property: key.slice(2), range: JSON.parse(value) } });
    if ('statement' in parsed && 'range' in parsed.statement) ranges[key.slice(2)] = parsed.statement.range;
  }
  return ranges;
}

/** The only URL params that affect the search loader's read. */
export function searchLoaderDeps(search: Record<string, unknown>): SearchLoaderDeps {
  return {
    query: typeof search.q === 'string' ? search.q : '',
    type: typeof search.type === 'string' ? search.type : undefined,
    facets: facetValuesFromSearch(search),
    ranges: rangeValuesFromSearch(search),
    ...(typeof search.condition === 'string' ? { condition: parseFilter(JSON.parse(search.condition)) } : {}),
    cursor: typeof search.cursor === 'string' ? search.cursor : undefined,
    sort: search.sort === 'rating' ? 'rating' : undefined,
  };
}

/** Carry the route's supported conditions through the header's ordinary GET form; a new query drops its cursor. */
export function searchFormFields(search: Record<string, unknown>): [string, string][] {
  const { type, facets, ranges, condition, sort } = searchLoaderDeps(search);
  return [
    ...(type ? [['type', type] as [string, string]] : []),
    ...(sort ? [['sort', sort] as [string, string]] : []),
    ...(condition ? [['condition', JSON.stringify(condition)] as [string, string]] : []),
    ...Object.entries(ranges ?? {}).map(([property, range]): [string, string] => [
      `r.${property}`,
      JSON.stringify(range),
    ]),
    ...Object.entries(facets).flatMap(([property, values]) =>
      values.map((value): [string, string] => [`f.${property}`, value]),
    ),
  ];
}
