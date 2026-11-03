import { ProblemError } from '../http/problem.ts';
import type { FeedItem, FeedReactionCounts } from './feed-contract.ts';
import { projectFeedReactions } from './feed-reactions.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import {
  readSubjectThread,
  type ContentReadDependencies,
  type ReactionCountFreshness,
  type ThreadView,
  type ViewerReactionKind,
} from './reads.ts';

export type SubjectThreadWithReactions = ThreadView &
  Readonly<{
    reactions: FeedReactionCounts;
    viewerReaction?: ViewerReactionKind | null;
  }>;

/** Adapt already disclosed native thread keys to Home's installed reaction producer.
 * The temporary feed items never become the Subject list's public identity.
 */
export async function projectSubjectThreadReactions(
  dependencies: ContentReadDependencies,
  subjectId: string,
  placeId: string,
  selected: readonly ThreadView[],
  context: ReadContext,
): Promise<
  Readonly<{
    entries: readonly SubjectThreadWithReactions[];
    anchors: readonly AnchoredPosition[];
    reactionsAsOf: ReactionCountFreshness | null;
  }>
> {
  if (selected.length > 20) throw new RangeError('At most 20 Subject thread reaction targets');
  const seen = new Set<string>();
  const items: FeedItem[] = selected.map((thread) => {
    if (seen.has(thread.id)) throw new TypeError('Duplicate Subject thread reaction target');
    seen.add(thread.id);
    return {
      id: thread.id,
      source: 'following',
      occurredAt: thread.createdAt,
      key: { owner: 'content', kind: 'thread', route: thread.route, id: thread.id },
      summary: { id: thread.id, kind: thread.kind, title: thread.title, createdAt: thread.createdAt },
      destination: { kind: 'thread', id: thread.id, title: thread.title },
    };
  });
  const projected = await projectFeedReactions(dependencies, context.actor, items, context.deadline);
  const summaries = new Map(projected.items.map((item) => [item.id, item.summary]));
  const entries: SubjectThreadWithReactions[] = [];
  const anchors: AnchoredPosition[] = [];
  for (const original of selected) {
    // Release reaction homes before observing each source again. Keep the actual
    // final native value and anchor, including original recorded review citations.
    const current = await readSubjectThread(dependencies, original.id, subjectId, placeId, context);
    anchors.push(current.anchor);
    if (!current.value) continue;
    if (JSON.stringify(original) !== JSON.stringify(current.value)) throw new ProblemError('dependency_unavailable');
    const summary = summaries.get(original.id);
    if (!summary || !('reactions' in summary) || summary.reactions === undefined)
      throw new TypeError('Missing Subject thread reaction projection');
    entries.push({
      ...current.value,
      reactions: summary.reactions,
      ...('viewerReaction' in summary && summary.viewerReaction !== undefined
        ? { viewerReaction: summary.viewerReaction }
        : {}),
    });
  }
  return { entries, anchors, reactionsAsOf: projected.reactionsAsOf ?? null };
}
