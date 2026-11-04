import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchQueryOptions } from './search-queries';
import { searchPageForRecovery, searchUnavailablePage } from './search-recovery';
import { searchSessionLifetime } from './scoped-search-lifetime';
import type { SearchLoaderDeps } from './search-params';
import type { SearchPageData } from './search';

function withoutRecovery(data: SearchPageData): SearchPageData {
  const next = { ...data };
  if (data.discovery?.status === 'ready') {
    const { emptyRecovery: _emptyRecovery, ...page } = data.discovery.page;
    next.discovery = { ...data.discovery, page };
  }
  if (data.result) {
    const { emptyRecovery: _emptyRecovery, ...result } = data.result;
    next.result = result;
  }
  return next;
}

function pageAsOf(data: SearchPageData): string | undefined {
  if (data.discovery?.status === 'ready') return data.discovery.page.as_of;
  return data.result?.as_of;
}

function keepsEarlierResults(status: string): boolean {
  return ['loading', 'sparse', 'exhausted', 'index-not-ready', 'source-not-ready', 'unavailable'].includes(status);
}

/** Retrying retires the old display immediately, including independently fetched facet labels. */
export function useSearchQuery(locale: string, params: SearchLoaderDeps, reader?: string) {
  const query = useQuery(searchQueryOptions(locale, params, reader));
  const lifetime = searchSessionLifetime(locale, { ...params, cursor: undefined }, reader);
  const previous = useRef<{ lifetime: string; data: SearchPageData } | undefined>(undefined);
  if (query.data?.recovery?.status === 'ready' && (query.data.discovery?.status === 'ready' || query.data.result))
    previous.current = { lifetime, data: withoutRecovery(query.data) };
  const data = useMemo(() => {
    const prior = previous.current?.lifetime === lifetime ? previous.current.data : undefined;
    const state = query.isError ? { status: 'unavailable' as const } : query.data?.recovery;
    if (params.cursor && prior && (query.isFetching || (state && keepsEarlierResults(state.status)))) {
      const matchingCut =
        (state?.status !== 'sparse' && state?.status !== 'exhausted') ||
        state.asOf === undefined ||
        state.asOf === pageAsOf(prior);
      if (matchingCut) {
        return {
          ...withoutRecovery(prior),
          queryState: params,
          recovery: state ?? { status: 'loading' as const },
        };
      }
    }
    if (query.isError && !query.isFetching) return searchUnavailablePage(params, query.data?.conditionMetadata);
    return query.data
      ? query.isFetching
        ? searchPageForRecovery(query.data, { status: 'loading' })
        : query.data
      : searchPageForRecovery(searchUnavailablePage(params), { status: query.isPending ? 'loading' : 'unavailable' });
  }, [lifetime, params, query.data, query.isFetching, query.isError, query.isPending]);
  return {
    data,
    retry: () => {
      void query.refetch();
    },
  };
}
