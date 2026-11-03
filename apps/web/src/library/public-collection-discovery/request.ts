import { requestLanguages } from '../../kernel/languages';
import { discoveryRequest } from '../../search/search-request';
import type { SearchLoaderDeps } from '../../search/search-params';
import type { DiscoveryRequest } from '../../search/discovery';

export const publicCollectionKind = 'collection';
export const publicCollectionPageSize = 24;

/** Keep Search's native kind grammar and pagination; this surface never asks for kind counts. */
export function publicCollectionDiscoveryRequest(locale: string, cursor?: string): DiscoveryRequest {
  const params: SearchLoaderDeps = {
    query: '',
    type: undefined,
    facets: {},
    cursor,
    sort: undefined,
    kinds: [publicCollectionKind],
  };
  const request = discoveryRequest(params, requestLanguages(locale));
  delete request.kindCountLeaf;
  return { ...request, limit: publicCollectionPageSize };
}
