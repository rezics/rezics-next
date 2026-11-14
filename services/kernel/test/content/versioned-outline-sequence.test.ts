import { expect, test } from 'bun:test';
import {
  chapterRankVersionedOutlineSequenceNode,
  createVersionedOutlineSequenceReadAccess,
  createVersionedOutlineSequenceReadWriteSet,
  insertVersionedOutlineSequenceNode,
  joinVersionedOutlineSequences,
  maximumVersionedOutlineSequenceSubtreeHeight,
  moveVersionedOutlineSequenceRange,
  rankVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNodes,
  selectVersionedOutlineSequenceChapter,
  selectVersionedOutlineSequenceNode,
  splitVersionedOutlineSequence,
  spliceVersionedOutlineSequence,
  setVersionedOutlineSequenceSubtreeHeight,
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceSnapshotReader,
} from '../../src/content/versioned-outline-sequence.ts';

type Snapshot = ReadonlyMap<string, VersionedOutlineSequenceNode<string>>;

function seedBalanced(
  count: number,
  prefix = 'n',
  chapterEvery = 0,
): Readonly<{ rootId: string | null; nodes: Map<string, VersionedOutlineSequenceNode<string>>; ids: string[] }> {
  const nodes = new Map<string, VersionedOutlineSequenceNode<string>>();
  const ids = Array.from({ length: count }, (_, index) => prefix + String(index).padStart(6, '0'));

  function build(start: number, end: number, treeParentId: string | null): string | null {
    if (start === end) return null;
    const middle = Math.floor((start + end) / 2);
    const id = ids[middle]!;
    const leftId = build(start, middle, id);
    const rightId = build(middle + 1, end, id);
    const left = leftId === null ? null : nodes.get(leftId)!;
    const right = rightId === null ? null : nodes.get(rightId)!;
    const chapterWeight = chapterEvery > 0 && middle % chapterEvery === 0 ? 1n : 0n;
    nodes.set(id, {
      id,
      value: id,
      leftId,
      rightId,
      treeParentId,
      height: Math.max(left?.height ?? 0, right?.height ?? 0) + 1,
      count: 1n + (left?.count ?? 0n) + (right?.count ?? 0n),
      ...(chapterWeight === 0n ? {} : { chapterWeight }),
      chapterCount: chapterWeight + (left?.chapterCount ?? 0n) + (right?.chapterCount ?? 0n),
    });
    return id;
  }

  return { rootId: build(0, count, null), nodes, ids };
}

function workspace(snapshot: Snapshot) {
  const read: VersionedOutlineSequenceSnapshotReader<string> = async (id) => snapshot.get(id) ?? null;
  return createVersionedOutlineSequenceReadWriteSet(read);
}

function batchWorkspace(snapshot: Snapshot, batches?: string[][]) {
  return createVersionedOutlineSequenceReadAccess<string>(
    async (id) => snapshot.get(id) ?? null,
    async (ids) => {
      batches?.push([...ids]);
      const selected = new Map<string, VersionedOutlineSequenceNode<string> | null>();
      for (const id of ids) selected.set(id, snapshot.get(id) ?? null);
      return selected;
    },
  );
}

function commit(
  base: Snapshot,
  access: ReturnType<typeof workspace>,
): Map<string, VersionedOutlineSequenceNode<string>> {
  const next = new Map(base);
  for (const [id, node] of access.nodeWrites) next.set(id, node);
  return next;
}

function materialize(snapshot: Snapshot, rootId: string | null): string[] {
  const result: string[] = [];
  const visited = new Set<string>();

  function visit(id: string | null, parentId: string | null): void {
    if (id === null) return;
    if (visited.has(id)) throw new Error('oracle found a repeated sequence node');
    visited.add(id);
    const node = snapshot.get(id);
    if (!node) throw new Error('oracle found a missing sequence node');
    if (node.treeParentId !== parentId) throw new Error('oracle found an inverse parent mismatch');
    visit(node.leftId, id);
    result.push(id);
    visit(node.rightId, id);
  }

  visit(rootId, null);
  return result;
}

