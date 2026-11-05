import { parseFilter, type FilterDocument } from '@rezics/filter';
import type { SearchLoaderDeps } from '../search-params';
import { discoveryRequest } from '../search-request';
import { removeSearchResourceScope } from '../advanced-scope';
import { facetRequest, type FacetRequest, type RequestedFacet } from './request';

function semanticFacetFilter(state: SearchLoaderDeps, searchFilter: string | undefined): FilterDocument | undefined {
  const clauses: FilterDocument[] = [];
  const authored = removeSearchResourceScope(searchFilter);
  if (authored) clauses.push(parseFilter(JSON.parse(authored)));
  if (state.condition) clauses.push(state.condition);
  if (state.type) clauses.push({ type: { in: [state.type] } });
  for (const [property, values] of Object.entries(state.facets)) {
    if (!values.length) continue;
    clauses.push(property === 'type' ? { type: { in: values } } : { statement: { property, in: values } });
  }
  for (const [property, range] of Object.entries(state.ranges ?? {})) clauses.push({ statement: { property, range } });
  if (!clauses.length) return undefined;
  return clauses.length === 1 ? clauses[0] : { and: clauses };
}

/** Keep the result-kind selection separate while carrying every semantic predicate into facet discovery. */
export function scopedRefinementRequests(
  state: SearchLoaderDeps,
  fallbackLanguages: string[],
  requested: RequestedFacet[],
): { search: ReturnType<typeof discoveryRequest>; facets?: FacetRequest } {
  const search = discoveryRequest(state, fallbackLanguages);
  if (!requested.length) return { search };
  let filter: FilterDocument | undefined;
  try {
    filter = semanticFacetFilter(state, state.filter);
  } catch {
    // Search can admit discovery-only clauses that the catalogue facet operation cannot express.
    // Keep the result request intact and leave its facet controls unavailable for this visit.
    return { search };
  }
  return {
    search,
    facets: facetRequest(
      {
        ...(search.text ? { text: search.text } : {}),
        ...(filter ? { filter } : {}),
        ...(state.kinds?.length ? { kinds: [...state.kinds] } : {}),
        ...(state.resourceScope ? { scope: state.resourceScope } : {}),
        ...(filter && state.resourceScope ? { conditions: filter } : {}),
        languages: search.languages,
      },
      requested,
    ),
  };
}
