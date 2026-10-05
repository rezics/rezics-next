export interface FeedItem { id: string; kind: string; target: { work: string | null }; group?: { count: number } | null }

/** Activity the steps before Home wrote: a Work appearing, a Contribution to it. Later steps add decisions, adoptions,
 * discussions and reviews, which would give a rerun new items to vote on. */
const earlierKinds: ReadonlySet<string> = new Set(['work', 'contribution']);

/**
 * The activities the demo people follow and vote on: those of the plan's own Works, in kinds written before this
 * step, and ungrouped. The newest activities of the whole feed are not a stable choice: other work and later steps
 * keep adding them, so every run would vote on new ones. A grouped activity is shown under one of its members, and
 * Main takes a vote only on the group's leader, so a grouped one cannot be voted on from the list.
 */
export function homeFeedTargets(items: readonly FeedItem[], planWorks: ReadonlySet<string>): FeedItem[] {
  return items.filter(item => earlierKinds.has(item.kind) && !!item.target.work && planWorks.has(item.target.work)
    && (item.group?.count ?? 1) === 1);
}
