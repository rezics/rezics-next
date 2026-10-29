import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import nullRevisions from './null-erased-revisions.sql';
import eraseMedia from './page-erasure-media.sql';
import type { ErasureJob } from './erasure-job.ts';

/** Mechanical cleanup only: the committed post tombstone supplies authority.
 * Each revision page holds at most 100 identities. Each retained revision names
 * at most 32 media; purge releases the database connection before storage work.
 * Retrying starts at the beginning and changes no erased row.
 */
export async function clearErasedPostRevisions(
  pool: Pool,
  input: Readonly<{ postId: string }>,
  deadline: number,
  erasureJob?: ErasureJob,
) {
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
    for (const revision of rows) {
      const parameters = { route, post_id: input.postId, revision_id: revision.revision_id };
      const media = await within(deadline, () =>
        withConnection(pool, (connection) =>
          deadlineClient(connection, deadline).query<{ media_id: string }>(
            eraseMedia.sql,
            eraseMedia.params.map((name) => parameters[name as keyof typeof parameters]),
          ),
        ),
      );
      for (const item of media.rows) {
        if (!erasureJob) throw new Error('Content erasure job is not composed');
        const result = await erasureJob.purgeObject(item.media_id);
        if (result.outcome === 'fenced') throw new Error('Committed media purge is fenced');
      }
    }
    if (rows.length < 100) return { pageSizes, clearedRevisions };
    const last = rows.at(-1)!;
    after = { at: last.at, id: last.revision_id };
  }
}
