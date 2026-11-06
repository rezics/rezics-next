import { routeOf } from '../route/route.ts';
import { encodeCursor } from '../tokens/cursor.ts';
import type { ReadContext } from './model.ts';
import { ContentNotFoundError, readPost, snapshot, type ContentReadDependencies } from './reads.ts';
import predecessor from './post-location.sql';

// Two ordinary exact disclosure reads, each retaining its native ancestry cap of 33,
// surround one snapshot with one target point and at most one indexed predecessor.
export const POST_LOCATION_BOUNDS = { exactReads: 2, ancestry: 33, seekRows: 2 } as const;

/** A location is navigation only. The ordinary post page independently admits every returned post. */
export async function locateThreadPost(
  dependencies: ContentReadDependencies,
  threadId: string,
  postId: string,
  context: ReadContext,
) {
  const route = routeOf(threadId);
  if (route === null || routeOf(postId) !== route) throw new ContentNotFoundError();
  const initial = await readPost(dependencies, threadId, postId, context);
  if (initial.value?.availability !== 'available') throw new ContentNotFoundError();
  const selected = await snapshot(dependencies, threadId, context, async (client) => {
    const parameters = { route, thread_id: threadId, post_id: postId };
    const { rows } = await client.query<(typeof predecessor)['~reylo']['element']>(
      predecessor.sql,
      predecessor.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    return rows[0];
  });
  const final = await readPost(dependencies, threadId, postId, context);
  if (
    final.value?.availability !== 'available' ||
    initial.anchor.epoch !== selected.anchor.epoch ||
    final.anchor.epoch !== selected.anchor.epoch
  )
    throw new ContentNotFoundError();
  const key = selected.value;
  const cursor = key
    ? encodeCursor(
        dependencies.tokens,
        {
          operation: 'content.posts',
          parameters: {
            threadId,
            postId: null,
            viewer: context.actor.kind === 'account' ? context.actor.accountId : null,
          },
        },
        { epoch: final.anchor.epoch, after: [key.at!, key.id] },
        dependencies.clock().getTime(),
      )
    : null;
  return { value: { cursor }, anchor: final.anchor };
}
