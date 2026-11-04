import { projectPublicConversationActivity } from './community-projection/index.ts';
import type { ConversationActivitySelection } from './conversation-activity.ts';
import type { FeedItem } from './feed-contract.ts';

export type FeedActivityLane = 'discovery' | 'following';
export type FeedActivityReferences = Readonly<{
  threadIds: readonly string[];
  sourcesByThread: ReadonlyMap<string, ReadonlySet<FeedActivityLane>>;
}>;

function reference(item: FeedItem): Readonly<{ threadId: string; lane: FeedActivityLane }> | null {
  if (item.source === 'discovery' && item.key.owner === 'content' && item.key.kind === 'review')
    return { threadId: item.key.id, lane: 'discovery' };
  if (item.source === 'following' && item.key.owner === 'content' && item.key.kind === 'thread')
    return { threadId: item.key.id, lane: 'following' };
  if (
    item.source === 'following' &&
    item.key.owner === 'content' &&
    item.key.kind === 'post' &&
    'threadId' in item.summary
  )
    return { threadId: item.summary.threadId, lane: 'following' };
  return null;
}

/** Select only native conversation identities already admitted to this page. */
export function feedActivityReferences(items: readonly FeedItem[]): FeedActivityReferences {
  const sources = new Map<string, Set<FeedActivityLane>>();
  for (const item of items) {
    const selected = reference(item);
    if (!selected) continue;
    const lanes = sources.get(selected.threadId) ?? new Set<FeedActivityLane>();
    lanes.add(selected.lane);
    sources.set(selected.threadId, lanes);
  }
  return { threadIds: [...sources.keys()], sourcesByThread: sources };
}

export function feedActivityLanesForThreads(
  references: FeedActivityReferences,
  threadIds: ReadonlySet<string>,
): ReadonlySet<FeedActivityLane> {
  const lanes = new Set<FeedActivityLane>();
  for (const threadId of threadIds) for (const lane of references.sourcesByThread.get(threadId) ?? []) lanes.add(lane);
  return lanes;
}

export function staleFeedActivityThreads(selections: readonly ConversationActivitySelection[]): ReadonlySet<string> {
  return new Set(
    selections.flatMap((selection) =>
      selection.status === 'withheld' && selection.reason === 'stale' ? [selection.threadId] : [],
    ),
  );
}

/** Attach the confirmed producer result without changing a card's native destination or actions. */
export function projectFeedConversationActivity(
  items: readonly FeedItem[],
  selections: readonly ConversationActivitySelection[],
): void {
  const byThread = new Map(selections.map((selection) => [selection.threadId, selection]));
  for (const item of items) {
    const selected = reference(item);
    if (!selected) continue;
    const activity = projectPublicConversationActivity(byThread.get(selected.threadId));
    item.summary = { ...item.summary, conversationActivity: activity };
  }
}
