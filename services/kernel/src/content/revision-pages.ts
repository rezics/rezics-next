import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import pageRevisions from './page-revisions.sql';

type RevisionKey = { at: string; id: string };

function finiteTimestamp(at: string): boolean {
  if (typeof at !== 'string' || !/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(at)) return false;
  const time = Date.parse(at);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === at.slice(0, 19);
}

/** Storage identities only, with no disclosure authority. The caller must independently
 * anchor this client on the parent's partition before calling. Rehydrate each exact ID
 * and apply current authorization/availability separately; never substitute head bytes.
 * nextKey is internal state, not a public cursor (HTTP uses the shared signed token).
 */
export async function pageRevisionCandidates(
  client: Pick<PoolClient, 'query'>,
  input: { postId: string; after: RevisionKey | null; limit: number },
): Promise<{ candidates: readonly RevisionKey[]; nextKey: RevisionKey | null }> {
  const route = routeOf(input.postId);
  if (route === null) throw new TypeError('Invalid revision parent ID');
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)
    throw new RangeError('Revision candidate limit must be 1 to 200');
  const { after } = input;
  if (
    after !== null &&
    (typeof after !== 'object' || Array.isArray(after) || routeOf(after.id) !== route || !finiteTimestamp(after.at))
  )
    throw new TypeError('Invalid revision candidate key');

  const parameters: (typeof pageRevisions)['~reylo']['input'] = {
    route,
    post_id: input.postId,
    at: after?.at ?? '-infinity',
    revision_id: after?.id ?? input.postId,
    limit: input.limit + 1,
  };
  // Run the compiled typed statement directly; run() adds catalogue freshness reads.
  const { rows } = await client.query<(typeof pageRevisions)['~reylo']['element']>(
    pageRevisions.sql,
    pageRevisions.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  const candidates = rows.slice(0, input.limit).map((row) => ({ id: row.revision_id, at: row.at! }));
  return { candidates, nextKey: rows.length > input.limit ? candidates.at(-1)! : null };
}
