import {
  FEED_ACCOUNT_BATCH_LIMIT,
  FEED_AUTHOR_KEYS_PER_CANDIDATE,
  FEED_CANDIDATE_LIMIT,
  FEED_CONTINUE_CANDIDATES,
  FEED_CONTINUE_WIDTH,
  FEED_DISCOVERY_CANDIDATES_PER_RESULT,
  FEED_DISCOVERY_FIXED_CANDIDATES,
  FEED_LANES,
  FEED_PAGE_LIMIT,
  FEED_SPACE_BOARD_KEYS_PER_CANDIDATE,
  FEED_SPACE_FIXED_KEYS,
  FeedBoundExceededError,
  type FeedItem,
  type FeedLane,
  type FeedLaneCandidate,
  type FeedPosition,
  type FeedSourceState,
  type FeedStream,
} from '../contract/index.ts';

export function feedCandidateBound(discovery: number, following: number, continued: boolean): number {
  return (
    (discovery ? FEED_DISCOVERY_CANDIDATES_PER_RESULT * discovery + FEED_DISCOVERY_FIXED_CANDIDATES : 0) +
    following +
    (continued ? FEED_CONTINUE_CANDIDATES : 0)
  );
}

export function feedLaneWidths(input: Readonly<{ stream: FeedStream; personal: boolean; limit: number }>): Readonly<{
  discovery: number;
  following: number;
  continued: boolean;
}> {
  const discovery = !input.personal ? input.limit : Math.max(1, Math.floor((input.limit - FEED_CONTINUE_WIDTH) / 2));
  const following =
    input.stream === 'following' ? input.limit : Math.max(1, input.limit - FEED_CONTINUE_WIDTH - discovery);
  return {
    discovery: input.stream === 'home' ? discovery : 0,
    following: input.personal ? following : 0,
    continued: input.personal && input.stream === 'home',
  };
}

export function admitFeedCandidateReservation(
  input: Readonly<{
    discovery: number;
    following: number;
    continued: boolean;
    spaceSelected: boolean;
  }>,
): number {
  const candidateBound = feedCandidateBound(input.discovery, input.following, input.continued);
  const authorKeys = input.following * FEED_AUTHOR_KEYS_PER_CANDIDATE;
  const spaceKeys = input.spaceSelected
    ? FEED_SPACE_FIXED_KEYS + input.following * FEED_SPACE_BOARD_KEYS_PER_CANDIDATE
    : 0;
  if (input.following > FEED_ACCOUNT_BATCH_LIMIT || candidateBound + authorKeys + spaceKeys > FEED_CANDIDATE_LIMIT)
    throw new FeedBoundExceededError();
  return candidateBound;
}

export function canonicalFeedObject(item: FeedItem): string {
  const owner = item.key.owner === 'library' && item.key.kind === 'collection' ? 'commerce' : item.key.owner;
  return `${owner}:${item.key.id}`;
}

export function initialFeedPosition(
  input: Readonly<{
    stream: FeedStream;
    personal: boolean;
    boundary: string;
  }>,
): FeedPosition {
  return {
    boundary: input.boundary,
    turn: 0,
    discovery: input.stream === 'home' ? null : false,
    following: input.personal ? null : false,
    continue: input.personal && input.stream === 'home' ? null : false,
    resume: null,
  };
}

export function initialFeedSources(input: Readonly<{ stream: FeedStream; personal: boolean }>): Readonly<{
  discovery: FeedSourceState;
  following: FeedSourceState;
  continue: FeedSourceState;
}> {
  return {
    discovery: input.stream === 'home' ? 'ready' : 'not_requested',
    following: input.personal ? 'ready' : 'not_requested',
    continue: input.personal && input.stream === 'home' ? 'ready' : 'not_requested',
  };
}

