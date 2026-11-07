import { requestLanguages } from '../../kernel/languages';
import { discoveryRequest } from '../search-request';
import type { SearchLoaderDeps } from '../search-params';
import type { DiscoveryRequest } from '../discovery';
import type { PublicCollectionDirectoryAddress } from '../contracts/collection-directory';

import { publicCollectionKind, publicCollectionPageSize } from '../../library/public-collection-discovery/request';
export { publicCollectionKind, publicCollectionPageSize } from '../../library/public-collection-discovery/request';

/** Keep Search's native kind identity and cursor while binding every directory selection. */
export function publicCollectionDiscoveryRequest(
  locale: string,
  address: PublicCollectionDirectoryAddress = {},
): DiscoveryRequest {
  const params: SearchLoaderDeps = {
    query: '',
    type: undefined,
    facets: {},
    cursor: address.cursor,
    sort: undefined,
    kinds: [publicCollectionKind],
  };
  const request = discoveryRequest(params, requestLanguages(locale));
  delete request.kindCountLeaf;
  delete request.kindPage;
  return {
    ...request,
    limit: publicCollectionPageSize,
    collectionDirectory: {
      ...(address.presentationKind === undefined ? {} : { presentationKind: address.presentationKind }),
      ...(address.curator === undefined ? {} : { curator: address.curator }),
      ...(address.subject === undefined ? {} : { subject: address.subject }),
      order: address.order ?? 'recent',
    },
  };
}
