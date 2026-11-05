import { queryOptions } from '@tanstack/react-query';
import { publicRead } from '../../kernel/query';
import { readPublicCollectionDiscovery } from './read';
import type { PublicCollectionDirectoryAddress } from './address';

export function publicCollectionDiscoveryQueryOptions(locale: string, address: PublicCollectionDirectoryAddress = {}) {
  return queryOptions({
    ...publicRead,
    gcTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryKey: [
      'public-collection-discovery',
      'anonymous',
      locale,
      address.presentationKind ?? null,
      address.curator ?? null,
      address.subject ?? null,
      address.order ?? 'recent',
      address.cursor ?? null,
    ],
    queryFn: ({ signal }) => readPublicCollectionDiscovery({ data: { locale, ...address }, signal }),
  });
}
