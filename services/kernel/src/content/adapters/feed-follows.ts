import type { AccountActor } from '../../request/access.ts';
import { routeOf } from '../../route/route.ts';
import { FEED_PAGE_LIMIT, type FeedItem, type FeedViewerFollows } from '../contract/feed.ts';
import type { FeedNativeSuppliers } from './feed-capabilities.ts';

/** Use only exact targets whose owners disclosed the selected feed rows. */
export async function readFeedViewerFollows(
  read: FeedNativeSuppliers['readViewerFollows'],
  actor: AccountActor,
  items: readonly FeedItem[],
  deadline: number,
): Promise<FeedViewerFollows | undefined> {
  const targets = items.flatMap(({ id, source, key, destination, summary }) => {
    const type = destination.kind;
    const eligible =
      type === 'space'
        ? source === 'discovery' && key.owner === 'content'
        : type === 'collection' &&
          ((source === 'discovery' && key.owner === 'commerce') ||
            (source === 'following' && key.owner === 'library'));
    if (
      !eligible ||
      (type !== 'space' && type !== 'collection') ||
      key.kind !== type ||
      destination.id !== key.id ||
      summary.id !== key.id ||
      routeOf(key.id) !== key.route
    )
      return [];
    return [{ targetId: key.id, targetType: type, source: id }];
  });
  if (!targets.length) return undefined;
  const unavailable = { state: 'unavailable' } as const;
  if (
    !read ||
    targets.length > FEED_PAGE_LIMIT ||
    new Set(targets.map(({ targetId }) => targetId)).size !== targets.length
  )
    return unavailable;

  try {
    const result = await read(actor, targets, deadline);
    if (result.state !== 'current' || result.accountId !== actor.accountId || result.rows.length !== targets.length)
      return unavailable;
    const rows: Extract<FeedViewerFollows, { state: 'current' }>['rows'][number][] = [];
    for (const [index, target] of targets.entries()) {
      const row = result.rows[index];
      if (
        !row ||
        row.targetId !== target.targetId ||
        row.targetType !== target.targetType ||
        row.source !== target.source
      )
        return unavailable;
      rows.push({
        targetId: target.targetId,
        targetType: target.targetType,
        following: row.following,
        actions: row.actions,
      });
    }
    return { state: 'current', rows };
  } catch {
    return unavailable;
  }
}
