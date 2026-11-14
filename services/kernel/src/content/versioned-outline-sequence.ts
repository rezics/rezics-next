/**
 * Owner-neutral implicit AVL sequence. Logical node IDs are stable across structural edits; only the
 * selected node facts (including inverse tree-parent links) change in an owner transaction.
 *
 * Owners provide one reader pinned to one selected snapshot and stage this workspace's final write set
 * in the same transaction as their root and containment facts. treeParentId is an AVL link and is never
 * an owner's containment parent.
 */

export type VersionedOutlineChapterWeight = 0n | 1n;

export type VersionedOutlineSequenceNode<Value> = Readonly<{
  id: string;
  value: Value;
  leftId: string | null;
  rightId: string | null;
  treeParentId: string | null;
  height: number;
  count: bigint;
  chapterWeight?: VersionedOutlineChapterWeight;
  chapterCount: bigint;
  /** The ordered value's optional subtree-depth measure. */
  subtreeHeight?: number | null;
  /** Maximum subtreeHeight in this AVL subtree; null means a legacy/unmeasured child is present. */
  maximumSubtreeHeight?: number | null;
  /** Stable value ID that supplied maximumSubtreeHeight, with lexical tie-breaking. */
  maximumSubtreeOccurrenceId?: string | null;
}>;

export type VersionedOutlineSequenceSnapshotReader<Value> = (
  id: string,
) => Promise<VersionedOutlineSequenceNode<Value> | null>;

export type VersionedOutlineSequenceSnapshotBatchReader<Value> = (
  ids: readonly string[],
) => Promise<ReadonlyMap<string, VersionedOutlineSequenceNode<Value> | null>>;

export type VersionedOutlineSequenceWork = Readonly<{
  nodeReadCalls: number;
  distinctVisitedNodeCount: number;
  snapshotProbeCount: number;
  stagedWriteCalls: number;
  writtenNodeCount: number;
}>;

export type VersionedOutlineSequenceReadAccess<Value> = Readonly<{
  readNode: (id: string) => Promise<VersionedOutlineSequenceNode<Value> | null>;
  readNodes: (ids: readonly string[]) => Promise<ReadonlyMap<string, VersionedOutlineSequenceNode<Value> | null>>;
  readonly nodeReads: ReadonlyMap<string, VersionedOutlineSequenceNode<Value> | null>;
  work: () => VersionedOutlineSequenceWork;
}>;

/**
 * One operation-local view of a selected snapshot and one transaction-local overlay. Reuse one workspace
 * for all sequence changes in the owner transaction; create another workspace to read an older root.
 */
export type VersionedOutlineSequenceReadWriteSet<Value> = VersionedOutlineSequenceReadAccess<Value> &
  Readonly<{
    writeNode: (node: VersionedOutlineSequenceNode<Value>) => void;
    readonly nodeWrites: ReadonlyMap<string, VersionedOutlineSequenceNode<Value>>;
  }>;

const SNAPSHOT_READ_BATCH_LIMIT = 512;

