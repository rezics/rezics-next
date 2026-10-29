import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { clearErasedPostRevisions, type PostPurgeDeadline, type PostPurgeStep } from './erased-post-cleanup.ts';
import page from './page-deleted-posts.sql';
import type { ErasureJob } from './erasure-job.ts';

/** Completed posts leave the partial index; durable page outputs preserve each cursor. */
export async function purgeDeletedPostPage(
  pool: Pool,
  route: number,
  at: Date,
  deadline: PostPurgeDeadline,
  step: PostPurgeStep = (_name, action) => action(),
  erasureJob?: ErasureJob,
) {
  if (!Number.isInteger(route) || route < 0 || route > 65535) throw new RangeError('Invalid purge route');
  const rows = await step(`deleted-posts:${route}`, () => {
    const end = typeof deadline === 'function' ? deadline() : deadline;
    return within(end, () =>
      withConnection(pool, (connection) => page.run(deadlineClient(connection, end), { route, at: at.toISOString() })),
    );
  });
  for (const row of rows) await clearErasedPostRevisions(pool, { postId: row.post_id }, deadline, () => at, step, erasureJob);
  return { postIds: rows.map((row) => row.post_id) };
}
