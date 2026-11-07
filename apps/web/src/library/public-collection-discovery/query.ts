import { queryOptions } from '@tanstack/react-query';
import { publicRead } from '../../kernel/query';
import type { PublicCollectionDiscoveryReader } from './request';
import type { PublicCollectionDirectoryAddress } from '../../search/contracts/collection-directory';

export function publicCollectionDiscoveryQueryOptions<Row extends { id: string }>(
  locale: string,
  address: PublicCollectionDirectoryAddress,
  read: PublicCollectionDiscoveryReader<Row>,
) {
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
    queryFn: ({ signal }) => read({ data: { locale, ...address }, signal }),
  });
}
