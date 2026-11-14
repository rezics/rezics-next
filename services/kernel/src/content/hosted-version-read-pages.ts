import {
  chapterRankVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNode,
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

/**
 * Expand only subtrees intersecting [firstRank, endRank). Child roots supply the
 * next level's ranks together, rather than probing a new spine for every row.
 * The retained frontier and cache cover the raw window plus its index paths;
 * the number of dependent rounds still grows with the selected tree's height.
 */
async function readRankWindow<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  root: VersionedOutlineSequenceNode<Value>,
  firstRank: bigint,
  endRank: bigint,
): Promise<HostedVersionReadCandidate<Value>[]> {
  type Frontier = Readonly<{ node: VersionedOutlineSequenceNode<Value>; firstRank: bigint }>;
  let frontier: Frontier[] = [{ node: root, firstRank: 0n }];
  const scheduled = new Set<string>([root.id]);
  const candidates: HostedVersionReadCandidate<Value>[] = [];

  while (frontier.length > 0) {
    const childIds = [...new Set(frontier.flatMap(({ node }) => [node.leftId, node.rightId]))].filter(
      (id): id is string => id !== null,
    );
    const children = await access.readNodes(childIds);
    const next: Frontier[] = [];

    function childOf(
      id: string | null,
      parent: VersionedOutlineSequenceNode<Value>,
    ): VersionedOutlineSequenceNode<Value> | null {
      if (id === null) return null;
      const child = children.get(id) ?? null;
      if (child === null || child.id !== id || child.treeParentId !== parent.id || scheduled.has(id))
        throw new HostedVersionReadIndexCorruptionError();
      assertChildPointers(child);
      scheduled.add(id);
      return child;
    }

    for (const { node, firstRank: subtreeRank } of frontier) {
      const left = childOf(node.leftId, node);
      const right = childOf(node.rightId, node);
      const rank = subtreeRank + (left?.count ?? 0n);
      if (rank >= firstRank && rank < endRank) candidates.push({ nodeId: node.id, value: node.value, rank });
      if (left !== null && subtreeRank < endRank && rank > firstRank) next.push({ node: left, firstRank: subtreeRank });
      if (right !== null && rank + 1n < endRank && subtreeRank + node.count > firstRank)
        next.push({ node: right, firstRank: rank + 1n });
    }
    frontier = next;
  }

  return candidates.sort((left, right) => (left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : 0));
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
  let nextRank = query.startRank ?? (query.direction === 'forward' ? 0n : (root?.count ?? 0n) - 1n);

  if (query.afterNodeId !== undefined) {
    const anchorRank = await rankVersionedOutlineSequenceNode(access, index.rootId, query.afterNodeId);
    if (anchorRank === null) throw new HostedVersionReadAnchorError();
    query.checkAnchorRank?.(anchorRank);
    const anchor = await readRequired(access, query.afterNodeId);
    assertChildPointers(anchor);
    nextRank = query.direction === 'forward' ? anchorRank + 1n : anchorRank - 1n;
  }

  let candidates: HostedVersionReadCandidate<Value>[] = [];
  if (root !== null && nextRank >= 0n && nextRank < root.count) {
    const width = BigInt(query.limit + 1);
    const lowerRank = query.direction === 'forward' ? nextRank : nextRank + 1n - width;
    const firstRank = lowerRank < 0n ? 0n : lowerRank;
    const endRank = query.direction === 'reverse' ? nextRank + 1n : nextRank + width;
    candidates = await readRankWindow(access, root, firstRank, endRank);
    if (query.direction === 'reverse') candidates.reverse();
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
