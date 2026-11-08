import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { admitFilter, FilterError, parseFilter, type FilterDocument } from '@rezics/filter';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { readScopedSearchReader } from '../search/search-reader';
import { readRelease } from '../subject/definitions';
import { refinementProperties } from '../search/refinement/model';
import { facetRequest, readFacetPage, type FacetState, type RequestedFacet } from '../search/refinement/request';

export type CollectionFacetRequest = {
  resource: { kind: 'collection'; id: string };
  type?: string;
  locale: string;
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
    id: v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)),
  }),
  type: v.exactOptional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  locale: v.pipe(v.string(), v.maxLength(35)),
  release: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  filter: v.exactOptional(v.unknown()),
  languages: v.pipe(v.array(v.pipe(v.string(), v.maxLength(35))), v.minLength(1), v.maxLength(8)),
  facets: v.pipe(
    v.array(
      v.strictObject({
        property: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(128),
          v.check((property) => property.isWellFormed()),
        ),
        size: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20))),
        cursor: v.exactOptional(v.pipe(v.string(), v.minLength(1), v.maxLength(4864))),
      }),
    ),
    v.minLength(1),
    v.maxLength(8),
    v.check((facets) => new Set(facets.map(({ property }) => property)).size === facets.length),
  ),
});

/** Current-reader Collection refinement through Search's installed native scoped facet operation. */
export const readCollectionFacetValues = createServerFn({ method: 'POST' })
  .validator((value: unknown) => v.parse(input, value))
  .handler(async ({ data }): Promise<FacetState> => {
    setResponseHeader('cache-control', 'private, no-store');
    const requestContext = getRequest();
    const signal = requestContext.signal;
    const reader = await readScopedSearchReader(requestContext);
    if (!reader) return { status: 'restart', code: 'collection_facet_reader_changed' };
    const release = await readRelease().catch(() => undefined);
    if (!release) return { status: 'unavailable', code: 'collection_facet_release_unavailable' };
    if (data.release !== release.digest) return { status: 'restart', code: 'collection_facet_release_changed' };
    if (data.type !== undefined && !release.types[data.type])
      return { status: 'refused', code: 'collection_facet_type_refused' };

    let filter: FilterDocument | undefined;
    try {
      const submitted = data.filter === undefined ? undefined : parseFilter(data.filter);
      const typeFilter: FilterDocument | undefined =
        data.type === undefined ? undefined : { type: { in: [data.type] } };
      const effective =
        submitted && typeFilter ? ({ and: [submitted, typeFilter] } as FilterDocument) : (submitted ?? typeFilter);
      if (effective !== undefined) filter = admitFilter(effective, release, { saved: false });
    } catch (error) {
      if (!(error instanceof FilterError)) throw error;
      return { status: 'refused', code: 'collection_facet_request_refused' };
    }
    const request = facetRequest(
      {
        scope: data.resource,
        ...(filter ? { filter } : {}),
        languages: data.languages,
      },
      data.facets,
    );
    const roster = new Map(refinementProperties(release, data.type).map((property) => [property.property, property]));
    if (request.facets.some((facet) => !['values', 'types'].includes(roster.get(facet.property)?.mode ?? '')))
      return { status: 'refused', code: 'collection_facet_property_refused' };

    try {
      return await readFacetPage(request, (body) =>
        kernelClient(data.locale, reader.authorization).subjects.$facets.post(body, {
          fetch: { signal, cache: 'no-store' },
        }),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (isPlatformClosedError(error))
        return {
          status: 'refused',
          httpStatus: error.status,
          code: 'platform_closed',
        };
      throw error;
    }
  });

export const loadCollectionFacetValues: CollectionFacetLoader = (request, signal) =>
  readCollectionFacetValues({ data: request, signal });