function verifyTree(snapshot: Snapshot, rootId: string | null, expectedIds: readonly string[]): void {
  const actualIds = materialize(snapshot, rootId);
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error('sequence differs from array oracle');
  }

  function summarize(id: string | null): Readonly<{ height: number; count: bigint; chapters: bigint }> {
    if (id === null) return { height: 0, count: 0n, chapters: 0n };
    const node = snapshot.get(id);
    if (!node) throw new Error('oracle summary found a missing node');
    const left = summarize(node.leftId);
    const right = summarize(node.rightId);
    const chapterWeight = node.chapterWeight ?? 0n;
    const expectedHeight = Math.max(left.height, right.height) + 1;
    const expectedCount = left.count + right.count + 1n;
    const expectedChapters = left.chapters + right.chapters + chapterWeight;
    if (Math.abs(left.height - right.height) > 1) throw new Error('oracle found an AVL balance violation');
    if (node.height !== expectedHeight || node.count !== expectedCount || node.chapterCount !== expectedChapters) {
      throw new Error('oracle found an incorrect sequence aggregate');
    }
    return { height: expectedHeight, count: expectedCount, chapters: expectedChapters };
  }

  summarize(rootId);
}

test('same-rank inserts preserve IDs and exact bigint rank/select plus sparse chapter rank', async () => {
  const seeded = seedBalanced(8, 'seed-', 3);
  const original = new Map(seeded.nodes);
  const access = workspace(original);
  const expected = [...seeded.ids];
  let rootId = seeded.rootId;

  for (let index = 0; index < 40; index += 1) {
    const id = 'insert-' + String(index).padStart(3, '0');
    rootId = await insertVersionedOutlineSequenceNode(access, rootId, 2n, id, id, index % 7 === 0 ? 1n : 0n);
    expected.splice(2, 0, id);
  }

  const selected = commit(original, access);
  verifyTree(selected, rootId, expected);
  verifyTree(original, seeded.rootId, seeded.ids);
  let chaptersBefore = 0n;
  const expectedChapters: string[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const id = expected[index]!;
    const node = selected.get(id)!;
    expect(await rankVersionedOutlineSequenceNode(workspace(selected), rootId, id)).toBe(BigInt(index));
    expect(await selectVersionedOutlineSequenceNode(workspace(selected), rootId, BigInt(index))).toMatchObject({ id });
    expect(await chapterRankVersionedOutlineSequenceNode(workspace(selected), rootId, id)).toBe(chaptersBefore);
    if ((node.chapterWeight ?? 0n) === 1n) {
      expectedChapters.push(id);
      chaptersBefore += 1n;
    }
  }
  for (let index = 0; index < expectedChapters.length; index += 1) {
    expect(await selectVersionedOutlineSequenceChapter(workspace(selected), rootId, BigInt(index))).toMatchObject({
      id: expectedChapters[index],
    });
  }
  expect(await selectVersionedOutlineSequenceNode(workspace(selected), rootId, BigInt(expected.length))).toBeNull();
  expect(await rankVersionedOutlineSequenceNode(workspace(selected), rootId, 'not-a-member')).toBeNull();

  const outsider = seedBalanced(1, 'other-');
  const roots = new Map([...selected, ...outsider.nodes]);
  expect(await rankVersionedOutlineSequenceNode(workspace(roots), rootId, outsider.rootId!)).toBeNull();
});

