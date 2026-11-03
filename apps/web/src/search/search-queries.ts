import { queryOptions } from '@tanstack/react-query';
import { personalRead, publicRead } from '../kernel/query';
import { readSearch, type SearchPageData } from './search.tsx';
import type { SearchLoaderDeps } from './search-params';
import { searchUnavailablePage } from './search-recovery';
import { searchRequiresCurrentReader, searchSessionLifetime } from './scoped-search-lifetime';

export function searchQueryOptions(locale: string, params: SearchLoaderDeps, reader?: string) {
  const scoped = searchRequiresCurrentReader(params);
  return queryOptions({
    ...(scoped ? personalRead : publicRead),
    staleTime: 0,
    gcTime: scoped ? 0 : 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryKey: ['search', 'discovery-v1', searchSessionLifetime(locale, params, reader)],
    queryFn: async ({ signal, client, queryKey }) => {
      try {
        return await readSearch({
          locale,
          signal,
          data: {
            query: params.query,
            kinds: params.kinds,
            languages: params.languages,
            filter: params.filter,
            ...(params.resourceScope ? { resourceScope: params.resourceScope } : {}),
            ...(params.ratingPopulation ? { ratingPopulation: params.ratingPopulation } : {}),
            ...(scoped && reader ? { reader } : {}),
            ...(params.ranges ? { ranges: params.ranges } : {}),
            ...(params.condition ? { condition: params.condition } : {}),
            ...(params.type ? { type: params.type } : {}),
            facetValues: params.facets,
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.sort ? { sort: params.sort } : {}),
          },
        });
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        const previous = client.getQueryData<SearchPageData>(queryKey);
        return searchUnavailablePage(params, previous?.conditionMetadata);
      }
    },
  });
}
