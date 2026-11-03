import type { SearchLoaderDeps } from '../search-params';
import { discoveryRequest } from '../search-request';
import { facetRequest, type FacetRequest, type RequestedFacet } from './request';

/** Build facet reads from the same complete native predicate used by scoped Search results. */
export function scopedRefinementRequests(
  state: SearchLoaderDeps,
  fallbackLanguages: string[],
  requested: RequestedFacet[],
): { search: ReturnType<typeof discoveryRequest>; facets?: FacetRequest } {
  const search = discoveryRequest(state, fallbackLanguages);
  if (!requested.length) return { search };
  return {
    search,
    facets: facetRequest(
      {
        ...(search.text ? { text: search.text } : {}),
        ...(search.filter ? { filter: search.filter } : {}),
        languages: search.languages,
      },
      requested,
    ),
  };
}
