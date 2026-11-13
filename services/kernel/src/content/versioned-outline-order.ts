/** Copy-on-write AVL sequence. Owners allocate identities and store values; order keys, payloads and publication stay outside. */

export type VersionedOutlineSummary = Readonly<{ height: number }>;

export type VersionedOutlineNode<Value, Summary extends VersionedOutlineSummary = VersionedOutlineSummary> = Readonly<{
  id: string;
  leftId: string | null;
  rightId: string | null;
  value: Value;
  summary: Summary;
}>;

export type VersionedOutlinePorts<
  Key,
  Value,
  Summary extends VersionedOutlineSummary = VersionedOutlineSummary,
> = Readonly<{
  compare: (left: Key, right: Key) => number;
  keyOf: (value: Value) => Key;
  read: (id: string) => Promise<VersionedOutlineNode<Value, Summary> | null>;
  write: (
    value: Value,
    leftId: string | null,
    rightId: string | null,
    summary: Summary,
  ) => Promise<VersionedOutlineNode<Value, Summary>>;
  summarize: (value: Value, left: Summary | null, right: Summary | null) => Summary;
}>;

export type VersionedOutlineRemoval<
  Value,
  Summary extends VersionedOutlineSummary = VersionedOutlineSummary,
> = Readonly<{
  rootId: string | null;
  removed: VersionedOutlineNode<Value, Summary> | null;
}>;

async function writeNode<Key, Value, Summary extends VersionedOutlineSummary>(
  ports: VersionedOutlinePorts<Key, Value, Summary>,
  value: Value,
  leftId: string | null,
  rightId: string | null,
): Promise<VersionedOutlineNode<Value, Summary>> {
  const [left, right] = await Promise.all([
    leftId === null ? null : ports.read(leftId),
    rightId === null ? null : ports.read(rightId),
  ]);
  if ((leftId !== null && !left) || (rightId !== null && !right))
    throw new Error('Versioned outline order references a missing child');
  return ports.write(value, leftId, rightId, ports.summarize(value, left?.summary ?? null, right?.summary ?? null));
}

async function rebalanceNode<Key, Value, Summary extends VersionedOutlineSummary>(
  ports: VersionedOutlinePorts<Key, Value, Summary>,
  value: Value,
  leftId: string | null,
  rightId: string | null,
): Promise<string> {
  const left = leftId === null ? null : await ports.read(leftId);
  const right = rightId === null ? null : await ports.read(rightId);
  if ((leftId !== null && !left) || (rightId !== null && !right))
    throw new Error('Versioned outline order references a missing child');
  const balance = (left?.summary.height ?? 0) - (right?.summary.height ?? 0);
  if (balance > 1) {
    const pivot = left!;
    const pivotLeft = pivot.leftId === null ? null : await ports.read(pivot.leftId);
    const pivotRight = pivot.rightId === null ? null : await ports.read(pivot.rightId);
    if ((pivotLeft?.summary.height ?? 0) >= (pivotRight?.summary.height ?? 0)) {
      const nextRight = await writeNode(ports, value, pivot.rightId, rightId);
      return (await writeNode(ports, pivot.value, pivot.leftId, nextRight.id)).id;
    }
    const middle = pivotRight!;
    const nextLeft = await writeNode(ports, pivot.value, pivot.leftId, middle.leftId);
    const nextRight = await writeNode(ports, value, middle.rightId, rightId);
    return (await writeNode(ports, middle.value, nextLeft.id, nextRight.id)).id;
  }
  if (balance < -1) {
    const pivot = right!;
    const pivotLeft = pivot.leftId === null ? null : await ports.read(pivot.leftId);
    const pivotRight = pivot.rightId === null ? null : await ports.read(pivot.rightId);
    if ((pivotRight?.summary.height ?? 0) >= (pivotLeft?.summary.height ?? 0)) {
      const nextLeft = await writeNode(ports, value, leftId, pivot.leftId);
      return (await writeNode(ports, pivot.value, nextLeft.id, pivot.rightId)).id;
    }
    const middle = pivotLeft!;
    const nextLeft = await writeNode(ports, value, leftId, middle.leftId);
    const nextRight = await writeNode(ports, pivot.value, middle.rightId, pivot.rightId);
    return (await writeNode(ports, middle.value, nextLeft.id, nextRight.id)).id;
  }
  return (await writeNode(ports, value, leftId, rightId)).id;
}

