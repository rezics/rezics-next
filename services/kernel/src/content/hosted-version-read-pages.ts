import {
  chapterRankVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNode,
  selectVersionedOutlineSequenceNode,
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceReadAccess,
} from './versioned-outline-sequence.ts';
import {
  HostedVersionReadAnchorError,
  HostedVersionReadIndexCorruptionError,
  type HostedVersionChapterPageQuery,
  type HostedVersionChildrenCandidate,
  type HostedVersionOutlineCandidate,
  type HostedVersionReadCandidate,
  type HostedVersionReadDirection,
  type HostedVersionReadIndex,
  type HostedVersionReadPage,
  type HostedVersionReadWork,
} from './hosted-version-read-pages-model.ts';

type TrackedIndex<Value> = Readonly<{
  access: VersionedOutlineSequenceReadAccess<Value>;
  work: () => HostedVersionReadWork;
}>;

type WindowQuery = Readonly<{
  direction: HostedVersionReadDirection;
  afterNodeId?: string;
  startRank?: bigint;
  limit: number;
  checkAnchorRank?: (rank: bigint) => void;
  expectedRootCount?: bigint;
}>;

function trackIndex<Value>(source: VersionedOutlineSequenceReadAccess<Value>): TrackedIndex<Value> {
  let logicalNodeReadCalls = 0;
  const distinctLogicalNodeVisits = new Set<string>();
  const initialProbeCount = source.work().snapshotProbeCount;
  const access: VersionedOutlineSequenceReadAccess<Value> = {
    async readNode(id) {
      logicalNodeReadCalls += 1;
      const node = await source.readNode(id);
      if (node !== null) distinctLogicalNodeVisits.add(id);
      return node;
    },
    async readNodes(ids) {
      logicalNodeReadCalls += ids.length;
      const nodes = await source.readNodes(ids);
      for (const [id, node] of nodes) if (node !== null) distinctLogicalNodeVisits.add(id);
      return nodes;
    },
    nodeReads: source.nodeReads,
    work: () => source.work(),
  };
  return {
    access,
    work: () => ({
      logicalNodeReadCalls,
      distinctLogicalNodeVisits: distinctLogicalNodeVisits.size,
      snapshotProbeCount: source.work().snapshotProbeCount - initialProbeCount,
    }),
  };
}

async function readRequired<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  id: string,
): Promise<VersionedOutlineSequenceNode<Value>> {
  const node = await access.readNode(id);
  if (node === null || node.id !== id) throw new HostedVersionReadIndexCorruptionError();
  return node;
}

function assertChildPointers<Value>(node: VersionedOutlineSequenceNode<Value>): void {
  if (
    node.treeParentId === node.id ||
    node.leftId === node.id ||
    node.rightId === node.id ||
    (node.leftId !== null && node.leftId === node.rightId)
  )
    throw new HostedVersionReadIndexCorruptionError();
}

async function selectedRoot<Value>(
  index: HostedVersionReadIndex<Value>,
  access: VersionedOutlineSequenceReadAccess<Value>,
): Promise<VersionedOutlineSequenceNode<Value> | null> {
  if (index.rootId === null) return null;
  const root = await readRequired(access, index.rootId);
  assertChildPointers(root);
  if (root.treeParentId !== null || root.count < 1n || root.height < 1)
    throw new HostedVersionReadIndexCorruptionError();
  if (root.chapterCount < 0n || root.chapterCount > root.count) throw new HostedVersionReadIndexCorruptionError();
  return root;
}

function schedule<Value>(
  stack: VersionedOutlineSequenceNode<Value>[],
  scheduled: Set<string>,
  node: VersionedOutlineSequenceNode<Value>,
): void {
  if (scheduled.has(node.id)) throw new HostedVersionReadIndexCorruptionError();
  scheduled.add(node.id);
  stack.push(node);
}

async function pushSpine<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  stack: VersionedOutlineSequenceNode<Value>[],
  scheduled: Set<string>,
  firstId: string | null,
  expectedParentId: string | null,
  direction: HostedVersionReadDirection,
): Promise<void> {
  let nodeId = firstId;
  let parentId = expectedParentId;
  while (nodeId !== null) {
    const node = await readRequired(access, nodeId);
    assertChildPointers(node);
    if (node.treeParentId !== parentId) throw new HostedVersionReadIndexCorruptionError();
    schedule(stack, scheduled, node);
    parentId = node.id;
    nodeId = direction === 'forward' ? node.leftId : node.rightId;
  }
}

