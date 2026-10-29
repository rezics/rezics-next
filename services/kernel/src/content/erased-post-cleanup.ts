import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import startPurge from './start-post-purge.sql';
import readPurge from './read-post-purge.sql';
import finishPurge from './finish-post-purge.sql';
import nullRevisions from './null-erased-revisions.sql';
import eraseMedia from './page-erasure-media.sql';
import type { ErasureJob } from './erasure-job.ts';

export type PostPurgeStep = <T>(name: string, action: () => Promise<T>) => Promise<T>;
export type PostPurgeDeadline = number | (() => number);

/** Permanent erasure or an expired soft tombstone supplies cleanup authority.
 * Each durable action changes at most 100 revisions and releases its connection.
 * Replayed page outputs retain the cursor across worker crashes. Each retained
 * revision names at most 32 media; release the connection before storage work.
 */
export async function clearErasedPostRevisions(
  pool: Pool,
  input: Readonly<{ postId: string }>,
  deadline: PostPurgeDeadline,
  clockOrErasureJob: (() => Date) | ErasureJob = () => new Date(),
  step: PostPurgeStep = (_name, action) => action(),
  erasureJob?: ErasureJob,
) {
  const clock = typeof clockOrErasureJob === 'function' ? clockOrErasureJob : () => new Date();
  erasureJob ??= typeof clockOrErasureJob === 'function' ? undefined : clockOrErasureJob;
  const route = routeOf(input.postId);
  if (route === null) throw new TypeError('Invalid post identity');
  const until = () => (typeof deadline === 'function' ? deadline() : deadline);
  const eligible = await step(`post:${input.postId}:start`, async () => {
    const at = clock().toISOString();
    const end = until();
    return within(end, () =>
      withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, end);
        await startPurge.run(client, { route, post_id: input.postId, at });
        const row = await readPurge.run(client, { route, post_id: input.postId });
        return !!row && row.purge_started_at !== null && !row.purge_completed;
      }),
    );
  });
  if (!eligible) return { pageSizes: [], clearedRevisions: 0 };
  const pageSizes: number[] = [];
  let clearedRevisions = 0;
  let after = { at: '-infinity', id: input.postId };
  for (;;) {
    const parameters = { route, post_id: input.postId, after_at: after.at, after_id: after.id };
    const rows = await step(`post:${input.postId}:revisions:${after.at}:${after.id}`, async () => {
      const end = until();
      return within(end, () =>
        withConnection(
          pool,
          async (connection) =>
            (
              await deadlineClient(connection, end).query<{ revision_id: string; at: string; changed: boolean }>(
                nullRevisions.sql,
                nullRevisions.params.map((name) => parameters[name as keyof typeof parameters]),
              )
            ).rows,
        ),
      );
    });
    pageSizes.push(rows.length);
    clearedRevisions += rows.filter((row) => row.changed).length;
    for (const revision of rows) {
      await step(`post:${input.postId}:media:${revision.revision_id}`, async () => {
        const parameters = { route, post_id: input.postId, revision_id: revision.revision_id };
        const end = until();
        const media = await within(end, () =>
          withConnection(pool, (connection) =>
            deadlineClient(connection, end).query<{ media_id: string }>(
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
        return null;
      });
    }
    if (rows.length < 100) {
      await step(`post:${input.postId}:finish`, () => {
        const end = until();
        return within(end, () =>
          withConnection(pool, async (connection) => {
            await finishPurge.run(deadlineClient(connection, end), { route, post_id: input.postId });
            return null;
          }),
        );
      });
      return { pageSizes, clearedRevisions };
    }
    const last = rows.at(-1)!;
    after = { at: last.at, id: last.revision_id };
  }
}