test('multi-rank frontiers deduplicate shared paths across roots and stay pinned to their snapshot', async () => {
  const first = seedBalanced(63, 'frontier-a-');
  const second = seedBalanced(31, 'frontier-b-');
  const original = new Map([...first.nodes, ...second.nodes]);
  const batches: string[][] = [];
  const requests = [
    ...first.ids.slice(10, 22).map((nodeId) => ({ rootId: first.rootId, nodeId })),
    { rootId: first.rootId, nodeId: first.ids[15]! },
    ...second.ids.slice(4, 8).map((nodeId) => ({ rootId: second.rootId, nodeId })),
    { rootId: first.rootId, nodeId: second.ids[3]! },
    { rootId: first.rootId, nodeId: 'missing-frontier-node' },
    { rootId: null, nodeId: first.ids[0]! },
  ];

  expect(await rankVersionedOutlineSequenceNodes(batchWorkspace(original, batches), requests)).toEqual([
    ...Array.from({ length: 12 }, (_, index) => BigInt(index + 10)),
    15n,
    4n,
    5n,
    6n,
    7n,
    null,
    null,
    null,
  ]);
  expect(batches.length).toBeLessThan(requests.length);
  expect(batches.every((batch) => batch.length <= requests.length * 2 + 2)).toBe(true);
  const loadedIds = batches.flat();
  expect(loadedIds).toHaveLength(new Set(loadedIds).size);
  expect(batches.every((batch) => batch.length === new Set(batch).size)).toBe(true);

  const edit = workspace(original);
  const moved = await moveVersionedOutlineSequenceRange(edit, first.rootId, 10n, 3n, 43n);
  const updated = commit(original, edit);
  expect(
    await rankVersionedOutlineSequenceNodes(batchWorkspace(original), [
      { rootId: first.rootId, nodeId: first.ids[11]! },
    ]),
  ).toEqual([11n]);
  expect(
    await rankVersionedOutlineSequenceNodes(batchWorkspace(updated), [
      { rootId: moved.rootId, nodeId: first.ids[11]! },
    ]),
  ).toEqual([41n]);
});

test('split handles edges and arbitrary height joins without changing logical IDs', async () => {
  const seeded = seedBalanced(4095, 'join-');
  const access = workspace(seeded.nodes);

  const atStart = await splitVersionedOutlineSequence(access, seeded.rootId, 0n);
  expect(atStart).toEqual({ leftRootId: null, rightRootId: seeded.rootId });
  const atEnd = await splitVersionedOutlineSequence(access, seeded.rootId, BigInt(seeded.ids.length));
  expect(atEnd).toEqual({ leftRootId: seeded.rootId, rightRootId: null });

  const uneven = await splitVersionedOutlineSequence(access, seeded.rootId, 1n);
  expect(uneven.leftRootId).toBe(seeded.ids[0]!);
  const joined = await joinVersionedOutlineSequences(access, uneven.leftRootId, uneven.rightRootId);
  const selected = commit(seeded.nodes, access);
  verifyTree(selected, joined, seeded.ids);
  expect((await selectVersionedOutlineSequenceNode(workspace(selected), joined, 4094n))?.id).toBe(seeded.ids[4094]);

  const empty = new Map<string, VersionedOutlineSequenceNode<string>>();
  const emptyAccess = workspace(empty);
  let edgeRoot = await insertVersionedOutlineSequenceNode(emptyAccess, null, 0n, 'edge-first', 'edge-first');
  edgeRoot = await insertVersionedOutlineSequenceNode(emptyAccess, edgeRoot, 1n, 'edge-last', 'edge-last');
  verifyTree(commit(empty, emptyAccess), edgeRoot, ['edge-first', 'edge-last']);
});

test('left and right range moves invert, while zero and edge positions are no-ops', async () => {
  const seeded = seedBalanced(96, 'move-');
  const original = new Map(seeded.nodes);
  const access = workspace(original);
  let rootId = seeded.rootId;
  let expected = [...seeded.ids];

  const movedLeft = await moveVersionedOutlineSequenceRange(access, rootId, 25n, 16n, 4n);
  rootId = movedLeft.rootId;
  expected.splice(4, 0, ...expected.splice(25, 16));
  verifyTree(commit(original, access), rootId, expected);

  const movedBack = await moveVersionedOutlineSequenceRange(access, rootId, 4n, 16n, 41n);
  rootId = movedBack.rootId;
  expected.splice(25, 0, ...expected.splice(4, 16));
  expect(expected).toEqual(seeded.ids);

  const movedRight = await moveVersionedOutlineSequenceRange(access, rootId, 5n, 10n, 60n);
  rootId = movedRight.rootId;
  expected.splice(60 - 10, 0, ...expected.splice(5, 10));
  const movedRightBack = await moveVersionedOutlineSequenceRange(access, rootId, 50n, 10n, 5n);
  rootId = movedRightBack.rootId;
  expected.splice(5, 0, ...expected.splice(50, 10));
  expect(expected).toEqual(seeded.ids);

  const movedToEnd = await moveVersionedOutlineSequenceRange(access, rootId, 0n, 5n, 96n);
  rootId = movedToEnd.rootId;
  expected.splice(91, 0, ...expected.splice(0, 5));
  const movedToStart = await moveVersionedOutlineSequenceRange(access, rootId, 91n, 5n, 0n);
  rootId = movedToStart.rootId;
  expected.splice(0, 0, ...expected.splice(91, 5));
  expect(expected).toEqual(seeded.ids);

  expect(await moveVersionedOutlineSequenceRange(access, rootId, 7n, 0n, 96n)).toEqual({ rootId });
  expect(await moveVersionedOutlineSequenceRange(access, rootId, 20n, 8n, 28n)).toEqual({ rootId });
  const selected = commit(original, access);
  verifyTree(selected, rootId, seeded.ids);
  verifyTree(original, seeded.rootId, seeded.ids);
});

