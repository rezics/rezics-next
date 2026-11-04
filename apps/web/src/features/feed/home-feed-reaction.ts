import type { FeedItem, FeedPage } from '../pages/home-feed-read';
import type { FeedReaction } from './vote-control';

type FeedOrigin = { key: string; reader: string | null; isCurrent(): boolean };

/** Bind only the exact target, current viewer slot and page watermark supplied by Kernel. */
export function homeFeedReaction(
  item: FeedItem,
  input: {
    signedIn: boolean;
    origin?: FeedOrigin;
    reactionsAsOf?: FeedPage['reactionsAsOf'];
    hasReactionFreshness?: boolean;
  },
): FeedReaction | undefined {
  if (!input.hasReactionFreshness || input.reactionsAsOf === undefined) return;
  const summary = item.summary;
  if (!('reactionTarget' in summary) || !summary.reactionTarget || !('reactions' in summary) || !summary.reactions)
    return;
  const target = summary.reactionTarget;
  const destinationMatches =
    (item.destination.kind === 'thread' && target.targetKind === 'thread' && target.targetId === item.destination.id) ||
    (item.destination.kind === 'post' && target.targetKind === 'post' && target.targetId === item.destination.postId);
  if (!destinationMatches || (input.signedIn && !Object.hasOwn(summary, 'viewerReaction'))) return;
  return {
    target: { kind: target.targetKind, id: target.targetId },
    counts: summary.reactions,
    value: input.signedIn && 'viewerReaction' in summary ? (summary.viewerReaction ?? null) : null,
    ...(input.origin ? { reactionOrigin: input.origin } : {}),
    sourceWatermark: input.reactionsAsOf,
  };
}