/** Cache one immutable selected snapshot with a bounded batch seam and no write overlay. */
export function createVersionedOutlineSequenceReadAccess<Value>(
  readSelectedSnapshot: VersionedOutlineSequenceSnapshotReader<Value>,
  readSelectedSnapshotBatch?: VersionedOutlineSequenceSnapshotBatchReader<Value>,
): VersionedOutlineSequenceReadAccess<Value> {
  const nodeReads = new Map<string, VersionedOutlineSequenceNode<Value> | null>();
  const pending = new Map<string, Promise<void>>();
  const visited = new Set<string>();
  let nodeReadCalls = 0;
  let snapshotProbeCount = 0;
  let loading = Promise.resolve();

  async function loadMissing(ids: readonly string[]): Promise<void> {
    for (let start = 0; start < ids.length; start += SNAPSHOT_READ_BATCH_LIMIT) {
      const batch = ids.slice(start, start + SNAPSHOT_READ_BATCH_LIMIT);
      const loaded = new Map<string, VersionedOutlineSequenceNode<Value> | null>();
      if (readSelectedSnapshotBatch) {
        snapshotProbeCount += batch.length;
        for (const [id, node] of await readSelectedSnapshotBatch(batch)) loaded.set(id, node);
      } else {
        // Keep the point-reader fallback serial rather than launching one promise per ID.
        for (const id of batch) {
          snapshotProbeCount += 1;
          loaded.set(id, await readSelectedSnapshot(id));
        }
      }
      for (const id of batch) {
        const node = loaded.get(id) ?? null;
        if (node !== null && node.id !== id) {
          throw new Error('Versioned outline sequence snapshot returned a different node identity');
        }
        nodeReads.set(id, node);
      }
    }
  }

  async function readNodes(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, VersionedOutlineSequenceNode<Value> | null>> {
    nodeReadCalls += ids.length;
    const selectedIds = [...new Set(ids)];
    const missingIds = selectedIds.filter((id) => !nodeReads.has(id) && !pending.has(id));
    if (missingIds.length > 0) {
      const load = loading.then(() => loadMissing(missingIds));
      for (const id of missingIds) pending.set(id, load);
      const clearPending = () => {
        for (const id of missingIds) pending.delete(id);
      };
      // Callers await the rejecting load below; settling the queue lets a later
      // operation retry after a reader failure without hiding it from this call.
      loading = load.then(clearPending, clearPending);
    }
    const waits = new Set<Promise<void>>();
    for (const id of selectedIds) {
      const load = pending.get(id);
      if (load !== undefined) waits.add(load);
    }
    await Promise.all(waits);

    const result = new Map<string, VersionedOutlineSequenceNode<Value> | null>();
    for (const id of selectedIds) {
      const node = nodeReads.get(id) ?? null;
      if (node !== null) visited.add(id);
      result.set(id, node);
    }
    return result;
  }

  return {
    async readNode(id) {
      return (await readNodes([id])).get(id) ?? null;
    },
    readNodes,
    nodeReads,
    work: () => ({
      nodeReadCalls,
      distinctVisitedNodeCount: visited.size,
      snapshotProbeCount,
      stagedWriteCalls: 0,
      writtenNodeCount: 0,
    }),
  };
}

/**
 * Cache each snapshot probe once and make staged writes visible to later operations in the same overlay.
 * Snapshot reads are never redirected to a newly committed root or a revision-chain walk.
 */
export function createVersionedOutlineSequenceReadWriteSet<Value>(
  readSelectedSnapshot: VersionedOutlineSequenceSnapshotReader<Value>,
  readSelectedSnapshotBatch?: VersionedOutlineSequenceSnapshotBatchReader<Value>,
): VersionedOutlineSequenceReadWriteSet<Value> {
  const selectedSnapshot = createVersionedOutlineSequenceReadAccess(readSelectedSnapshot, readSelectedSnapshotBatch);
  const nodeReads = new Map<string, VersionedOutlineSequenceNode<Value> | null>();
  const nodeWrites = new Map<string, VersionedOutlineSequenceNode<Value>>();
  const visited = new Set<string>();
  let nodeReadCalls = 0;
  let stagedWriteCalls = 0;

  async function readNodes(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, VersionedOutlineSequenceNode<Value> | null>> {
    nodeReadCalls += ids.length;
    const result = new Map<string, VersionedOutlineSequenceNode<Value> | null>();
    const missingIds: string[] = [];
    for (const id of new Set(ids)) {
      if (nodeWrites.has(id)) {
        const node = nodeWrites.get(id)!;
        visited.add(id);
        result.set(id, node);
      } else if (nodeReads.has(id)) {
        const node = nodeReads.get(id)!;
        if (node !== null) visited.add(id);
        result.set(id, node);
      } else {
        missingIds.push(id);
      }
    }
    if (missingIds.length > 0) {
      for (const [id, node] of await selectedSnapshot.readNodes(missingIds)) {
        nodeReads.set(id, node);
        if (node !== null) visited.add(id);
        result.set(id, node);
      }
    }
    return result;
  }

  return {
    async readNode(id) {
      return (await readNodes([id])).get(id) ?? null;
    },
    readNodes,
    writeNode(node) {
      stagedWriteCalls += 1;
      visited.add(node.id);
      nodeWrites.set(node.id, node);
    },
    nodeReads,
    nodeWrites,
    work: () => ({
      nodeReadCalls,
      distinctVisitedNodeCount: visited.size,
      snapshotProbeCount: selectedSnapshot.work().snapshotProbeCount,
      stagedWriteCalls,
      writtenNodeCount: nodeWrites.size,
    }),
  };
}

export type VersionedOutlineSequenceSplit = Readonly<{
  leftRootId: string | null;
  rightRootId: string | null;
}>;

export type VersionedOutlineSequenceSplice = Readonly<{
  rootId: string | null;
  removedRootId: string | null;
}>;

export type VersionedOutlineSequenceMove = Readonly<{
  rootId: string | null;
}>;

export type VersionedOutlineSequenceMaximum = Readonly<{
  complete: boolean;
  subtreeHeight: number | null;
  occurrenceId: string | null;
}>;

function chapterWeightOf<Value>(node: VersionedOutlineSequenceNode<Value>): bigint {
  return node.chapterWeight ?? 0n;
}

async function requireNode<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  id: string,
): Promise<VersionedOutlineSequenceNode<Value>> {
  const node = await access.readNode(id);
  if (node === null) throw new Error('Versioned outline sequence references a missing node');
  return node;
}

async function countOf<Value>(access: VersionedOutlineSequenceReadAccess<Value>, id: string | null): Promise<bigint> {
  return id === null ? 0n : (await requireNode(access, id)).count;
}

async function setTreeParent<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  id: string | null,
  treeParentId: string | null,
): Promise<void> {
  if (id === null) return;
  const node = await requireNode(access, id);
  if (node.treeParentId !== treeParentId) access.writeNode({ ...node, treeParentId });
}