export function rejectFeedKindMismatches(
  lanes: Record<FeedLane, FeedLaneCandidate[]>,
  kind: string | undefined,
): Record<FeedLane, FeedLaneCandidate[]> {
  if (kind === undefined) return lanes;
  for (const lane of FEED_LANES)
    for (const candidate of lanes[lane])
      if (candidate.item && candidate.item.key.kind !== kind) (candidate as { item: FeedItem | null }).item = null;
  return lanes;
}

export function mergeFeedLanes(
  input: Readonly<{
    lanes: Record<FeedLane, readonly FeedLaneCandidate[]>;
    turn: number;
    limit: number;
  }>,
): Readonly<{ items: FeedItem[]; offsets: Record<FeedLane, number>; turn: number }> {
  const preferred = new Map<string, FeedLane>();
  for (const lane of FEED_LANES)
    for (const candidate of input.lanes[lane])
      if (candidate.item && !preferred.has(canonicalFeedObject(candidate.item)))
        preferred.set(canonicalFeedObject(candidate.item), lane);
  const offsets: Record<FeedLane, number> = { continue: 0, following: 0, discovery: 0 };
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  let turn = input.turn;
  let remaining = FEED_LANES.reduce((sum, lane) => sum + input.lanes[lane].length, 0);
  while (remaining && items.length < input.limit) {
    const lane = FEED_LANES[turn]!;
    turn = (turn + 1) % 3;
    const candidate = input.lanes[lane][offsets[lane]];
    if (!candidate) continue;
    offsets[lane]++;
    remaining--;
    const item = candidate.item;
    if (item && preferred.get(canonicalFeedObject(item)) === lane && !seen.has(canonicalFeedObject(item))) {
      seen.add(canonicalFeedObject(item));
      items.push(item);
    }
  }
  return { items, offsets, turn };
}

export function advanceFeedFrontier(
  input: Readonly<{
    position: FeedPosition;
    lanes: Record<FeedLane, readonly FeedLaneCandidate[]>;
    offsets: Record<FeedLane, number>;
    turn: number;
    continueFingerprint: string;
  }>,
): FeedPosition {
  const next: {
    -readonly [K in keyof FeedPosition]: FeedPosition[K];
  } = { ...input.position, resume: input.position.resume };
  for (const lane of FEED_LANES) {
    if (input.offsets[lane] === input.lanes[lane].length) continue;
    next[lane] = input.position[lane];
    if (lane === 'continue') next.resume = input.position.resume;
    if (lane === 'continue' && input.offsets.continue > 0)
      next.resume = {
        fingerprint: input.continueFingerprint,
        after: input.lanes.continue[input.offsets.continue - 1]!.after!,
      };
  }
  next.turn = input.turn;
  return next;
}

export function rewindFeedLanes(items: FeedItem[], affected: ReadonlySet<FeedLane>): FeedItem[] {
  return items.filter((item) => !affected.has(item.source as FeedLane));
}

export function feedHasReadyFrontier(
  next: FeedPosition,
  sources: Readonly<{ discovery: FeedSourceState; following: FeedSourceState; continue: FeedSourceState }>,
): boolean {
  return FEED_LANES.some((lane) => next[lane] !== false && sources[lane] === 'ready');
}

export function admitFeedPageLimit(limit: number | undefined): number {
  const value = limit ?? FEED_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > FEED_PAGE_LIMIT) throw new RangeError('invalid_request');
  return value;
}

export function isDiscoveryReview(
  item: FeedItem,
): item is Extract<FeedItem, { source: 'discovery'; key: { owner: 'content'; kind: 'review' } }> {
  return item.source === 'discovery' && item.key.owner === 'content' && item.key.kind === 'review';
}

export function isFollowingThread(
  item: FeedItem,
): item is Extract<FeedItem, { source: 'following'; key: { owner: 'content'; kind: 'thread' } }> {
  return item.source === 'following' && item.key.owner === 'content' && item.key.kind === 'thread';
}

export function isFollowingPost(
  item: FeedItem,
): item is Extract<FeedItem, { source: 'following'; key: { owner: 'content'; kind: 'post' } }> {
  return item.source === 'following' && item.key.owner === 'content' && item.key.kind === 'post';
}
