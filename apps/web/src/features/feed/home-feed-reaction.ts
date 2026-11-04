import type { FeedItem, FeedPage } from '../pages/home-feed-read';
import { reactionKinds, type ReactionKind } from '@rezics/ui/reactions';
import type { FeedReaction } from './vote-control';

type FeedOrigin = { key: string; reader: string | null; isCurrent(): boolean };
// Flip only when the serial publisher installs this field in KernelClient's response.
// The conditional makes an accidental enabling against the old publication a type error.
type ContentRow = Extract<FeedItem, { key: { owner: 'content' } }>;
export const homeNativeReactionAdviceInstalled: 'reactionAdvice' extends keyof ContentRow['summary'] ? true : false =
  false;
const isReactionKind = (value: unknown): value is ReactionKind => reactionKinds.some((kind) => kind === value);
const subjectKinds = new Set<ReactionKind>(['like', 'love', 'laugh', 'insightful', 'sad']);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Expose the mounted source value to the action bar without declaring a browser copy of Kernel's contract. */
export function homeFeedSubjectReactionProjection(item: FeedItem): unknown {
  if (item.destination.kind !== 'subject' || item.key.owner !== 'semantic' || !('subjectReactions' in item.summary))
    return undefined;
  const projection = item.summary.subjectReactions;
  const target = record(record(projection)?.target);
  if (target?.targetKind !== 'subject' || target.targetId !== item.destination.id || target.targetId !== item.key.id)
    return undefined;
  return projection;
}

/** Parse the action receiver once for both its admitted control and unavailable presentation. */
export function homeFeedSubjectReactionState(projection: unknown) {
  const value = record(projection);
  const counts = record(value?.counts);
  return {
    action: value?.action,
    counts,
    values: counts?.state === 'available' ? record(counts.values) : undefined,
    viewer: record(value?.viewer),
  };
}

function subjectReaction(item: FeedItem, projection: unknown, input: { signedIn: boolean; origin?: FeedOrigin }) {
  if (item.destination.kind !== 'subject' || item.key.owner !== 'semantic') return;
  if (input.origin && !input.origin.isCurrent()) return;
  const state = homeFeedSubjectReactionState(projection);
  const countState = state.counts;
  const countsValue = state.values;
  if (countState?.state !== 'available' || !countsValue || !Object.hasOwn(countState, 'asOf')) return;
  const counts: Partial<Record<ReactionKind, number>> = {};
  for (const [kind, count] of Object.entries(countsValue)) {
    if (!subjectKinds.has(kind as ReactionKind) || !Number.isSafeInteger(count) || (count as number) <= 0) return;
    counts[kind as ReactionKind] = count as number;
  }
  const action = state.action;
  let selected: ReactionKind | null = null;
  if (input.signedIn) {
    const viewer = state.viewer;
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
  if (
    item.key.owner !== 'content' ||
    item.key.id !== target.targetId ||
    summary.id !== target.targetId ||
    !destinationMatches ||
    (input.signedIn && !Object.hasOwn(summary, 'viewerReaction'))
  )
    return;
  return {
    target: { kind: target.targetKind, id: target.targetId },
    counts: summary.reactions,
    value:
      input.signedIn && (input.origin?.isCurrent() ?? true) && 'viewerReaction' in summary
        ? (summary.viewerReaction ?? null)
        : null,
    ...(input.origin ? { reactionOrigin: input.origin } : {}),
    sourceWatermark: input.reactionsAsOf,
    ...nativeAdvice(item, input),
  };
}

/** Receive only closed native advice; facts never fill in a missing action slot. */
function nativeAdvice(item: FeedItem, input: { signedIn: boolean; origin?: FeedOrigin }): Partial<FeedReaction> {
  const unavailable = { personalReady: false, signInAllowed: false };
  if (!homeNativeReactionAdviceInstalled || (input.origin && !input.origin.isCurrent())) return unavailable;
  const summary = record(item.summary);
  const advice = record(summary?.reactionAdvice);
  const target = record(advice?.target);
  const expected = record(summary?.reactionTarget);
  if (
    !advice ||
    !target ||
    !expected ||
    Object.keys(target).length !== 2 ||
    target.targetKind !== expected.targetKind ||
    target.targetId !== expected.targetId
  )
    return unavailable;
  if (advice.state === 'sign_in' && Object.keys(advice).length === 2)
    return { personalReady: !input.signedIn, signInAllowed: !input.signedIn };
  if (advice.state !== 'current' || !input.signedIn || Object.keys(advice).length !== 3) return unavailable;
  const allowed = advice.allowed;
  if (!Array.isArray(allowed) || !allowed.every(isReactionKind) || new Set(allowed).size !== allowed.length)
    return unavailable;
  return {
    personalReady: allowed.length > 0,
    signInAllowed: false,
    allowedKinds: allowed,
    optimistic: false,
    settleWithRead: false,
    allowDiscard: true,
  };
}

export type HomeFeedReactionStatus = 'denied' | 'unavailable';

/** Describe missing or refused native advice without inferring permission from counts. */
export function homeFeedReactionStatus(
  item: FeedItem,
  input: { signedIn: boolean; reaction: FeedReaction | undefined },
): HomeFeedReactionStatus | undefined {
  if (item.destination.kind === 'thread' || item.destination.kind === 'post')
    return input.reaction?.allowedKinds?.length === 0
      ? 'denied'
      : input.reaction?.personalReady
        ? undefined
        : 'unavailable';
  if (item.destination.kind !== 'subject') return;

  const projection = homeFeedSubjectReactionState(homeFeedSubjectReactionProjection(item));
  const action = projection.action;
  if (action === 'denied') return 'denied';
  if (input.signedIn && (action !== 'allowed' || !input.reaction)) return 'unavailable';
  if (!input.signedIn && action !== 'sign_in') return 'unavailable';
  return;
}
