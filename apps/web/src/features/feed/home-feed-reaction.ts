import type { FeedItem, FeedPage } from '../pages/home-feed-read';
import type { ReactionKind } from '@rezics/ui/reactions';
import type { FeedReaction } from './vote-control';

type FeedOrigin = { key: string; reader: string | null; isCurrent(): boolean };
const subjectKinds = new Set<ReactionKind>(['like', 'love', 'laugh', 'insightful', 'sad']);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Expose the mounted source value to the action bar without declaring a browser copy of Kernel's contract. */
export function homeFeedSubjectReactionProjection(item: FeedItem): unknown {
  if (item.destination.kind !== 'subject' || item.key.owner !== 'semantic' || !('subjectReactions' in item.summary))
    return undefined;
  return item.summary.subjectReactions;
}

function subjectReaction(item: FeedItem, projection: unknown, input: { signedIn: boolean; origin?: FeedOrigin }) {
  if (item.destination.kind !== 'subject' || item.key.owner !== 'semantic') return;
  if (input.origin && !input.origin.isCurrent()) return;
  const value = record(projection);
  const target = record(value?.target);
  if (
    !target ||
    target.targetKind !== 'subject' ||
    target.targetId !== item.destination.id ||
    target.targetId !== item.key.id
  )
    return;
  const countState = record(value?.counts);
  const countsValue = record(countState?.values);
  if (countState?.state !== 'available' || !countsValue || !Object.hasOwn(countState, 'asOf')) return;
  const counts: Partial<Record<ReactionKind, number>> = {};
  for (const [kind, count] of Object.entries(countsValue)) {
    if (!subjectKinds.has(kind as ReactionKind) || !Number.isSafeInteger(count) || (count as number) <= 0) return;
    counts[kind as ReactionKind] = count as number;
  }
  const action = value?.action;
  let selected: ReactionKind | null = null;
  if (input.signedIn) {
    const viewer = record(value?.viewer);
    if (viewer?.state !== 'available') return;
    if (viewer.kind !== null && !subjectKinds.has(viewer.kind as ReactionKind)) return;
    selected = viewer.kind as ReactionKind | null;
  } else if (action !== 'sign_in') return;
  return {
    target: { kind: 'subject' as const, id: item.destination.id },
    counts: counts as FeedReaction['counts'],
    value: selected,
    ...(input.origin ? { reactionOrigin: input.origin } : {}),
    personalReady: !input.signedIn || action === 'allowed',
    signInAllowed: !input.signedIn && action === 'sign_in',
    sourceWatermark: countState.asOf as FeedReaction['sourceWatermark'],
    settleWithRead: true,
    subjectCollapse: null,
    inlineKinds: true,
    optimistic: false,
  };
}

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
  const summary = item.summary;
  if (item.destination.kind === 'subject') return subjectReaction(item, homeFeedSubjectReactionProjection(item), input);
  if (!input.hasReactionFreshness || input.reactionsAsOf === undefined) return;
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
