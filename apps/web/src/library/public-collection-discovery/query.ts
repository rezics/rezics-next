import { queryOptions } from '@tanstack/react-query';
import { publicRead } from '../../kernel/query';
import { readPublicCollectionDiscovery } from './read';

export function publicCollectionDiscoveryQueryOptions(locale: string, cursor?: string) {
  return queryOptions({
    ...publicRead,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryKey: ['public-collection-discovery', 'anonymous', locale, cursor ?? null],
    queryFn: ({ signal }) => readPublicCollectionDiscovery({ data: { locale, ...(cursor ? { cursor } : {}) }, signal }),
  });
}