/** Reattach existing logical nodes and recompute only their local summaries. */
async function rebuild<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  id: string,
  leftId: string | null,
  rightId: string | null,
  treeParentId: string | null,
): Promise<string> {
  if (leftId !== null && leftId === rightId) {
    throw new Error('Versioned outline sequence cannot use one node as both children');
  }
  const node = await requireNode(access, id);
  const left = leftId === null ? null : await requireNode(access, leftId);
  const right = rightId === null ? null : await requireNode(access, rightId);
  if (left !== null && left.id === id) throw new Error('Versioned outline sequence cannot contain a node below itself');
  if (right !== null && right.id === id)
    throw new Error('Versioned outline sequence cannot contain a node below itself');

  if (left !== null && left.treeParentId !== id) access.writeNode({ ...left, treeParentId: id });
  if (right !== null && right.treeParentId !== id) access.writeNode({ ...right, treeParentId: id });

  const tracksSubtreeHeight =
    node.subtreeHeight !== undefined ||
    left?.maximumSubtreeHeight !== undefined ||
    right?.maximumSubtreeHeight !== undefined;
  const hasCompleteChildren =
    (left === null ||
      (left.maximumSubtreeHeight !== null &&
        left.maximumSubtreeHeight !== undefined &&
        left.maximumSubtreeOccurrenceId !== null &&
        left.maximumSubtreeOccurrenceId !== undefined)) &&
    (right === null ||
      (right.maximumSubtreeHeight !== null &&
        right.maximumSubtreeHeight !== undefined &&
        right.maximumSubtreeOccurrenceId !== null &&
        right.maximumSubtreeOccurrenceId !== undefined));
  const maximum =
    tracksSubtreeHeight && node.subtreeHeight !== null && node.subtreeHeight !== undefined && hasCompleteChildren
      ? [
          { height: node.subtreeHeight, occurrenceId: node.id },
          ...(left === null
            ? []
            : [{ height: left.maximumSubtreeHeight!, occurrenceId: left.maximumSubtreeOccurrenceId! }]),
          ...(right === null
            ? []
            : [{ height: right.maximumSubtreeHeight!, occurrenceId: right.maximumSubtreeOccurrenceId! }]),
        ].reduce((best, candidate) =>
          candidate.height > best.height ||
          (candidate.height === best.height && candidate.occurrenceId < best.occurrenceId)
            ? candidate
            : best,
        )
      : null;
  const updated: VersionedOutlineSequenceNode<Value> = {
    ...node,
    leftId,
    rightId,
    treeParentId,
    height: Math.max(left?.height ?? 0, right?.height ?? 0) + 1,
    count: 1n + (left?.count ?? 0n) + (right?.count ?? 0n),
    chapterCount: chapterWeightOf(node) + (left?.chapterCount ?? 0n) + (right?.chapterCount ?? 0n),
    ...(tracksSubtreeHeight
      ? {
          maximumSubtreeHeight: maximum?.height ?? null,
          maximumSubtreeOccurrenceId: maximum?.occurrenceId ?? null,
        }
      : {}),
  };
  if (
    node.leftId !== updated.leftId ||
    node.rightId !== updated.rightId ||
    node.treeParentId !== updated.treeParentId ||
    node.height !== updated.height ||
    node.count !== updated.count ||
    node.chapterCount !== updated.chapterCount ||
    node.maximumSubtreeHeight !== updated.maximumSubtreeHeight ||
    node.maximumSubtreeOccurrenceId !== updated.maximumSubtreeOccurrenceId
  ) {
    access.writeNode(updated);
  }
  return id;
}

