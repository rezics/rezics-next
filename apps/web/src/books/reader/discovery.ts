import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { hostedId, type HostedRead } from './native-api';

const schema = v.strictObject({
  subjectId: hostedId,
  items: v.pipe(
    v.array(
      v.strictObject({
        catalogueId: hostedId,
        revisionId: hostedId,
        kind: v.literal('publication'),
        sourceRevisionId: v.nullable(hostedId),
        threadId: hostedId,
      }),
    ),
    v.maxLength(20),
  ),
  nextCursor: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
type SubjectResource = ReturnType<KernelClient['subjects']>;
export type HostedDiscoveryPage = NonNullable<Awaited<ReturnType<SubjectResource['hostedCatalogues']['get']>>['data']>;

/** One current, bounded discovery page. Sparse windows retain their native continuation. */
export async function readHostedDiscovery(
  client: KernelClient,
  authorization: string | null,
  subjectId: string,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<HostedRead<HostedDiscoveryPage>> {
  const result = await client.subjects({ id: subjectId }).hostedCatalogues.get({
    query: { limit: '20', ...(cursor ? { cursor } : {}) },
    ...(authorization ? { headers: { authorization } } : {}),
    fetch: { signal, cache: 'no-store', redirect: 'manual' },
  });
  if (result.status === 401 || result.status === 403) return { state: 'denied' };
  if (result.status === 404) return { state: 'not-found' };
  if (result.status === 400 || result.status === 412) return { state: 'changed' };
  if (result.status !== 200 || result.error) return { state: 'unavailable' };
  const parsed = v.safeParse(schema, result.data);
  return parsed.success && parsed.output.subjectId === subjectId
    ? { state: 'ready', value: parsed.output }
    : { state: 'unavailable' };
}
