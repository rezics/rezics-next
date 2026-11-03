import { useMemo } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { searchQueryOptions } from './search-queries';
import { searchPageForRecovery } from './search-recovery';
import type { SearchLoaderDeps } from './search-params';

/** Retrying retires the old display immediately, including independently fetched facet labels. */
export function useSearchQuery(locale: string, params: SearchLoaderDeps, reader?: string) {
  const query = useSuspenseQuery(searchQueryOptions(locale, params, reader));
  const data = useMemo(
    () => (query.isFetching ? searchPageForRecovery(query.data, { status: 'loading' }) : query.data),
    [query.data, query.isFetching],
  );
  return {
    data,
    retry: () => {
      void query.refetch();
    },
  };
}