async function rebalance<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  id: string,
  treeParentId: string | null,
): Promise<string> {
  const node = await requireNode(access, id);
  const leftHeight = node.leftId === null ? 0 : (await requireNode(access, node.leftId)).height;
  const rightHeight = node.rightId === null ? 0 : (await requireNode(access, node.rightId)).height;

  if (leftHeight - rightHeight > 1) {
    const left = await requireNode(access, node.leftId!);
    const leftLeftHeight = left.leftId === null ? 0 : (await requireNode(access, left.leftId)).height;
    const leftRightHeight = left.rightId === null ? 0 : (await requireNode(access, left.rightId)).height;
    if (leftLeftHeight >= leftRightHeight) {
      const newRight = await rebuild(access, node.id, left.rightId, node.rightId, left.id);
      return rebuild(access, left.id, left.leftId, newRight, treeParentId);
    }
    const pivot = await requireNode(access, left.rightId!);
    const newLeft = await rebuild(access, left.id, left.leftId, pivot.leftId, pivot.id);
    const newRight = await rebuild(access, node.id, pivot.rightId, node.rightId, pivot.id);
    return rebuild(access, pivot.id, newLeft, newRight, treeParentId);
  }

  if (rightHeight - leftHeight > 1) {
    const right = await requireNode(access, node.rightId!);
    const rightLeftHeight = right.leftId === null ? 0 : (await requireNode(access, right.leftId)).height;
    const rightRightHeight = right.rightId === null ? 0 : (await requireNode(access, right.rightId)).height;
    if (rightRightHeight >= rightLeftHeight) {
      const newLeft = await rebuild(access, node.id, node.leftId, right.leftId, right.id);
      return rebuild(access, right.id, newLeft, right.rightId, treeParentId);
    }
    const pivot = await requireNode(access, right.leftId!);
    const newLeft = await rebuild(access, node.id, node.leftId, pivot.leftId, pivot.id);
    const newRight = await rebuild(access, right.id, pivot.rightId, right.rightId, pivot.id);
    return rebuild(access, pivot.id, newLeft, newRight, treeParentId);
  }

  return rebuild(access, node.id, node.leftId, node.rightId, treeParentId);
}

/** Join ordered left/pivot/right AVL components even when their heights differ by many levels. */
async function joinWithPivot<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  leftId: string | null,
  pivotId: string,
  rightId: string | null,
  treeParentId: string | null,
): Promise<string> {
  if (leftId === pivotId || rightId === pivotId || (leftId !== null && leftId === rightId)) {
    throw new Error('Versioned outline sequence join roots must be disjoint');
  }
  const leftHeight = leftId === null ? 0 : (await requireNode(access, leftId)).height;
  const rightHeight = rightId === null ? 0 : (await requireNode(access, rightId)).height;

  if (leftHeight > rightHeight + 1) {
    const left = await requireNode(access, leftId!);
    const joinedRight = await joinWithPivot(access, left.rightId, pivotId, rightId, left.id);
    const rebuilt = await rebuild(access, left.id, left.leftId, joinedRight, treeParentId);
    return rebalance(access, rebuilt, treeParentId);
  }
  if (rightHeight > leftHeight + 1) {
    const right = await requireNode(access, rightId!);
    const joinedLeft = await joinWithPivot(access, leftId, pivotId, right.leftId, right.id);
    const rebuilt = await rebuild(access, right.id, joinedLeft, right.rightId, treeParentId);
    return rebalance(access, rebuilt, treeParentId);
  }
  return rebuild(access, pivotId, leftId, rightId, treeParentId);
}

async function splitAt<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  rootId: string | null,
  index: bigint,
): Promise<VersionedOutlineSequenceSplit> {
  if (rootId === null) return { leftRootId: null, rightRootId: null };
  const root = await requireNode(access, rootId);
  if (index === 0n) {
    await setTreeParent(access, rootId, null);
    return { leftRootId: null, rightRootId: rootId };
  }
  if (index === root.count) {
    await setTreeParent(access, rootId, null);
    return { leftRootId: rootId, rightRootId: null };
  }

  const leftCount = await countOf(access, root.leftId);
  if (index <= leftCount) {
    const splitLeft = await splitAt(access, root.leftId, index);
    const rightRootId = await joinWithPivot(access, splitLeft.rightRootId, root.id, root.rightId, null);
    return { leftRootId: splitLeft.leftRootId, rightRootId };
  }

  const splitRight = await splitAt(access, root.rightId, index - leftCount - 1n);
  const leftRootId = await joinWithPivot(access, root.leftId, root.id, splitRight.leftRootId, null);
  return { leftRootId, rightRootId: splitRight.rightRootId };
}

async function removeMaximum<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  rootId: string,
  treeParentId: string | null,
): Promise<Readonly<{ rootId: string | null; maximumId: string }>> {
  const node = await requireNode(access, rootId);
  if (node.rightId === null) {
    const remainderRootId = node.leftId;
    await setTreeParent(access, remainderRootId, null);
    await rebuild(access, node.id, null, null, null);
    return { rootId: remainderRootId, maximumId: node.id };
  }
  const removed = await removeMaximum(access, node.rightId, node.id);
  const rebuilt = await rebuild(access, node.id, node.leftId, removed.rootId, treeParentId);
  return { rootId: await rebalance(access, rebuilt, treeParentId), maximumId: removed.maximumId };
}

async function joinRoots<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  leftRootId: string | null,
  rightRootId: string | null,
): Promise<string | null> {
  if (leftRootId !== null && leftRootId === rightRootId) {
    throw new Error('Versioned outline sequence cannot join a root to itself');
  }
  if (leftRootId !== null) {
    const left = await requireNode(access, leftRootId);
    if (left.treeParentId !== null) throw new Error('Versioned outline sequence join requires a detached left root');
  }
  if (rightRootId !== null) {
    const right = await requireNode(access, rightRootId);
    if (right.treeParentId !== null) throw new Error('Versioned outline sequence join requires a detached right root');
  }
  if (leftRootId === null) return rightRootId;
  if (rightRootId === null) return leftRootId;

  const removed = await removeMaximum(access, leftRootId, null);
  return joinWithPivot(access, removed.rootId, removed.maximumId, rightRootId, null);
}

