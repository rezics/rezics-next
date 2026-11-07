import type { ContributionReactionKind } from '../../../features/pages/account-profile-port';
import type { ContributionAdviceState } from './advice';
import type { AuthorContributionActionsResponse, ContributionReference } from './wire';

type Advice = AuthorContributionActionsResponse;
type Section<T> = { notice: ContributionAdviceState } | { value: T };
type Reaction = {
  counts: Partial<Record<ContributionReactionKind, number>>;
  value: ContributionReactionKind | null;
  watermark: { epoch: number; position: string };
};
const reactionKinds: readonly ContributionReactionKind[] = [
  'upvote',
  'downvote',
  'like',
  'love',
  'laugh',
  'insightful',
  'sad',
];
const reactionKind = (value: string): ContributionReactionKind | undefined =>
  reactionKinds.find((kind) => kind === value);

const notice = (state: string): ContributionAdviceState =>
  state === 'sign_in_required' ? 'sign_in_required' : state === 'not_applicable' ? 'not_applicable' : 'unavailable';

/** Both the selected source and its exact revisions must survive the current private read. */
export function contributionSelectedState(advice: Advice, reference: ContributionReference): ContributionAdviceState {
  const entries = advice.selected.filter(
    (entry) => entry.reference.type === reference.type && entry.reference.id === reference.id,
  );
  if (entries.length !== 1) return 'unavailable';
  const entry = entries[0]!;
  if (entry.state !== 'current') return 'withheld';
  const current = entry.reference;
  if (
    current.placeId !== reference.placeId ||
    current.sourceRevisionId !== reference.sourceRevisionId ||
    (reference.type === 'content.post' &&
      (current.type !== 'content.post' ||
        current.threadId !== reference.threadId ||
        current.threadRevisionId !== reference.threadRevisionId))
  )
    return 'unavailable';
  return 'available';
}

/** A Post's watch belongs to its containing thread, with a known native initial state. */
export function contributionWatchSection(advice: Advice, threadId: string): Section<boolean> {
  if (advice.currentness.watch !== 'current') return { notice: notice(advice.currentness.watch) };
  if (advice.watch.state !== 'current') return { notice: notice(advice.watch.state) };
  const entries = advice.watch.items.filter((entry) => entry.threadId === threadId);
  if (entries.length !== 1) return { notice: entries.length ? 'unavailable' : 'missing' };
  const item = entries[0]!;
  if (item.state !== 'current') return { notice: notice(item.state) };
  return item.watching === undefined ? { notice: 'unavailable' } : { value: item.watching };
}

/** Missing own slots and counts are unknown; neither omission means a clear slot or zero. */
export function contributionReactionSection(advice: Advice, reference: ContributionReference): Section<Reaction> {
  if (advice.currentness.reactions !== 'current' || advice.reactions.state !== 'current')
    return { notice: 'unavailable' };
  const entries = advice.reactions.items.filter((entry) => entry.type === reference.type && entry.id === reference.id);
  if (entries.length !== 1) return { notice: entries.length ? 'unavailable' : 'missing' };
  const item = entries[0]!;
  if (item.state !== 'current') return { notice: notice(item.state) };
  if (item.viewerSelection === undefined || item.counts === undefined || advice.reactions.reactionsAsOf === null)
    return { notice: 'unavailable' };
  const value = item.viewerSelection === null ? null : reactionKind(item.viewerSelection);
  if (value === undefined) return { notice: 'unavailable' };
  return { value: { counts: item.counts, value, watermark: advice.reactions.reactionsAsOf } };
}
