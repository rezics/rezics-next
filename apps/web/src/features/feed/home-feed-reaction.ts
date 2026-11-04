import type { FeedItem, FeedPage } from '../pages/home-feed-read';
import { reactionKinds, type ReactionKind } from '@rezics/ui/reactions';
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

function homeFeedContentReactionAdvice(item: FeedItem, origin?: FeedOrigin) {
  if (origin && !origin.isCurrent()) return;
  const destination = item.destination;
  if (destination.kind !== 'thread' && destination.kind !== 'post') return;
  const summary = item.summary;
  if (!('reactionTarget' in summary) || !summary.reactionTarget || !('reactionAdvice' in summary)) return;
  const advice = summary.reactionAdvice;
  if (!advice || item.key.owner !== 'content') return;
  const targetKind = destination.kind === 'thread' ? 'thread' : 'post';
  const targetId = destination.kind === 'thread' ? destination.id : destination.postId;
  const sourceMatches =
    destination.kind === 'thread'
      ? (item.source === 'discovery' && item.key.kind === 'review') ||
        (item.source === 'following' && item.key.kind === 'thread')
      : item.source === 'following' && item.key.kind === 'post';
  if (
    !sourceMatches ||
    item.key.id !== targetId ||
    summary.id !== targetId ||
    summary.reactionTarget.targetKind !== targetKind ||
    summary.reactionTarget.targetId !== targetId ||
    advice.target.targetKind !== targetKind ||
    advice.target.targetId !== targetId
  )
    return;
  return advice;
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
  if (item.destination.kind !== 'thread' && item.destination.kind !== 'post') return;
  const target = summary.reactionTarget;
  const destinationMatches =
    (item.destination.kind === 'thread' && target.targetKind === 'thread' && target.targetId === item.destination.id) ||
    (item.destination.kind === 'post' && target.targetKind === 'post' && target.targetId === item.destination.postId);
  if (!destinationMatches) return;
  const advice = homeFeedContentReactionAdvice(item, input.origin);
  const viewerReaction = 'viewerReaction' in summary ? summary.viewerReaction : undefined;
  const viewerKnown = viewerReaction !== undefined;
  const allActionsAllowed =
    advice?.state === 'current' &&
    reactionKinds.every((kind) => advice.allowed.includes(kind));
  const signInAllowed = advice?.state === 'sign_in';
  return {
    target: { kind: target.targetKind, id: target.targetId },
    counts: summary.reactions,
    value: input.signedIn && viewerKnown ? (viewerReaction ?? null) : null,
    ...(input.origin ? { reactionOrigin: input.origin } : {}),
    sourceWatermark: input.reactionsAsOf,
    // The shared picker exposes the full set; native advice must admit each current choice.
    personalReady: input.signedIn ? viewerKnown && allActionsAllowed : signInAllowed,
    signInAllowed: !input.signedIn && signInAllowed,
  };
}

export type HomeFeedReactionStatus = 'denied' | 'unavailable';

/** Describe missing or refused native advice without inferring permission from counts. */
export function homeFeedReactionStatus(
  item: FeedItem,
  input: { signedIn: boolean; reaction: FeedReaction | undefined; origin?: FeedOrigin },
): HomeFeedReactionStatus | undefined {
  if (input.origin && !input.origin.isCurrent()) return 'unavailable';
  if (item.destination.kind === 'thread' || item.destination.kind === 'post') {
    const advice = homeFeedContentReactionAdvice(item, input.origin);
    if (input.signedIn) {
      if (advice?.state !== 'current') return 'unavailable';
      if (advice.allowed.length === 0) return 'denied';
      return input.reaction?.personalReady ? undefined : 'unavailable';
    }
    return advice?.state === 'sign_in' && input.reaction?.signInAllowed ? undefined : 'unavailable';
  }
  if (item.destination.kind !== 'subject') return;

  const projection = record(homeFeedSubjectReactionProjection(item));
  const action = projection?.action;
  if (action === 'denied') return 'denied';
  if (input.signedIn && (action !== 'allowed' || !input.reaction)) return 'unavailable';
  if (!input.signedIn && action !== 'sign_in') return 'unavailable';
  return;
}
