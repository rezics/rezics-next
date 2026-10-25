import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import page from './page-posts.sql';

type PostKey = { at: string; id: string };

function checkTime(at: string): void {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d{1,6})?Z$/.exec(at);
  const milliseconds = Date.parse(at);
  if (!match || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== match[1])
    throw new RangeError('Invalid post candidate time');
}

/**
 * Storage identities only, without disclosure authority. The caller must already
 * independently anchor this client on the parent's partition. Current Access,
 * containment and availability checks belong to the final exact-ID reader.
 * nextKey is internal; an HTTP reader must use the shared signed opaque token.
 */
export async function pagePostCandidates(
  client: Pick<PoolClient, 'query'>,
  input: { threadId: string; after: PostKey | null; limit: number },
): Promise<{ candidates: readonly PostKey[]; nextKey: PostKey | null }> {
  const { threadId, after, limit } = input;
  const route = routeOf(threadId);
  if (route === null) throw new RangeError('Invalid routed parent identity');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Candidate limit must be 1 to 200');
  if (after !== null) {
    if (routeOf(after.id) !== route) throw new RangeError('Post key must carry the parent route');
    checkTime(after.at);
  }

  const parameters = {
    route,
    thread_id: threadId,
    at: after?.at ?? '-infinity',
    post_id: after?.id ?? '00000000-0000-0000-0000-000000000000',
    limit: limit + 1,
  };
  // Execute the typed compiled query directly: run() also probes schema freshness
  // on a cold call, which would violate this helper's single route-bound seek.
  const { rows } = await client.query<(typeof page)['~reylo']['element']>(
    page.sql,
    page.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  // Preserve PostgreSQL microseconds: rounding these through Date loses seek keys.
  const candidates = rows.slice(0, limit).map((row) => ({ id: row.id, at: row.at! }));
  return { candidates, nextKey: rows.length > limit ? candidates.at(-1)! : null };
}
