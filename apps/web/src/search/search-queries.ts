import { queryOptions } from '@tanstack/react-query';
import { publicRead } from '../kernel/query';
import { readSearch } from './search.tsx';
import type { SearchLoaderDeps } from './search-params';

export function searchQueryOptions(locale: string, params: SearchLoaderDeps) {
  return queryOptions({
    ...publicRead,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: false,
    queryKey: ['search', 'discovery-v1', 'anonymous', 'public-global', locale, params],
    queryFn: async ({ signal, client }) => {
      const result = await readSearch({
        locale,
        signal,
        data: {
          query: params.query,
          kinds: params.kinds,
          languages: params.languages,
          filter: params.filter,
          ...(params.ranges ? { ranges: params.ranges } : {}),
          ...(params.condition ? { condition: params.condition } : {}),
          ...(params.type ? { type: params.type } : {}),
          facetValues: params.facets,
          ...(params.cursor ? { cursor: params.cursor } : {}),
          ...(params.sort ? { sort: params.sort } : {}),
        },
      });
      // Keep initial certified count evidence for this exact query across hit pages.
      if (params.cursor && result.discovery?.status === 'ready') {
        const initial = client.getQueryData<Awaited<ReturnType<typeof readSearch>>>([
          'search',
          'discovery-v1',
          'anonymous',
          'public-global',
          locale,
          { ...params, cursor: undefined },
        ]);
        if (initial?.discovery?.status === 'ready') {
          const counts = new Map(initial.discovery.page.kinds.values.map((kind) => [kind.id, kind.count]));
          result.discovery.page.kinds.values = result.discovery.page.kinds.values.map((kind) => ({
            ...kind,
            ...(counts.get(kind.id) ? { count: counts.get(kind.id)! } : {}),
          }));
        }
      }
      return result;
    },
  });
}