async function sequenceCount<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  rootId: string | null,
): Promise<bigint> {
  if (rootId === null) return 0n;
  const root = await requireNode(access, rootId);
  if (root.treeParentId !== null) throw new Error('Versioned outline sequence operation requires a selected root');
  return root.count;
}

function assertIndex(index: bigint, end: bigint, name: string): void {
  if (index < 0n || index > end)
    throw new RangeError('Versioned outline sequence ' + name + ' is outside the sequence');
}

/** Insert one owner-allocated stable logical ID at an exact zero-based rank. */
export async function insertVersionedOutlineSequenceNode<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  rootId: string | null,
  index: bigint,
  id: string,
  value: Value,
  chapterWeight?: VersionedOutlineChapterWeight,
  subtreeHeight?: number,
): Promise<string> {
  const count = await sequenceCount(access, rootId);
  assertIndex(index, count, 'insertion rank');
  if ((await access.readNode(id)) !== null) {
    throw new Error('Versioned outline sequence insertion requires a fresh logical node ID');
  }

  const node: VersionedOutlineSequenceNode<Value> = {
    id,
    value,
    leftId: null,
    rightId: null,
    treeParentId: null,
    height: 1,
    count: 1n,
    ...(chapterWeight === undefined ? {} : { chapterWeight }),
    chapterCount: chapterWeight ?? 0n,
    ...(subtreeHeight === undefined
      ? {}
      : {
          subtreeHeight,
          maximumSubtreeHeight: subtreeHeight,
          maximumSubtreeOccurrenceId: id,
        }),
  };
  access.writeNode(node);
  const split = await splitAt(access, rootId, index);
  return (await joinRoots(access, await joinRoots(access, split.leftRootId, id), split.rightRootId))!;
}

/** Read the maximum measured value in one selected sequence root without visiting its entries. */
export async function maximumVersionedOutlineSequenceSubtreeHeight<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  rootId: string | null,
): Promise<VersionedOutlineSequenceMaximum> {
  if (rootId === null) return { complete: true, subtreeHeight: null, occurrenceId: null };
  const root = await requireNode(access, rootId);
  if (root.treeParentId !== null) throw new Error('Versioned outline sequence maximum requires a selected root');
  if (
    root.maximumSubtreeHeight === undefined ||
    root.maximumSubtreeHeight === null ||
    root.maximumSubtreeOccurrenceId === undefined ||
    root.maximumSubtreeOccurrenceId === null
  ) {
    return { complete: false, subtreeHeight: null, occurrenceId: null };
  }
  return {
    complete: true,
    subtreeHeight: root.maximumSubtreeHeight,
    occurrenceId: root.maximumSubtreeOccurrenceId ?? null,
  };
}

/** Change one selected value's measure and repair only its AVL ancestor path. */
export async function setVersionedOutlineSequenceSubtreeHeight<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  rootId: string | null,
  occurrenceId: string,
  subtreeHeight: number,
): Promise<void> {
  if (!Number.isSafeInteger(subtreeHeight) || subtreeHeight < 0) {
    throw new RangeError('Versioned outline sequence subtree height must be a nonnegative safe integer');
  }
  if (rootId === null) throw new Error('Versioned outline sequence subtree height target is absent');

  const node = await access.readNode(occurrenceId);
  if (node === null) throw new Error('Versioned outline sequence subtree height target is absent');
  const ancestors: VersionedOutlineSequenceNode<Value>[] = [];
  const visited = new Set<string>([occurrenceId]);
  let current = node;
  while (current.treeParentId !== null) {
    const parent = await requireNode(access, current.treeParentId);
    if (visited.has(parent.id)) throw new Error('Versioned outline sequence tree-parent links contain a cycle');
    const isLeft = parent.leftId === current.id;
    const isRight = parent.rightId === current.id;
    if (isLeft === isRight) throw new Error('Versioned outline sequence tree-parent link is inconsistent');
    visited.add(parent.id);
    ancestors.push(parent);
    current = parent;
  }
  if (current.id !== rootId) throw new Error('Versioned outline sequence subtree height target left its selected root');

  if (node.subtreeHeight !== subtreeHeight) {
    access.writeNode({ ...node, subtreeHeight });
  }
  for (const parent of ancestors) {
    await rebuild(access, parent.id, parent.leftId, parent.rightId, parent.treeParentId);
  }
}

export type VersionedOutlineSequenceNodeRankRequest = Readonly<{
  rootId: string | null;
  nodeId: string;
}>;

