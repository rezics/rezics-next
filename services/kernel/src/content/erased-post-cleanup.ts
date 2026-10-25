import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import nullRevisions from './null-erased-revisions.sql';

/** Mechanical cleanup only: the committed post tombstone supplies authority.
 * Each atomic statement clears at most 100 revisions and releases its connection
 * before the next page. Retrying starts at the beginning and changes no erased row.
 */
export async function clearErasedPostRevisions(pool: Pool, input: Readonly<{ postId: string }>, deadline: number) {
  const route = routeOf(input.postId);
  if (route === null) throw new TypeError('Invalid post identity');
  const pageSizes: number[] = [];
  let clearedRevisions = 0;
  let after = { at: '-infinity', id: input.postId };
  for (;;) {
    const parameters = { route, post_id: input.postId, after_at: after.at, after_id: after.id };
    const { rows } = await within(deadline, () =>
      withConnection(pool, (connection) =>
        deadlineClient(connection, deadline).query<{ revision_id: string; at: string; changed: boolean }>(
          nullRevisions.sql,
          nullRevisions.params.map((name) => parameters[name as keyof typeof parameters]),
        ),
      ),
    );
    pageSizes.push(rows.length);
    clearedRevisions += rows.filter((row) => row.changed).length;
    if (rows.length < 100) return { pageSizes, clearedRevisions };
    const last = rows.at(-1)!;
    after = { at: last.at, id: last.revision_id };
  }
}
