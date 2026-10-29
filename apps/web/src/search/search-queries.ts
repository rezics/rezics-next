import { queryOptions } from '@tanstack/react-query';
import { publicRead } from '../kernel/query';
import { readSearch } from './search.tsx';
import type { SearchLoaderDeps } from './search-params';

export function searchQueryOptions(locale: string, params: SearchLoaderDeps) {
  return queryOptions({
    ...publicRead,
    queryKey: ['search', locale, params],
    queryFn: () =>
      readSearch({
        locale,
        data: {
          query: params.query,
          ...(params.type ? { type: params.type } : {}),
          facetValues: params.facets,
          ...(params.cursor ? { cursor: params.cursor } : {}),
          ...(params.sort ? { sort: params.sort } : {}),
        },
      }),
  });
}