export type VersionedOutlineSequenceRanks = Readonly<{
  rank: bigint;
  /** Chapter weight strictly before this member, including unweighted members. */
  chapterRank: bigint;
}>;

/**
 * Prove selected membership and derive both ranks in one upward frontier. Roots, selected nodes,
 * parents and left summaries are deduplicated across requests on the same pinned access. Each round
 * depends on the previous parents; the access splits physical reads at its batch cap.
 */
export async function readVersionedOutlineSequenceRanks<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  requests: readonly VersionedOutlineSequenceNodeRankRequest[],
): Promise<readonly (VersionedOutlineSequenceRanks | null)[]> {
  if (requests.length === 0) return [];

  const loaded = new Map<string, VersionedOutlineSequenceNode<Value> | null>();
  async function loadFrontier(ids: readonly (string | null)[]): Promise<void> {
    const missingIds = [...new Set(ids.filter((id): id is string => id !== null))].filter((id) => !loaded.has(id));
    if (missingIds.length === 0) return;
    const nodes = await access.readNodes(missingIds);
    for (const id of missingIds) loaded.set(id, nodes.get(id) ?? null);
  }
  function requireLoaded(id: string): VersionedOutlineSequenceNode<Value> {
    const node = loaded.get(id) ?? null;
    if (node === null) throw new Error('Versioned outline sequence references a missing node');
    return node;
  }

  await loadFrontier(requests.flatMap(({ rootId, nodeId }) => (rootId === null ? [] : [rootId, nodeId])));
  for (const rootId of new Set(requests.map(({ rootId }) => rootId).filter((id): id is string => id !== null))) {
    if (requireLoaded(rootId).treeParentId !== null)
      throw new Error('Versioned outline sequence operation requires a selected root');
  }

  type Candidate = {
    requestIndex: number;
    rootId: string;
    current: VersionedOutlineSequenceNode<Value>;
    rank: bigint;
    chapterRank: bigint;
    visited: Set<string>;
  };
  const ranks: (VersionedOutlineSequenceRanks | null)[] = requests.map(() => null);
  let candidates: Candidate[] = [];
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const request = requests[requestIndex]!;
    if (request.rootId === null) continue;
    const node = loaded.get(request.nodeId) ?? null;
    if (node === null) continue;
    candidates.push({
      requestIndex,
      rootId: request.rootId,
      current: node,
      rank: 0n,
      chapterRank: 0n,
      visited: new Set([node.id]),
    });
  }

  await loadFrontier(candidates.flatMap(({ current }) => [current.leftId, current.treeParentId]));
  for (const candidate of candidates) {
    const left = candidate.current.leftId === null ? null : requireLoaded(candidate.current.leftId);
    candidate.rank = left?.count ?? 0n;
    candidate.chapterRank = left?.chapterCount ?? 0n;
  }

  while (candidates.length > 0) {
    const steps: { candidate: Candidate; parent: VersionedOutlineSequenceNode<Value>; isRight: boolean }[] = [];
    for (const candidate of candidates) {
      if (candidate.current.treeParentId === null) {
        if (candidate.current.id === candidate.rootId) {
          ranks[candidate.requestIndex] = { rank: candidate.rank, chapterRank: candidate.chapterRank };
        }
        continue;
      }
      const parent = requireLoaded(candidate.current.treeParentId);
      if (candidate.visited.has(parent.id))
        throw new Error('Versioned outline sequence tree-parent links contain a cycle');
      const isLeft = parent.leftId === candidate.current.id;
      const isRight = parent.rightId === candidate.current.id;
      if (isLeft === isRight) throw new Error('Versioned outline sequence tree-parent link is inconsistent');
      steps.push({ candidate, parent, isRight });
    }
    if (steps.length === 0) break;

    await loadFrontier(
      steps.flatMap(({ parent, isRight }) => [parent.treeParentId, ...(isRight ? [parent.leftId] : [])]),
    );
    for (const { candidate, parent, isRight } of steps) {
      if (isRight) {
        const left = parent.leftId === null ? null : requireLoaded(parent.leftId);
        candidate.rank += (left?.count ?? 0n) + 1n;
        candidate.chapterRank += (left?.chapterCount ?? 0n) + chapterWeightOf(parent);
      }
      candidate.visited.add(parent.id);
      candidate.current = parent;
    }
    candidates = steps.map(({ candidate }) => candidate);
  }

  return ranks;
}

/** Resolve ordinary ranks across selected roots, preserving request order and duplicates. */
export async function rankVersionedOutlineSequenceNodes<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  requests: readonly VersionedOutlineSequenceNodeRankRequest[],
): Promise<readonly (bigint | null)[]> {
  return (await readVersionedOutlineSequenceRanks(access, requests)).map((ranks) => ranks?.rank ?? null);
}