test('cross-root splice writes range boundaries only and membership follows each selected root', async () => {
  const source = seedBalanced(64, 'source-');
  const target = seedBalanced(12, 'target-');
  const original = new Map([...source.nodes, ...target.nodes]);
  const access = workspace(original);

  const firstSplit = await splitVersionedOutlineSequence(access, source.rootId, 10n);
  const rangeSplit = await splitVersionedOutlineSequence(access, firstSplit.rightRootId, 20n);
  const sourceRootId = await joinVersionedOutlineSequences(access, firstSplit.leftRootId, rangeSplit.rightRootId);
  const spliced = await spliceVersionedOutlineSequence(access, target.rootId, 3n, 2n, rangeSplit.leftRootId);
  const selected = commit(original, access);
  const sourceExpected = [...source.ids.slice(0, 10), ...source.ids.slice(30)];
  const targetExpected = [...target.ids.slice(0, 3), ...source.ids.slice(10, 30), ...target.ids.slice(5)];

  verifyTree(selected, sourceRootId, sourceExpected);
  verifyTree(selected, spliced.rootId, targetExpected);
  verifyTree(selected, spliced.removedRootId, target.ids.slice(3, 5));
  verifyTree(original, source.rootId, source.ids);
  verifyTree(original, target.rootId, target.ids);

  expect(await rankVersionedOutlineSequenceNode(workspace(selected), sourceRootId, source.ids[15]!)).toBeNull();
  expect(await rankVersionedOutlineSequenceNode(workspace(selected), spliced.rootId, source.ids[15]!)).toBe(8n);
  expect(await rankVersionedOutlineSequenceNode(workspace(selected), spliced.rootId, target.ids[3]!)).toBeNull();
  expect(await rankVersionedOutlineSequenceNode(workspace(original), source.rootId, source.ids[15]!)).toBe(15n);
  expect(await rankVersionedOutlineSequenceNode(workspace(original), target.rootId, target.ids[3]!)).toBe(3n);
  expect(access.work().writtenNodeCount).toBeLessThan(20);
  expect(access.work().distinctVisitedNodeCount).toBeLessThan(64);
});

test('a 50,000-node range move in a 100,000-node root does not write moved entries', async () => {
  const seeded = seedBalanced(100_000, 'large-', 17);
  const original = new Map(seeded.nodes);
  const access = workspace(original);
  const moved = await moveVersionedOutlineSequenceRange(access, seeded.rootId, 25_000n, 50_000n, 0n);
  const expected = [...seeded.ids.slice(25_000, 75_000), ...seeded.ids.slice(0, 25_000), ...seeded.ids.slice(75_000)];
  const selected = commit(original, access);
  verifyTree(selected, moved.rootId, expected);
  verifyTree(original, seeded.rootId, seeded.ids);

  const work = access.work();
  const logarithmicFixtureBound = 64 * (original.get(seeded.rootId!)!.height + 1);
  expect(work.writtenNodeCount).toBeLessThan(logarithmicFixtureBound);
  expect(work.distinctVisitedNodeCount).toBeLessThan(logarithmicFixtureBound);
  expect(work.snapshotProbeCount).toBeLessThan(logarithmicFixtureBound);
  expect(work.writtenNodeCount).toBeLessThan(50_000);
  expect(work.distinctVisitedNodeCount).toBeLessThan(50_000);
});

