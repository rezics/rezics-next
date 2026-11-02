import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { isPlatformClosedError, isPlatformClosedProblem } from '../../kernel/platform-closed';
import type { RealmPresentationImage } from '../../threads/board-community-source';
import type { RealmDiscoverySort, RealmDiscoveryState } from './index';

const id = v.pipe(v.string(), v.uuid());
const dimension = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const coordinate = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const cursor = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const image = v.strictObject({
  id,
  containerId: id,
  digest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  width: dimension,
  height: dimension,
  variants: v.pipe(
    v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: dimension, height: dimension })),
    v.minLength(1),
    v.maxLength(12),
  ),
  placeholder: v.nullable(v.strictObject({ thumbhash: v.string(), color: v.string() })),
  focalPoint: v.nullable(v.strictObject({ x: coordinate, y: coordinate })),
  credit: v.nullable(
    v.strictObject({
      rightsHolder: v.string(),
      via: v.strictObject({ name: v.string(), url: v.pipe(v.string(), v.url(), v.startsWith('https://')) }),
      license: v.string(),
      obligations: v.pipe(
        v.array(v.picklist(['cc:Attribution', 'cc:ShareAlike', 'cc:Notice', 'cc:SourceCode'])),
        v.maxLength(4),
      ),
    }),
  ),
}) satisfies v.GenericSchema<RealmPresentationImage>;

const page = v.strictObject({
  realms: v.pipe(
    v.array(
      v.pipe(
        v.strictObject({
          realmId: id,
          spaceId: id,
          name: v.pipe(
            v.string(),
            v.check((value) => Array.from(value).length >= 1 && Array.from(value).length <= 1024),
          ),
          description: v.pipe(
            v.string(),
            v.check((value) => Array.from(value).length <= 160),
          ),
          avatar: v.nullable(image),
        }),
        v.check((realm) => realm.avatar === null || realm.avatar.containerId === realm.realmId),
      ),
    ),
    v.maxLength(20),
  ),
  next: v.nullable(cursor),
});
const query = v.strictObject({
  sort: v.picklist(['popular', 'trending']),
  cursor: v.optional(cursor),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
});

/** Search uses Content's complete page contract before admitting an injected reader result. */
export function isValidRealmDiscoveryPage(value: unknown): boolean {
  return v.safeParse(page, value).success;
}

/** One native bounded page. The server owns anonymous disclosure, ranking windows and final source guards. */
export async function loadRealmDiscovery(
  client: KernelClient,
  input: Readonly<{ sort: RealmDiscoverySort; cursor?: string; limit?: number }>,
): Promise<Exclude<RealmDiscoveryState, { kind: 'loading' }>> {
  const request = v.safeParse(query, input);
  if (!request.success) return { kind: 'unavailable' };
  try {
    const { sort, cursor, limit } = request.output;
    const result = await client.realms.discovery.get({
      query: { sort, ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) },
      fetch: { cache: 'no-store' },
    });
    if (result.error)
      return { kind: isPlatformClosedProblem(result.status, result.error.value) ? 'closed' : 'unavailable' };
    const parsed = v.safeParse(page, result.data);
    if (!parsed.success || parsed.output.realms.length > Math.min(request.output.limit ?? 20, 20))
      return { kind: 'unavailable' };
    return { kind: 'ready', realms: parsed.output.realms, next: parsed.output.next };
  } catch (error) {
    return { kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}