/** Number of chapter-weighted nodes strictly before each member of its selected root. */
export async function chapterRankVersionedOutlineSequenceNodes<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  requests: readonly VersionedOutlineSequenceNodeRankRequest[],
): Promise<readonly (bigint | null)[]> {
  return (await readVersionedOutlineSequenceRanks(access, requests)).map((ranks) => ranks?.chapterRank ?? null);
}

/** Exact zero-based rank; null means the node is absent from this selected root. */
export async function rankVersionedOutlineSequenceNode<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  rootId: string | null,
  id: string,
): Promise<bigint | null> {
  return (await rankVersionedOutlineSequenceNodes(access, [{ rootId, nodeId: id }]))[0]!;
}

/** Number of chapter-weighted nodes strictly before this member of the selected root. */
export async function chapterRankVersionedOutlineSequenceNode<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  rootId: string | null,
  id: string,
): Promise<bigint | null> {
  return (await chapterRankVersionedOutlineSequenceNodes(access, [{ rootId, nodeId: id }]))[0]!;
}

export type VersionedOutlineSequenceSelectionRequest = Readonly<{
  rootId: string | null;
  rank: bigint;
}>;

/**
 * Select independent boundaries together. Each round loads only the current nodes' child roots:
 * the left summary and either possible next node are then available without serial sibling probes.
 * The snapshot cache shares paths and caps physical batches; dependent rounds still follow AVL height.
 */
async function selectInRoots<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  requests: readonly VersionedOutlineSequenceSelectionRequest[],
  chapterOnly: boolean,
): Promise<readonly (VersionedOutlineSequenceNode<Value> | null)[]> {
  for (const { rank } of requests) {
    if (rank < 0n) {
      throw new RangeError(
        chapterOnly
          ? 'Versioned outline sequence chapter rank cannot be negative'
          : 'Versioned outline sequence selection rank cannot be negative',
      );
    }
  }

  const loaded = new Map<string, VersionedOutlineSequenceNode<Value> | null>();
  async function loadFrontier(ids: readonly (string | null)[]): Promise<void> {
    const missingIds = [...new Set(ids.filter((id): id is string => id !== null))].filter((id) => !loaded.has(id));
    if (missingIds.length === 0) return;
    const nodes = await access.readNodes(missingIds);
    for (const id of missingIds) loaded.set(id, nodes.get(id) ?? null);
  }
  function requireLoaded(id: string): VersionedOutlineSequenceNode<Value> {
    const node = loaded.get(id) ?? null;
    if (node === null) throw new Error('Versioned outline sequence references a missing node');
    return node;
  }

  type Candidate = {
    requestIndex: number;
    current: VersionedOutlineSequenceNode<Value>;
    remaining: bigint;
    visited: Set<string>;
  };
  const selected: (VersionedOutlineSequenceNode<Value> | null)[] = requests.map(() => null);
  let candidates: Candidate[] = [];
  await loadFrontier(requests.map(({ rootId }) => rootId));
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const { rootId, rank } = requests[requestIndex]!;
    if (rootId === null) continue;
    const root = requireLoaded(rootId);
    if (root.treeParentId !== null) throw new Error('Versioned outline sequence operation requires a selected root');
    candidates.push({ requestIndex, current: root, remaining: rank, visited: new Set([rootId]) });
  }

  while (candidates.length > 0) {
    await loadFrontier(candidates.flatMap(({ current }) => [current.leftId, current.rightId]));
    const next: Candidate[] = [];
    for (const candidate of candidates) {
      const node = candidate.current;
      if (node.leftId !== null && node.leftId === node.rightId) {
        throw new Error('Versioned outline sequence cannot use one node as both children');
      }
      const left = node.leftId === null ? null : requireLoaded(node.leftId);
      const right = node.rightId === null ? null : requireLoaded(node.rightId);
      for (const child of [left, right]) {
        if (child === null) continue;
        if (candidate.visited.has(child.id)) throw new Error('Versioned outline sequence child links contain a cycle');
        if (child.treeParentId !== node.id)
          throw new Error('Versioned outline sequence tree-parent link is inconsistent');
      }

      const leftCount = chapterOnly ? (left?.chapterCount ?? 0n) : (left?.count ?? 0n);
      const weight = chapterOnly ? chapterWeightOf(node) : 1n;
      let child: VersionedOutlineSequenceNode<Value> | null;
      if (candidate.remaining < leftCount) {
        child = left;
      } else if (candidate.remaining === leftCount && weight === 1n) {
        selected[candidate.requestIndex] = node;
        continue;
      } else {
        candidate.remaining -= leftCount + weight;
        child = right;
      }
      if (child !== null) {
        candidate.visited.add(child.id);
        candidate.current = child;
        next.push(candidate);
      }
    }
    candidates = next;
  }
  return selected;
}

