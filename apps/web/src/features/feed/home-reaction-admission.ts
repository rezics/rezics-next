import type { FeedItem } from '../pages/home-feed-read';
import type { FeedReaction } from './vote-control';

/** Only the generated Content summary can supply a reaction baseline. Never hydrate a row. */
export function homeReactionAdmission(item: FeedItem, signedIn: boolean): FeedReaction | undefined {
  const summary = item.summary;
  if (
    item.key.owner !== 'content' ||
    !('reactionTarget' in summary) ||
    !summary.reactionTarget ||
    !('reactions' in summary) ||
    !summary.reactions
  )
    return undefined;
  const target = summary.reactionTarget;
  const destination = item.destination;
  const thread =
    item.key.kind === 'thread' &&
    destination.kind === 'thread' &&
    target.targetKind === 'thread' &&
    target.targetId === destination.id;
  const post =
    item.key.kind === 'post' &&
    destination.kind === 'post' &&
    target.targetKind === 'post' &&
    target.targetId === destination.postId &&
    destination.id === destination.postId &&
    'threadId' in summary &&
    summary.threadId === destination.threadId;
  if (!thread && !post) return undefined;
  const personalReady = 'viewerReaction' in summary && summary.viewerReaction !== undefined;
  return {
    target: { kind: target.targetKind, id: target.targetId },
    counts: summary.reactions,
    value: signedIn && 'viewerReaction' in summary ? (summary.viewerReaction ?? null) : null,
    personalReady: !signedIn || personalReady,
  };
}