async function insertNode<Key, Value, Summary extends VersionedOutlineSummary>(
  ports: VersionedOutlinePorts<Key, Value, Summary>,
  rootId: string | null,
  value: Value,
): Promise<string> {
  if (rootId === null) return (await writeNode(ports, value, null, null)).id;
  const root = await ports.read(rootId);
  if (!root) throw new Error('Versioned outline order root references a missing page');
  const order = ports.compare(ports.keyOf(value), ports.keyOf(root.value));
  if (order === 0) throw new Error('Versioned outline order contains a duplicate key');
  const leftId = order < 0 ? await insertNode(ports, root.leftId, value) : root.leftId;
  const rightId = order > 0 ? await insertNode(ports, root.rightId, value) : root.rightId;
  return rebalanceNode(ports, root.value, leftId, rightId);
}

async function removeMinimum<Key, Value, Summary extends VersionedOutlineSummary>(
  ports: VersionedOutlinePorts<Key, Value, Summary>,
  root: VersionedOutlineNode<Value, Summary>,
): Promise<Readonly<{ value: Value; rootId: string | null }>> {
  if (root.leftId === null) return { value: root.value, rootId: root.rightId };
  const left = await ports.read(root.leftId);
  if (!left) throw new Error('Versioned outline order left child is missing');
  const removed = await removeMinimum(ports, left);
  return {
    value: removed.value,
    rootId: await rebalanceNode(ports, root.value, removed.rootId, root.rightId),
  };
}

async function removeNode<Key, Value, Summary extends VersionedOutlineSummary>(
  ports: VersionedOutlinePorts<Key, Value, Summary>,
  rootId: string | null,
  key: Key,
): Promise<VersionedOutlineRemoval<Value, Summary>> {
  if (rootId === null) return { rootId: null, removed: null };
  const root = await ports.read(rootId);
  if (!root) throw new Error('Versioned outline order root references a missing page');
  const order = ports.compare(key, ports.keyOf(root.value));
  if (order === 0) {
    if (root.leftId === null) return { rootId: root.rightId, removed: root };
    if (root.rightId === null) return { rootId: root.leftId, removed: root };
    const right = await ports.read(root.rightId);
    if (!right) throw new Error('Versioned outline order right child is missing');
    const minimum = await removeMinimum(ports, right);
    return {
      rootId: await rebalanceNode(ports, minimum.value, root.leftId, minimum.rootId),
      removed: root,
    };
  }
  const result = await removeNode(ports, order < 0 ? root.leftId : root.rightId, key);
  if (!result.removed) return { rootId, removed: null };
  return {
    rootId: await rebalanceNode(
      ports,
      root.value,
      order < 0 ? result.rootId : root.leftId,
      order > 0 ? result.rootId : root.rightId,
    ),
    removed: result.removed,
  };
}

export function insertVersionedOutlineEntry<Key, Value, Summary extends VersionedOutlineSummary>(
  ports: VersionedOutlinePorts<Key, Value, Summary>,
  rootId: string | null,
  value: Value,
): Promise<string> {
  return insertNode(ports, rootId, value);
}

export function removeVersionedOutlineEntry<Key, Value, Summary extends VersionedOutlineSummary>(
  ports: VersionedOutlinePorts<Key, Value, Summary>,
  rootId: string | null,
  key: Key,
): Promise<VersionedOutlineRemoval<Value, Summary>> {
  return removeNode(ports, rootId, key);
}

/** Forward keyset page. Stops once `limit` values are collected so a filled page does not walk a remaining right spine. */
export async function readVersionedOutlinePage<Key, Value, Summary extends VersionedOutlineSummary>(
  ports: VersionedOutlinePorts<Key, Value, Summary>,
  rootId: string | null,
  after: Key | null,
  limit: number,
): Promise<readonly VersionedOutlineNode<Value, Summary>[]> {
  if (rootId === null) return [];
  const stack: VersionedOutlineNode<Value, Summary>[] = [];
  let nodeId: string | null = rootId;
  while (nodeId !== null) {
    const node = await ports.read(nodeId);
    if (!node) throw new Error('Versioned outline order root references a missing page');
    if (after === null || ports.compare(ports.keyOf(node.value), after) > 0) {
      stack.push(node);
      nodeId = node.leftId;
    } else {
      nodeId = node.rightId;
    }
  }

  const page: VersionedOutlineNode<Value, Summary>[] = [];
  while (stack.length > 0 && page.length < limit) {
    const node = stack.pop()!;
    page.push(node);
    if (page.length >= limit) break;
    nodeId = node.rightId;
    while (nodeId !== null) {
      const child = await ports.read(nodeId);
      if (!child) throw new Error('Versioned outline order references a missing child');
      stack.push(child);
      nodeId = child.leftId;
    }
  }
  return page;
}
