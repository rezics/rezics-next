import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { isPlatformClosedError } from '../../kernel/platform-closed';

/** Validate the third-party wire boundary against Content's installed response contract. */
export const hostedId = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
const digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const title = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const target = v.strictObject({ threadId: hostedId, postId: hostedId, revisionId: hostedId, sha256: digest });
const slot = {
  occurrenceId: hostedId,
  parentId: v.nullable(hostedId),
  position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(511)),
};
const occurrence = v.union([
  v.strictObject({ ...slot, kind: v.picklist(['part', 'chapter']), availability: v.literal('unavailable') }),
  v.strictObject({ ...slot, kind: v.literal('part'), availability: v.literal('available'), title, target: v.null() }),
  v.strictObject({ ...slot, kind: v.literal('chapter'), availability: v.literal('available'), title, target }),
]);
const revision = {
  catalogueId: hostedId,
  revisionId: hostedId,
  kind: v.picklist(['structure', 'publication']),
  sourceRevisionId: v.nullable(hostedId),
};
const revisionSchema = v.strictObject(revision);
const pageSchema = v.strictObject({
  ...revision,
  items: v.pipe(v.array(occurrence), v.maxLength(20)),
  nextCursor: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
});
const resolutionSchema = v.strictObject({
  ...revision,
  occurrence,
  document: v.nullable(
    v.strictObject({
      encoding: v.literal('base64'),
      canonicalBytes: v.pipe(v.string(), v.maxLength(Math.ceil(2097152 / 3) * 4)),
      sha256: digest,
      authorId: hostedId,
      licence: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
  ),
});
type CatalogueResource = ReturnType<KernelClient['hostedCatalogues']>;
type OccurrenceResource = ReturnType<CatalogueResource['occurrences']>;
export type HostedRevision = NonNullable<Awaited<ReturnType<CatalogueResource['get']>>['data']>;
export type HostedPage = NonNullable<Awaited<ReturnType<CatalogueResource['children']['get']>>['data']>;
export type HostedResolution = NonNullable<Awaited<ReturnType<OccurrenceResource['get']>>['data']>;
export type HostedOccurrence = HostedPage['items'][number];
export type HostedFailure = { state: 'denied' | 'not-found' | 'unavailable' | 'changed' };
export type HostedRead<T> = { state: 'ready'; value: T } | HostedFailure;
export type HostedQuery = Readonly<{
  kind: 'publication';
  revisionId?: string;
  parentId?: string;
  cursor?: string;
  limit?: string;
  direction?: 'previous' | 'next';
}>;
export type HostedCatalogueApi = Readonly<{
  catalogue(id: string, query: HostedQuery): Promise<HostedRead<HostedRevision>>;
  children(id: string, query: HostedQuery): Promise<HostedRead<HostedPage>>;
  resolve(id: string, occurrenceId: string, query: HostedQuery): Promise<HostedRead<HostedResolution>>;
  navigate(
    id: string,
    occurrenceId: string,
    query: HostedQuery & { direction: 'previous' | 'next' },
  ): Promise<HostedRead<HostedPage>>;
}>;

/** Generated mounted operations retain the existing client's fetch and session-token handling. */
export function createHostedCatalogueApi(
  client: KernelClient,
  authorization: string | null,
  signal: AbortSignal,
): HostedCatalogueApi {
  const options = {
    ...(authorization ? { headers: { authorization } } : {}),
    fetch: { signal, cache: 'no-store', redirect: 'manual' } as const,
  };
  async function read<T>(
    operation: () => Promise<{ status: number; error: unknown; data: unknown }>,
    decode: (data: unknown) => T | null,
  ): Promise<HostedRead<T>> {
    try {
      signal.throwIfAborted();
      const result = await operation();
      signal.throwIfAborted();
      const status = result.status;
      if (status === 401 || status === 403) return { state: 'denied' };
      if (status === 404) return { state: 'not-found' };
      if (status === 400 || status === 412) return { state: 'changed' };
      if (status !== 200 || result.error) return { state: 'unavailable' };
      const value = decode(result.data);
      return value === null ? { state: 'unavailable' } : { state: 'ready', value };
    } catch (error) {
      return { state: isPlatformClosedError(error) ? 'denied' : 'unavailable' };
    }
  }
  const decodeRevision = (data: unknown): HostedRevision | null => {
    const result = v.safeParse(revisionSchema, data);
    return result.success ? result.output : null;
  };
  const decodePage = (data: unknown): HostedPage | null => {
    const result = v.safeParse(pageSchema, data);
    return result.success ? result.output : null;
  };
  const decodeResolution = (data: unknown): HostedResolution | null => {
    const result = v.safeParse(resolutionSchema, data);
    return result.success ? result.output : null;
  };
  return {
    catalogue: (id, query) => read(() => client.hostedCatalogues({ id }).get({ ...options, query }), decodeRevision),
    children: (id, query) =>
      read(() => client.hostedCatalogues({ id }).children.get({ ...options, query }), decodePage),
    resolve: (id, occurrenceId, query) =>
      read(
        () =>
          client
            .hostedCatalogues({ id })
            .occurrences({ occurrenceId })
            .get({ ...options, query }),
        decodeResolution,
      ),
    navigate: (id, occurrenceId, query) =>
      read(
        () =>
          client
            .hostedCatalogues({ id })
            .occurrences({ occurrenceId })
            .navigation.get({ ...options, query }),
        decodePage,
      ),
  };
}