/** Select exact zero-based ranks across selected roots, preserving request order and duplicates. */
export function selectVersionedOutlineSequenceNodes<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  requests: readonly VersionedOutlineSequenceSelectionRequest[],
): Promise<readonly (VersionedOutlineSequenceNode<Value> | null)[]> {
  return selectInRoots(access, requests, false);
}

/** Select chapter-weighted ranks; unweighted nodes and empty parts consume no rank. */
export function selectVersionedOutlineSequenceChapters<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  requests: readonly VersionedOutlineSequenceSelectionRequest[],
): Promise<readonly (VersionedOutlineSequenceNode<Value> | null)[]> {
  return selectInRoots(access, requests, true);
}

/** Select a node by exact zero-based rank; out-of-range ranks return null. */
export async function selectVersionedOutlineSequenceNode<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  rootId: string | null,
  rank: bigint,
): Promise<VersionedOutlineSequenceNode<Value> | null> {
  return (await selectVersionedOutlineSequenceNodes(access, [{ rootId, rank }]))[0]!;
}

/** Select a chapter by zero-based weighted rank; unweighted nodes and empty parts consume no rank. */
export async function selectVersionedOutlineSequenceChapter<Value>(
  access: VersionedOutlineSequenceReadAccess<Value>,
  rootId: string | null,
  chapterRank: bigint,
): Promise<VersionedOutlineSequenceNode<Value> | null> {
  return (await selectVersionedOutlineSequenceChapters(access, [{ rootId, rank: chapterRank }]))[0]!;
}

/** Split before index. Both returned roots are detached and retain their original logical node IDs. */
export async function splitVersionedOutlineSequence<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  rootId: string | null,
  index: bigint,
): Promise<VersionedOutlineSequenceSplit> {
  const count = await sequenceCount(access, rootId);
  assertIndex(index, count, 'split rank');
  return splitAt(access, rootId, index);
}

/** Join two detached sequences where every left entry precedes every right entry. */
export function joinVersionedOutlineSequences<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  leftRootId: string | null,
  rightRootId: string | null,
): Promise<string | null> {
  return joinRoots(access, leftRootId, rightRootId);
}

/**
 * Remove deleteCount entries at start and insert an already detached sequence at that boundary.
 * The removed interval is returned as a detached root for a second owner sequence or later splice.
 */
export async function spliceVersionedOutlineSequence<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  rootId: string | null,
  start: bigint,
  deleteCount: bigint,
  insertRootId: string | null,
): Promise<VersionedOutlineSequenceSplice> {
  const count = await sequenceCount(access, rootId);
  assertIndex(start, count, 'splice start');
  if (deleteCount < 0n || deleteCount > count - start) {
    throw new RangeError('Versioned outline sequence splice range exceeds the sequence');
  }
  if (insertRootId !== null) {
    if (insertRootId === rootId) throw new Error('Versioned outline sequence cannot splice a root into itself');
    const insertedRoot = await requireNode(access, insertRootId);
    if (insertedRoot.treeParentId !== null) {
      throw new Error('Versioned outline sequence splice requires a detached insertion root');
    }
  }

  const beforeAndRest = await splitAt(access, rootId, start);
  const removedAndAfter = await splitAt(access, beforeAndRest.rightRootId, deleteCount);
  const insertedAndAfter = await joinRoots(access, insertRootId, removedAndAfter.rightRootId);
  return {
    rootId: await joinRoots(access, beforeAndRest.leftRootId, insertedAndAfter),
    removedRootId: removedAndAfter.leftRootId,
  };
}

/**
 * Move [start,start+count) to a boundary measured in the original sequence. A destination inside or
 * at either edge of the range is a no-op; a rightward destination is reduced by count after the cut.
 */
export async function moveVersionedOutlineSequenceRange<Value>(
  access: VersionedOutlineSequenceReadWriteSet<Value>,
  rootId: string | null,
  start: bigint,
  moveCount: bigint,
  destination: bigint,
): Promise<VersionedOutlineSequenceMove> {
  const count = await sequenceCount(access, rootId);
  assertIndex(start, count, 'move start');
  assertIndex(destination, count, 'move destination');
  if (moveCount < 0n || moveCount > count - start) {
    throw new RangeError('Versioned outline sequence move range exceeds the sequence');
  }
  const end = start + moveCount;
  if (moveCount === 0n || (destination >= start && destination <= end)) return { rootId };

  const beforeAndRest = await splitAt(access, rootId, start);
  const movedAndAfter = await splitAt(access, beforeAndRest.rightRootId, moveCount);
  const shortened = await joinRoots(access, beforeAndRest.leftRootId, movedAndAfter.rightRootId);
  const adjustedDestination = destination > end ? destination - moveCount : destination;
  const destinationSplit = await splitAt(access, shortened, adjustedDestination);
  const withMoved = await joinRoots(access, destinationSplit.leftRootId, movedAndAfter.leftRootId);
  return { rootId: await joinRoots(access, withMoved, destinationSplit.rightRootId) };
}
