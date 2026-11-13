import { expect, test } from 'bun:test';
import {
  insertVersionedOutlineEntry,
  readVersionedOutlinePage,
  removeVersionedOutlineEntry,
  type VersionedOutlineNode,
  type VersionedOutlinePorts,
  type VersionedOutlineSummary,
} from '../../src/content/versioned-outline-order.ts';

type OrderKey = Readonly<{ position: bigint; placementId: string }>;
type OrderValue = Readonly<{
  placementId: string;
  documentId: string;
  parentId: string | null;
  position: bigint;
}>;

function compare(left: OrderKey, right: OrderKey) {
  if (left.position < right.position) return -1;
  if (left.position > right.position) return 1;
  return left.placementId.localeCompare(right.placementId);
}

function memoryPorts() {
  const nodes = new Map<string, VersionedOutlineNode<OrderValue>>();
  let nextId = 1;
  let reads = 0;
  const ports: VersionedOutlinePorts<OrderKey, OrderValue> = {
    compare,
    keyOf: (value) => ({ position: value.position, placementId: value.placementId }),
    read: async (id) => {
      reads += 1;
      return nodes.get(id) ?? null;
    },
    write: async (value, leftId, rightId, summary) => {
      const node: VersionedOutlineNode<OrderValue> = {
        id: `n${nextId++}`,
        leftId,
        rightId,
        value,
        summary,
      };
      if (nodes.has(node.id)) throw new Error('memory outline adapter reused a node identity');
      nodes.set(node.id, node);
      return node;
    },
    summarize: (_value, left, right) => ({ height: Math.max(left?.height ?? 0, right?.height ?? 0) + 1 }),
  };
  return {
    ports,
    nodes,
    reads: () => reads,
    resetReads: () => {
      reads = 0;
    },
  };
}

function entry(index: number, parentId: string | null = null): OrderValue {
  const placementId = `p${String(index).padStart(4, '0')}`;
  return { placementId, documentId: `d${String(index).padStart(4, '0')}`, parentId, position: BigInt(index) * 1000n };
}

async function collect(
  ports: VersionedOutlinePorts<OrderKey, OrderValue>,
  rootId: string | null,
  after: OrderKey | null = null,
  limit = 64,
) {
  const values: OrderValue[] = [];
  let cursor = after;
  for (;;) {
    const page = await readVersionedOutlinePage(ports, rootId, cursor, limit);
    if (page.length === 0) return values;
    for (const node of page) values.push(node.value);
    if (page.length < limit) return values;
    cursor = ports.keyOf(page[page.length - 1]!.value);
  }
}

async function insertAll(ports: VersionedOutlinePorts<OrderKey, OrderValue>, values: readonly OrderValue[]) {
  let rootId: string | null = null;
  for (const value of values) rootId = await insertVersionedOutlineEntry(ports, rootId, value);
  return rootId;
}

test('rotations keep sorted order and duplicate keys stay rejected', async () => {
  const cases: readonly (readonly number[])[] = [
    [1, 2, 3],
    [3, 2, 1],
    [3, 1, 2],
    [1, 3, 2],
  ];
  for (const order of cases) {
    const { ports } = memoryPorts();
    const rootId = await insertAll(
      ports,
      order.map((index) => entry(index)),
    );
    expect((await collect(ports, rootId)).map(({ placementId }) => placementId)).toEqual(['p0001', 'p0002', 'p0003']);
    expect((await ports.read(rootId!))!.summary.height).toBe(2);
  }

  const { ports, resetReads } = memoryPorts();
  const rootId = await insertAll(ports, [entry(1), entry(3)]);
  await expect(insertVersionedOutlineEntry(ports, rootId, entry(1))).rejects.toThrow(
    'Versioned outline order contains a duplicate key',
  );
  resetReads();
  const missing = await removeVersionedOutlineEntry(ports, rootId, { position: 2000n, placementId: 'p0002' });
  expect(missing).toEqual({ rootId, removed: null });
  expect(missing.rootId).toBe(rootId);
});

test('old roots stay intact while point edits and pages past 512 stay logarithmic', async () => {
  const { ports, nodes, reads, resetReads } = memoryPorts();
  const values = Array.from({ length: 600 }, (_, index) => entry(index + 1));
  const originalRoot = await insertAll(ports, values);
  const original = await collect(ports, originalRoot);
  expect(original).toHaveLength(600);
  expect(original.map(({ placementId }) => placementId)).toEqual(values.map(({ placementId }) => placementId));
  const originalHeight = (await ports.read(originalRoot!))!.summary.height;
  expect(originalHeight).toBeLessThanOrEqual(Math.ceil(1.4405 * Math.log2(602) + 1));

  resetReads();
  const afterInsert = await insertVersionedOutlineEntry(ports, originalRoot, {
    ...entry(512),
    placementId: 'p0512a',
    documentId: 'd0512a',
    position: 512n * 1000n + 1n,
  });
  const insertReads = reads();
  expect(insertReads).toBeLessThan(values.length);
  expect(insertReads).toBeLessThanOrEqual(16 * (originalHeight + 1));
  expect(afterInsert).not.toBe(originalRoot);
  expect(await collect(ports, originalRoot)).toEqual(original);

  resetReads();
  const removed = await removeVersionedOutlineEntry(ports, afterInsert, {
    position: 100n * 1000n,
    placementId: 'p0100',
  });
  const removeReads = reads();
  expect(removed.removed?.value.placementId).toBe('p0100');
  expect(removeReads).toBeLessThan(values.length);
  expect(removeReads).toBeLessThanOrEqual(16 * (originalHeight + 2));
  expect(removed.rootId).not.toBe(originalRoot);
  expect(await collect(ports, originalRoot)).toEqual(original);

  const movedRoot = await insertVersionedOutlineEntry(ports, removed.rootId, {
    ...removed.removed!.value,
    parentId: 'section',
    position: 512n * 1000n + 2n,
  });
  expect(await collect(ports, originalRoot)).toEqual(original);
  const moved = await collect(ports, movedRoot);
  expect(moved).toHaveLength(601);
  expect(moved.find(({ placementId }) => placementId === 'p0100')?.parentId).toBe('section');
  expect(moved.map(({ placementId }) => placementId).filter((id) => id === 'p0100')).toEqual(['p0100']);

  const after = { position: 512n * 1000n, placementId: 'p0512' };
  resetReads();
  const page = await readVersionedOutlinePage(ports, movedRoot, after, 20);
  const pageReads = reads();
  const pageHeight = (await ports.read(movedRoot!))!.summary.height;
  expect(page.map(({ value }) => value.placementId)).toEqual([
    'p0512a',
    'p0100',
    ...Array.from({ length: 18 }, (_, index) => `p${String(513 + index).padStart(4, '0')}`),
  ]);
  expect(pageReads).toBeLessThanOrEqual(4 * (pageHeight + 20));
  expect(pageReads).toBeLessThan(moved.length);

  const stored: VersionedOutlineNode<OrderValue, VersionedOutlineSummary>[] = [...nodes.values()];
  expect(new Set(stored.map(({ id }) => id)).size).toBe(stored.length);
});