test('invalid ranks and ranges are rejected before sequence writes', async () => {
  const seeded = seedBalanced(5, 'invalid-');
  const access = workspace(seeded.nodes);
  const before = access.work();

  await expect(insertVersionedOutlineSequenceNode(access, seeded.rootId, -1n, 'new', 'new')).rejects.toThrow(
    RangeError,
  );
  await expect(insertVersionedOutlineSequenceNode(access, seeded.rootId, 6n, 'new', 'new')).rejects.toThrow(RangeError);
  await expect(
    insertVersionedOutlineSequenceNode(access, seeded.rootId, 0n, seeded.ids[0]!, 'duplicate'),
  ).rejects.toThrow('fresh logical node ID');
  await expect(selectVersionedOutlineSequenceNode(access, seeded.rootId, -1n)).rejects.toThrow(RangeError);
  await expect(splitVersionedOutlineSequence(access, seeded.rootId, 6n)).rejects.toThrow(RangeError);
  await expect(spliceVersionedOutlineSequence(access, seeded.rootId, 4n, 2n, null)).rejects.toThrow(RangeError);
  await expect(moveVersionedOutlineSequenceRange(access, seeded.rootId, 1n, 2n, 6n)).rejects.toThrow(RangeError);
  await expect(joinVersionedOutlineSequences(access, seeded.rootId, seeded.rootId)).rejects.toThrow(
    'join a root to itself',
  );
  const childRootId = seeded.nodes.get(seeded.rootId!)!.leftId!;
  await expect(selectVersionedOutlineSequenceNode(access, childRootId, 0n)).rejects.toThrow('selected root');

  expect(access.work().writtenNodeCount).toBe(before.writtenNodeCount);
  verifyTree(seeded.nodes, seeded.rootId, seeded.ids);
});

test('cached subtree maximum shrinks along indexed AVL paths and preserves older roots', async () => {
  const original = new Map<string, VersionedOutlineSequenceNode<string>>();
  const access = workspace(original);
  let rootId = await insertVersionedOutlineSequenceNode(access, null, 0n, 'a', 'a', undefined, 4);
  rootId = await insertVersionedOutlineSequenceNode(access, rootId, 1n, 'b', 'b', undefined, 4);
  rootId = await insertVersionedOutlineSequenceNode(access, rootId, 2n, 'c', 'c', undefined, 2);
  const oldSnapshot = commit(original, access);
  const oldRoot = rootId;

  expect(await maximumVersionedOutlineSequenceSubtreeHeight(workspace(oldSnapshot), oldRoot)).toEqual({
    complete: true,
    subtreeHeight: 4,
    occurrenceId: 'a',
  });

  await setVersionedOutlineSequenceSubtreeHeight(access, rootId, 'a', 1);
  expect(await maximumVersionedOutlineSequenceSubtreeHeight(access, rootId)).toEqual({
    complete: true,
    subtreeHeight: 4,
    occurrenceId: 'b',
  });
  await setVersionedOutlineSequenceSubtreeHeight(access, rootId, 'b', 0);
  expect(await maximumVersionedOutlineSequenceSubtreeHeight(access, rootId)).toEqual({
    complete: true,
    subtreeHeight: 2,
    occurrenceId: 'c',
  });
  expect(await maximumVersionedOutlineSequenceSubtreeHeight(workspace(oldSnapshot), oldRoot)).toMatchObject({
    subtreeHeight: 4,
    occurrenceId: 'a',
  });
  expect(access.work().writtenNodeCount).toBeLessThan(12);
});

test('legacy sequence maxima stay explicitly incomplete until all selected values are measured', async () => {
  const legacy = seedBalanced(63, 'legacy-');
  const access = workspace(legacy.nodes);
  expect(await maximumVersionedOutlineSequenceSubtreeHeight(access, legacy.rootId)).toEqual({
    complete: false,
    subtreeHeight: null,
    occurrenceId: null,
  });

  await setVersionedOutlineSequenceSubtreeHeight(access, legacy.rootId, legacy.ids[0]!, 3);
  expect(await maximumVersionedOutlineSequenceSubtreeHeight(access, legacy.rootId)).toEqual({
    complete: false,
    subtreeHeight: null,
    occurrenceId: null,
  });
});
