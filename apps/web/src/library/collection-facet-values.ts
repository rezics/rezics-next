import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { admitFilter, parseFilter, type FilterDocument } from '@rezics/filter';
import { readRelease } from '../subject/definitions';
import { refinementProperties } from '../search/refinement/model';
import { facetRequest, type FacetState, type RequestedFacet } from '../search/refinement/request';

export type CollectionFacetRequest = {
  resource: { kind: 'collection'; id: string };
  type: string;
  release: string;
  filter?: FilterDocument;
  languages: string[];
  facets: RequestedFacet[];
};

export type CollectionFacetLoader = (request: CollectionFacetRequest, signal: AbortSignal) => Promise<FacetState>;

/** Keep the Collection identity beside its admitted predicate; callers never turn a refusal into Global facets. */
export function collectionFacetRequest(
  context: Omit<CollectionFacetRequest, 'facets'>,
  facets: RequestedFacet[],
): CollectionFacetRequest {
  const request = facetRequest(
    { ...(context.filter ? { filter: context.filter } : {}), languages: context.languages },
    facets,
  );
  return { ...context, facets: request.facets };
}

const input = v.strictObject({
  resource: v.strictObject({
    kind: v.literal('collection'),
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  }),
  type: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  release: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  filter: v.exactOptional(v.unknown()),
  languages: v.pipe(v.array(v.pipe(v.string(), v.maxLength(35))), v.minLength(1), v.maxLength(8)),
  facets: v.pipe(
    v.array(
      v.strictObject({
        property: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        size: v.exactOptional(v.number()),
        cursor: v.exactOptional(v.string()),
      }),
    ),
    v.minLength(1),
    v.maxLength(8),
  ),
});

/**
 * Search's installed generated `subjects:facets` operation has no Collection resource input. Keep this private,
 * no-store seam unavailable until Search delivers that binding; calling it without the resource would leak Global
 * values into a Collection filter.
 */
export const readCollectionFacetValues = createServerFn({ method: 'POST' })
  .validator((value: unknown) => v.parse(input, value))
  .handler(async ({ data }): Promise<FacetState> => {
    setResponseHeader('cache-control', 'private, no-store');
    const release = await readRelease().catch(() => undefined);
    if (!release) return { status: 'unavailable', code: 'collection_facet_release_unavailable' };
    if (data.release !== release.digest) return { status: 'restart', code: 'collection_facet_release_changed' };
    if (!release.types[data.type]) return { status: 'refused', code: 'collection_facet_type_refused' };

    let filter: FilterDocument | undefined;
    try {
      if (data.filter !== undefined) filter = admitFilter(parseFilter(data.filter), release, { saved: false });
      const request = facetRequest(
        { ...(filter ? { filter } : {}), languages: data.languages },
        data.facets,
      );
      const roster = new Map(refinementProperties(release, data.type).map((property) => [property.property, property]));
      if (request.facets.some((facet) => !['values', 'types'].includes(roster.get(facet.property)?.mode ?? '')))
        return { status: 'refused', code: 'collection_facet_property_refused' };
    } catch {
      return { status: 'refused', code: 'collection_facet_request_refused' };
    }

    return { status: 'unavailable', code: 'collection_resource_scope_unavailable' };
  });

export const loadCollectionFacetValues: CollectionFacetLoader = (request, _signal) =>
  readCollectionFacetValues({ data: request });