/** Prepare eligible in-order ancestors beyond an already-proven member. */
async function pushDirectionalAncestors<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  rootId: string,
  anchor: VersionedOutlineSequenceNode<Value>,
  direction: HostedVersionReadDirection,
  stack: VersionedOutlineSequenceNode<Value>[],
  scheduled: Set<string>,
): Promise<void> {
  const ancestors: VersionedOutlineSequenceNode<Value>[] = [];
  const climbing = new Set<string>([anchor.id]);
  let child = anchor;

  while (child.treeParentId !== null) {
    const parent = await readRequired(access, child.treeParentId);
    assertChildPointers(parent);
    if (climbing.has(parent.id)) throw new HostedVersionReadIndexCorruptionError();
    climbing.add(parent.id);
    const isLeft = parent.leftId === child.id;
    const isRight = parent.rightId === child.id;
    if (isLeft === isRight) throw new HostedVersionReadIndexCorruptionError();
    if ((direction === 'forward' && isLeft) || (direction === 'reverse' && isRight)) ancestors.push(parent);
    child = parent;
  }
  if (child.id !== rootId) throw new HostedVersionReadIndexCorruptionError();

  // The nearest eligible ancestor must be on top; a nearer subtree, if present,
  // is pushed last and therefore traversed first.
  for (let index = ancestors.length - 1; index >= 0; index -= 1) schedule(stack, scheduled, ancestors[index]!);
}

/** Prepare the in-order candidates strictly after/before an already-proven member. */
async function pushAfterAnchor<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  rootId: string,
  anchor: VersionedOutlineSequenceNode<Value>,
  direction: HostedVersionReadDirection,
  stack: VersionedOutlineSequenceNode<Value>[],
  scheduled: Set<string>,
): Promise<void> {
  await pushDirectionalAncestors(access, rootId, anchor, direction, stack, scheduled);
  const subtreeId = direction === 'forward' ? anchor.rightId : anchor.leftId;
  await pushSpine(access, stack, scheduled, subtreeId, anchor.id, direction);
}

async function readWindow<Value>(
  index: HostedVersionReadIndex<Value>,
  query: WindowQuery,
): Promise<HostedVersionReadPage<HostedVersionReadCandidate<Value>>> {
  const tracked = trackIndex(index.access);
  const access = tracked.access;
  const root = await selectedRoot(index, access);
  if (query.expectedRootCount !== undefined && (root?.count ?? 0n) !== query.expectedRootCount)
    throw new HostedVersionReadIndexCorruptionError();
  const stack: VersionedOutlineSequenceNode<Value>[] = [];
  const scheduled = new Set<string>();
  let nextRank = 0n;

  if (query.afterNodeId !== undefined) {
    const anchorRank = await rankVersionedOutlineSequenceNode(access, index.rootId, query.afterNodeId);
    if (anchorRank === null) throw new HostedVersionReadAnchorError();
    query.checkAnchorRank?.(anchorRank);
    const anchor = await readRequired(access, query.afterNodeId);
    nextRank = query.direction === 'forward' ? anchorRank + 1n : anchorRank - 1n;
    scheduled.add(anchor.id);
    await pushAfterAnchor(access, index.rootId!, anchor, query.direction, stack, scheduled);
  } else if (query.startRank !== undefined) {
    if (query.startRank >= 0n && root !== null) {
      const selected = await selectVersionedOutlineSequenceNode(access, index.rootId, query.startRank);
      if (selected !== null) {
        nextRank = query.startRank;
        // The selected rank is inclusive. Its directional subtree is added after
        // the selected node is consumed, while eligible ancestors remain below it.
        await pushDirectionalAncestors(access, index.rootId!, selected, query.direction, stack, scheduled);
        schedule(stack, scheduled, selected);
      }
    }
  } else if (root !== null) {
    nextRank = query.direction === 'forward' ? 0n : root.count - 1n;
    await pushSpine(access, stack, scheduled, root.id, null, query.direction);
  }

  const candidates: HostedVersionReadCandidate<Value>[] = [];
  const maxRawCandidates = query.limit + 1;
  while (stack.length > 0 && candidates.length < maxRawCandidates) {
    const node = stack.pop()!;
    candidates.push({ nodeId: node.id, value: node.value, rank: nextRank });
    nextRank += query.direction === 'forward' ? 1n : -1n;
    const subtreeId = query.direction === 'forward' ? node.rightId : node.leftId;
    await pushSpine(access, stack, scheduled, subtreeId, node.id, query.direction);
  }

  const hasMore = candidates.length > query.limit;
  const nextAnchorId = hasMore ? candidates[query.limit - 1]!.nodeId : null;
  return { candidates, nextAnchorId, hasMore, work: tracked.work() };
}

