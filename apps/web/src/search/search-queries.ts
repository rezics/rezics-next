import { queryOptions } from '@tanstack/react-query';
import { publicRead } from '../kernel/query';
import { readSearch } from './search.tsx';
import type { SearchLoaderDeps } from './search-params';

export function searchQueryOptions(locale: string, params: SearchLoaderDeps) {
  return queryOptions({
    ...publicRead,
    staleTime: 0,
    gcTime: 0,
    queryKey: ['search', 'discovery-v1', 'anonymous', 'public-global', locale, params],
    queryFn: ({ signal }) =>
      readSearch({
        locale,
        signal,
        data: {
          query: params.query,
          ...(params.type ? { type: params.type } : {}),
          facetValues: params.facets,
          ...(params.ranges ? { ranges: params.ranges } : {}),
          ...(params.condition ? { condition: params.condition } : {}),
          ...(params.cursor ? { cursor: params.cursor } : {}),
          ...(params.sort ? { sort: params.sort } : {}),
        },
      }),
  });
}
