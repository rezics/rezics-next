/** Selected native facts only. The adapter supplies its partition anchor as a value. */
export type ConversationActivityReplyCount = Readonly<
  { kind: 'exact'; value: number } | { kind: 'lower-bound'; value: number }
>;
export type ConversationActivityWitness<Anchor> = Readonly<{
  threadId: string;
  boardId: string;
  threadSecurityRevision: string;
  boardSecurityRevision: string;
  realmId: string | null;
  boardGeneration: string;
  generation: string;
  /** eventSeq 1000 marks a repair cut after every event at this partition position. */
  sourceHead: Readonly<{ epoch: number; position: bigint; eventSeq: number }>;
  source: Anchor;
}>;
export type ConversationActivityCurrent<Anchor> = Readonly<{
  threadId: string;
  status: 'current';
  cohort: 'public';
  replyCount: ConversationActivityReplyCount;
  lastContributionAt: string | null;
  witness: ConversationActivityWitness<Anchor>;
}>;
export type ConversationActivityWithheld = Readonly<{
  threadId: string;
  status: 'withheld';
  reason: 'missing' | 'coverage' | 'unsupported-cohort' | 'stale';
}>;
export type ConversationActivitySelection<Anchor> = ConversationActivityCurrent<Anchor> | ConversationActivityWithheld;

export type CommunityActivityWitness =
  | Readonly<{
      state: 'current';
      threadId: string;
      cohort: Readonly<{ kind: 'public' }> | Readonly<{ kind: 'viewer'; accountId: string }>;
      count: ConversationActivityReplyCount;
      lastActivityAt: string | null;
      source: Readonly<{ epoch: number; position: string }>;
    }>
  | Readonly<{ state: 'unavailable'; threadId: string }>;
export type CommunityActivityRead<Anchor> = Readonly<{
  items: readonly CommunityActivityWitness[];
  anchors: readonly Anchor[];
}>;
export type CommunityActivityActor = Readonly<{ kind: 'anonymous' }> | Readonly<{ kind: 'account'; accountId: string }>;
export type CommunityComments =
  | Readonly<{
      state: 'current';
      cohort: 'public' | 'viewer';
      count: ConversationActivityReplyCount;
      lastActivityAt: string | null;
      source: Readonly<{ epoch: number; position: string }>;
    }>
  | Readonly<{ state: 'unavailable' }>;

/** The shared public count/time rule. Page adapters retain their own disclosure and source semantics. */
export function projectPublicConversationActivity(selection: ConversationActivitySelection<unknown> | undefined):
  | Readonly<{
      state: 'current';
      cohort: 'public';
      count: ConversationActivityReplyCount;
      lastActivityAt: string | null;
    }>
  | Readonly<{ state: 'withheld' }> {
  if (!selection || selection.status !== 'current' || selection.cohort !== 'public') return { state: 'withheld' };
  return {
    state: 'current',
    cohort: selection.cohort,
    count: { ...selection.replyCount },
    lastActivityAt: selection.lastContributionAt,
  };
}

/** Keep the exact selected source head separate from the adapter's partition read anchor. */
export function projectCommunityActivitySelection<Anchor>(
  selected: readonly ConversationActivitySelection<Anchor>[],
): CommunityActivityRead<Anchor> {
  return {
    items: selected.map((item): CommunityActivityWitness => {
      const activity = projectPublicConversationActivity(item);
      if (item.status !== 'current' || activity.state !== 'current' || item.witness.threadId !== item.threadId)
        return { state: 'unavailable', threadId: item.threadId };
      return {
        state: 'current',
        threadId: item.threadId,
        cohort: { kind: activity.cohort },
        count: activity.count,
        lastActivityAt: activity.lastActivityAt,
        source: {
          epoch: item.witness.sourceHead.epoch,
          position: item.witness.sourceHead.position.toString(),
        },
      };
    }),
    anchors: selected.flatMap((item) => (item.status === 'current' ? [item.witness.source] : [])),
  };
}

/** Matching a selected cohort does not authorize a read; disclosure stays in each native adapter. */
export function projectCommunityComments(
  threadId: string,
  witness: CommunityActivityWitness | undefined,
  actor: CommunityActivityActor,
): CommunityComments {
  if (!witness || witness.state !== 'current' || witness.threadId !== threadId) return { state: 'unavailable' };
  if (witness.cohort.kind === 'viewer') {
    if (actor.kind !== 'account' || witness.cohort.accountId !== actor.accountId) return { state: 'unavailable' };
  } else if (witness.cohort.kind !== 'public') {
    return { state: 'unavailable' };
  }
  if (
    !Number.isSafeInteger(witness.count.value) ||
    witness.count.value < 0 ||
    (witness.count.kind !== 'exact' && witness.count.kind !== 'lower-bound') ||
    (witness.count.value === 0 && witness.lastActivityAt !== null) ||
    (witness.lastActivityAt !== null && !Number.isFinite(Date.parse(witness.lastActivityAt))) ||
    !Number.isSafeInteger(witness.source.epoch) ||
    witness.source.epoch < 1 ||
    !/^[1-9][0-9]*$/.test(witness.source.position)
  )
    return { state: 'unavailable' };
  return {
    state: 'current',
    cohort: witness.cohort.kind,
    // A retained producer object must not rewrite the initial hydration observation.
    count: { ...witness.count },
    lastActivityAt: witness.lastActivityAt,
    source: { ...witness.source },
  };
}

/** One result per requested identity; missing or repeated evidence never becomes an exact zero. */
export function projectCommunityCommentsBatch(
  threadIds: readonly string[],
  witnesses: readonly CommunityActivityWitness[],
  actor: CommunityActivityActor,
): ReadonlyMap<string, CommunityComments> {
  const comments = new Map<string, CommunityComments>(threadIds.map((id) => [id, { state: 'unavailable' }]));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const witness of witnesses) {
    if (!comments.has(witness.threadId)) continue;
    if (seen.has(witness.threadId)) {
      duplicates.add(witness.threadId);
      continue;
    }
    seen.add(witness.threadId);
    comments.set(witness.threadId, projectCommunityComments(witness.threadId, witness, actor));
  }
  for (const id of duplicates) comments.set(id, { state: 'unavailable' });
  return comments;
}