function toWirePosition(rank: bigint): number {
  if (rank < 0n || rank > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('Hosted version rank exceeds the exact numeric wire range');
  return Number(rank);
}

export async function readHostedVersionChildrenPage<Value>(
  index: HostedVersionReadIndex<Value>,
  query: Readonly<{ afterNodeId?: string; limit: number }>,
): Promise<HostedVersionReadPage<HostedVersionChildrenCandidate<Value>>> {
  const page = await readWindow(index, { ...query, direction: 'forward' });
  return {
    ...page,
    candidates: page.candidates.map((candidate) => ({
      ...candidate,
      position: toWirePosition(candidate.rank),
    })),
  };
}

export async function readHostedVersionOutlinePage<Value>(
  index: HostedVersionReadIndex<Value>,
  query: Readonly<{ afterNodeId?: string; limit: number }>,
): Promise<HostedVersionReadPage<HostedVersionOutlineCandidate<Value>>> {
  const page = await readWindow(index, { ...query, direction: 'forward' });
  return {
    ...page,
    candidates: page.candidates.map((candidate) => ({
      ...candidate,
      ordinal: toWirePosition(candidate.rank),
    })),
  };
}

function combinedWork(...work: HostedVersionReadWork[]): HostedVersionReadWork {
  return work.reduce(
    (sum, next) => ({
      logicalNodeReadCalls: sum.logicalNodeReadCalls + next.logicalNodeReadCalls,
      distinctLogicalNodeVisits: sum.distinctLogicalNodeVisits + next.distinctLogicalNodeVisits,
      snapshotProbeCount: sum.snapshotProbeCount + next.snapshotProbeCount,
    }),
    { logicalNodeReadCalls: 0, distinctLogicalNodeVisits: 0, snapshotProbeCount: 0 },
  );
}

export async function readHostedVersionChapterPage<Value>(
  preorder: HostedVersionReadIndex<Value>,
  chapters: HostedVersionReadIndex<Value>,
  query: HostedVersionChapterPageQuery,
): Promise<HostedVersionReadPage<HostedVersionReadCandidate<Value>>> {
  const preorderTracked = trackIndex(preorder.access);
  const preorderRoot = await selectedRoot(preorder, preorderTracked.access);
  const originRank = await chapterRankVersionedOutlineSequenceNode(
    preorderTracked.access,
    preorder.rootId,
    query.originNodeId,
  );
  if (originRank === null) throw new HostedVersionReadAnchorError();
  const origin = await readRequired(preorderTracked.access, query.originNodeId);
  const originWeight = origin.chapterWeight ?? 0n;
  const preorderChapterCount = preorderRoot?.chapterCount ?? 0n;

  const direction: HostedVersionReadDirection = query.direction === 'next' ? 'forward' : 'reverse';
  const firstRank = query.direction === 'next' ? originRank + originWeight : originRank - 1n;
  const checkAnchorRank =
    query.direction === 'next'
      ? (rank: bigint) => {
          if (rank < originRank + originWeight) throw new HostedVersionReadAnchorError();
        }
      : (rank: bigint) => {
          if (rank >= originRank) throw new HostedVersionReadAnchorError();
        };
  const windowQuery: WindowQuery = {
    direction,
    limit: query.limit,
    checkAnchorRank,
    expectedRootCount: preorderChapterCount,
    ...(query.afterNodeId === undefined ? { startRank: firstRank } : { afterNodeId: query.afterNodeId }),
  };
  const page = await readWindow(chapters, windowQuery);
  return {
    ...page,
    work: combinedWork(preorderTracked.work(), page.work),
  };
}
