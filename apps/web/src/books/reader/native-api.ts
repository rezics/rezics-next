import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { isPlatformClosedError } from '../../kernel/platform-closed';

/** Mirrors Content's hosted-chapters-schemas, not an extension of the generated client. */
export const hostedId = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
const digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const title = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const target = v.strictObject({ threadId: hostedId, postId: hostedId, revisionId: hostedId, sha256: digest });
const slot = {
  occurrenceId: hostedId, parentId: v.nullable(hostedId),
  position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(511)),
};
const occurrence = v.union([
  v.strictObject({ ...slot, kind: v.picklist(['part', 'chapter']), availability: v.literal('unavailable') }),
  v.strictObject({ ...slot, kind: v.literal('part'), availability: v.literal('available'), title, target: v.null() }),
  v.strictObject({ ...slot, kind: v.literal('chapter'), availability: v.literal('available'), title, target }),
]);
const revision = {
  catalogueId: hostedId, revisionId: hostedId, kind: v.picklist(['structure', 'publication']),
  sourceRevisionId: v.nullable(hostedId),
};
const revisionSchema = v.strictObject(revision);
const pageSchema = v.strictObject({ ...revision,
  items: v.pipe(v.array(occurrence), v.maxLength(20)),
  nextCursor: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
});
const resolutionSchema = v.strictObject({ ...revision, occurrence, document: v.nullable(v.strictObject({
  encoding: v.literal('base64'), canonicalBytes: v.pipe(v.string(), v.maxLength(Math.ceil(2097152 / 3) * 4)),
  sha256: digest, authorId: hostedId, licence: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
})) });
export type HostedRevision = v.InferOutput<typeof revisionSchema>;
export type HostedPage = v.InferOutput<typeof pageSchema>;
export type HostedResolution = v.InferOutput<typeof resolutionSchema>;
export type HostedOccurrence = HostedPage['items'][number];
export type HostedFailure = { state: 'denied' | 'not-found' | 'unavailable' | 'changed' };
export type HostedRead<T> = { state: 'ready'; value: T } | HostedFailure;
export type HostedQuery = Readonly<{
  kind: 'publication'; revisionId?: string; parentId?: string; cursor?: string;
  limit?: string; direction?: 'previous' | 'next';
}>;
export type HostedCatalogueApi = Readonly<{
  catalogue(id: string, query: HostedQuery): Promise<HostedRead<HostedRevision>>;
  children(id: string, query: HostedQuery): Promise<HostedRead<HostedPage>>;
  resolve(id: string, occurrenceId: string, query: HostedQuery): Promise<HostedRead<HostedResolution>>;
  navigate(id: string, occurrenceId: string, query: HostedQuery): Promise<HostedRead<HostedPage>>;
}>;

function member(value: unknown, key: string): unknown {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? Reflect.get(value, key) : undefined;
}
function call(value: unknown, key: string, operand: object): unknown {
  const method = member(value, key);
  return typeof method === 'function' ? Reflect.apply(method, value, [operand]) : undefined;
}

/** Exact mounted paths through the existing Eden proxy; its fetch and session-token handling remain intact. */
export function createHostedCatalogueApi(
  client: KernelClient,
  authorization: string | null,
  signal: AbortSignal,
): HostedCatalogueApi {
  async function read<T>(id: string, occurrenceId: string | null, endpoint: 'catalogue' | 'children' | 'resolve' | 'navigate',
    query: HostedQuery, decode: (data: unknown) => T | null): Promise<HostedRead<T>> {
    try {
      signal.throwIfAborted();
      let resource = call(client, 'hostedCatalogues', { id });
      if (occurrenceId !== null) resource = call(resource, 'occurrences', { occurrenceId });
      if (endpoint === 'children') resource = member(resource, 'children');
      if (endpoint === 'navigate') resource = member(resource, 'navigation');
      const get = member(resource, 'get');
      if (typeof get !== 'function') return { state: 'unavailable' };
      const result: unknown = await Reflect.apply(get, resource, [{ query,
        ...(authorization ? { headers: { authorization } } : {}),
        fetch: { signal, cache: 'no-store', redirect: 'manual' },
      }]);
      signal.throwIfAborted();
      const status = member(result, 'status');
      if (status === 401 || status === 403) return { state: 'denied' };
      if (status === 404) return { state: 'not-found' };
      if (status === 400 || status === 412) return { state: 'changed' };
      if (status !== 200 || member(result, 'error')) return { state: 'unavailable' };
      const value = decode(member(result, 'data'));
      return value === null ? { state: 'unavailable' } : { state: 'ready', value };
    } catch (error) {
      return { state: isPlatformClosedError(error) ? 'denied' : 'unavailable' };
    }
  }
  const decodeRevision = (data: unknown) => { const result = v.safeParse(revisionSchema, data); return result.success ? result.output : null; };
  const decodePage = (data: unknown) => { const result = v.safeParse(pageSchema, data); return result.success ? result.output : null; };
  const decodeResolution = (data: unknown) => { const result = v.safeParse(resolutionSchema, data); return result.success ? result.output : null; };
  return {
    catalogue: (id, query) => read(id, null, 'catalogue', query, decodeRevision),
    children: (id, query) => read(id, null, 'children', query, decodePage),
    resolve: (id, occurrenceId, query) => read(id, occurrenceId, 'resolve', query, decodeResolution),
    navigate: (id, occurrenceId, query) => read(id, occurrenceId, 'navigate', query, decodePage),
  };
}
