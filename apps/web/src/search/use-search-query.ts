import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchQueryOptions } from './search-queries';
import { searchPageForRecovery, searchUnavailablePage } from './search-recovery';
import type { SearchLoaderDeps } from './search-params';

/** Retrying retires the old display immediately, including independently fetched facet labels. */
export function useSearchQuery(locale: string, params: SearchLoaderDeps, reader?: string) {
  const query = useQuery(searchQueryOptions(locale, params, reader));
  const data = useMemo(
    () =>
      query.data
        ? query.isFetching
          ? searchPageForRecovery(query.data, { status: 'loading' })
          : query.data
        : searchPageForRecovery(searchUnavailablePage(params), { status: 'loading' }),
    [params, query.data, query.isFetching],
  );
  return {
    data,
    retry: () => {
      void query.refetch();
    },
  };
}
