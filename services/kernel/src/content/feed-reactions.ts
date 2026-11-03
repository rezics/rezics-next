import type { Actor } from '../request/access.ts';
import { feedRoute } from './feed-activity.ts';
import type { FeedItem, FeedReactionTarget } from './feed-contract.ts';
import { withReactionCounts, withViewerReactions } from './reads.ts';
import type { ContentReadDependencies, ReactionCountFreshness } from './reads.ts';

type FeedReactionReadTarget = Readonly<{ id: string; reactionTarget: FeedReactionTarget }>;
type ContentFeedShape = Readonly<{
  key: Readonly<{ owner: 'content'; kind: 'thread' | 'post'; id: string; route: number }>;
  summary: Readonly<{ id: string; threadId?: string }> & Record<string, unknown>;
  destination: Readonly<{ kind: 'thread' | 'post'; id: string; threadId?: string; postId?: string }>;
}>;

export type FeedReactionProjection = Readonly<{
  items: readonly FeedItem[];
  reactionsAsOf?: ReactionCountFreshness | null;
}>;

function targetFor(item: FeedItem): FeedReactionTarget | null {
  if (item.key.owner !== 'content') return null;
  const content = item as FeedItem & ContentFeedShape;
  const { key, summary, destination } = content;
  if (feedRoute(key.id) !== key.route || summary.id !== key.id || destination.id !== key.id)
    throw new TypeError('Ambiguous feed reaction target');
  if (key.kind === 'thread') {
    if (destination.kind !== 'thread') throw new TypeError('Ambiguous feed reaction target');
    return { targetKind: 'thread', targetId: key.id };
  }
  if (
    key.kind !== 'post' ||
    destination.kind !== 'post' ||
    destination.postId !== key.id ||
    typeof summary.threadId !== 'string' ||
    destination.threadId !== summary.threadId ||
    feedRoute(summary.threadId) !== key.route
  )
    throw new TypeError('Ambiguous feed reaction target');
  return { targetKind: 'post', targetId: key.id };
}

/** Project one disclosed feed page with the native bounded count and viewer readers. */
export async function projectFeedReactions(
  dependencies: ContentReadDependencies,
  actor: Actor,
  items: readonly FeedItem[],
  deadline: number,
): Promise<FeedReactionProjection> {
  const targets = new Map<string, FeedReactionTarget>();
  const itemTargets = new Map<string, FeedReactionTarget>();
  for (const item of items) {
    const target = targetFor(item);
    if (!target) continue;
    const prior = targets.get(target.targetId);
    if (prior && prior.targetKind !== target.targetKind) throw new TypeError('Ambiguous feed reaction target');
    targets.set(target.targetId, target);
    itemTargets.set(item.id, target);
  }
  if (targets.size === 0) return { items };

  const counted = await withReactionCounts(
    dependencies,
    [...targets].map(([id, reactionTarget]) => ({ id, reactionTarget })),
    deadline,
  );
  const viewed = await withViewerReactions(dependencies, actor, counted.items, deadline);
  const byTarget = new Map(viewed.map((target) => [target.id, target]));
  return {
    items: items.map((item) => {
      const reactionTarget = itemTargets.get(item.id);
      if (!reactionTarget) return item;
      const target = byTarget.get(reactionTarget.targetId);
      if (!target) throw new TypeError('Missing feed reaction target result');
      const summary = { ...item.summary } as Record<string, unknown>;
      delete summary.reactionTarget;
      delete summary.reactions;
      delete summary.viewerReaction;
      Object.assign(summary, {
        reactionTarget,
        reactions: target.reactions,
        ...(Object.hasOwn(target, 'viewerReaction') ? { viewerReaction: target.viewerReaction } : {}),
      });
      return { ...item, summary } as FeedItem;
    }),
    reactionsAsOf: counted.reactionsAsOf,
  };
}
