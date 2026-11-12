import type { CommandTransaction } from '../command/command.ts';
import { newId } from '../route/route.ts';

export type KnowledgeOrderEntry = Readonly<{
  placementId: string;
  documentId: string;
  parentId: string | null;
  position: bigint;
}>;

export type KnowledgeOrderPageNode = KnowledgeOrderEntry &
  Readonly<{ pageId: string; treeHeight: number; leftPageId: string | null; rightPageId: string | null }>;

type PageValue = KnowledgeOrderEntry;

function compare(
  left: Readonly<{ position: bigint; placementId: string }>,
  right: Readonly<{ position: bigint; placementId: string }>,
) {
  if (left.position < right.position) return -1;
  if (left.position > right.position) return 1;
  return left.placementId.localeCompare(right.placementId);
}

function pageValue(node: KnowledgeOrderPageNode): PageValue {
  return {
    placementId: node.placementId,
    documentId: node.documentId,
    parentId: node.parentId,
    position: node.position,
  };
}

async function readPageNode(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  pageId: string,
): Promise<KnowledgeOrderPageNode | null> {
  const result = await tx.query<{
    page_id: string;
    placement_id: string;
    document_id: string;
    parent_id: string | null;
    position: string;
    tree_height: number;
    left_page_id: string | null;
    right_page_id: string | null;
  }>(
    `SELECT page_id,placement_id,document_id,parent_id,position::text AS position,tree_height,left_page_id,right_page_id
     FROM content.knowledge_structure_page
     WHERE route=$1 AND notebook_id=$2 AND page_id=$3`,
    [route, notebookId, pageId],
  );
  const row = result.rows[0];
  return row
    ? {
        pageId: row.page_id,
        placementId: row.placement_id,
        documentId: row.document_id,
        parentId: row.parent_id,
        position: BigInt(row.position),
        treeHeight: row.tree_height,
        leftPageId: row.left_page_id,
        rightPageId: row.right_page_id,
      }
    : null;
}

async function writePageNode(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  value: PageValue,
  leftPageId: string | null,
  rightPageId: string | null,
): Promise<KnowledgeOrderPageNode> {
  const [left, right] = await Promise.all([
    leftPageId === null ? null : readPageNode(tx, route, notebookId, leftPageId),
    rightPageId === null ? null : readPageNode(tx, route, notebookId, rightPageId),
  ]);
  if ((leftPageId !== null && !left) || (rightPageId !== null && !right))
    throw new Error('Knowledge order page references a missing child');
  const pageId = newId(route);
  const treeHeight = Math.max(left?.treeHeight ?? 0, right?.treeHeight ?? 0) + 1;
  await tx.query(
    `INSERT INTO content.knowledge_structure_page
      (route,notebook_id,page_id,placement_id,document_id,parent_id,position,tree_height,left_page_id,right_page_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      route,
      notebookId,
      pageId,
      value.placementId,
      value.documentId,
      value.parentId,
      value.position.toString(),
      treeHeight,
      leftPageId,
      rightPageId,
    ],
  );
  return { ...value, pageId, treeHeight, leftPageId, rightPageId };
}

async function rebalancePageNode(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  value: PageValue,
  leftPageId: string | null,
  rightPageId: string | null,
): Promise<string> {
  const left = leftPageId === null ? null : await readPageNode(tx, route, notebookId, leftPageId);
  const right = rightPageId === null ? null : await readPageNode(tx, route, notebookId, rightPageId);
  if ((leftPageId !== null && !left) || (rightPageId !== null && !right))
    throw new Error('Knowledge order page references a missing child');
  const balance = (left?.treeHeight ?? 0) - (right?.treeHeight ?? 0);
  if (balance > 1) {
    const pivot = left!;
    const pivotLeft = pivot.leftPageId === null ? null : await readPageNode(tx, route, notebookId, pivot.leftPageId);
    const pivotRight = pivot.rightPageId === null ? null : await readPageNode(tx, route, notebookId, pivot.rightPageId);
    if ((pivotLeft?.treeHeight ?? 0) >= (pivotRight?.treeHeight ?? 0)) {
      const nextRight = await writePageNode(tx, route, notebookId, value, pivot.rightPageId, rightPageId);
      return (await writePageNode(tx, route, notebookId, pageValue(pivot), pivot.leftPageId, nextRight.pageId)).pageId;
    }
    const middle = pivotRight!;
    const nextLeft = await writePageNode(tx, route, notebookId, pageValue(pivot), pivot.leftPageId, middle.leftPageId);
    const nextRight = await writePageNode(tx, route, notebookId, value, middle.rightPageId, rightPageId);
    return (await writePageNode(tx, route, notebookId, pageValue(middle), nextLeft.pageId, nextRight.pageId)).pageId;
  }
  if (balance < -1) {
    const pivot = right!;
    const pivotLeft = pivot.leftPageId === null ? null : await readPageNode(tx, route, notebookId, pivot.leftPageId);
    const pivotRight = pivot.rightPageId === null ? null : await readPageNode(tx, route, notebookId, pivot.rightPageId);
    if ((pivotRight?.treeHeight ?? 0) >= (pivotLeft?.treeHeight ?? 0)) {
      const nextLeft = await writePageNode(tx, route, notebookId, value, leftPageId, pivot.leftPageId);
      return (await writePageNode(tx, route, notebookId, pageValue(pivot), nextLeft.pageId, pivot.rightPageId)).pageId;
    }
    const middle = pivotLeft!;
    const nextLeft = await writePageNode(tx, route, notebookId, value, leftPageId, middle.leftPageId);
    const nextRight = await writePageNode(
      tx,
      route,
      notebookId,
      pageValue(pivot),
      middle.rightPageId,
      pivot.rightPageId,
    );
    return (await writePageNode(tx, route, notebookId, pageValue(middle), nextLeft.pageId, nextRight.pageId)).pageId;
  }
  return (await writePageNode(tx, route, notebookId, value, leftPageId, rightPageId)).pageId;
}

async function insertPageNode(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  rootPageId: string | null,
  value: PageValue,
): Promise<string> {
  if (rootPageId === null) return (await writePageNode(tx, route, notebookId, value, null, null)).pageId;
  const root = await readPageNode(tx, route, notebookId, rootPageId);
  if (!root) throw new Error('Knowledge order root references a missing page');
  const order = compare(value, root);
  if (order === 0) throw new Error('Knowledge order contains a duplicate key');
  const leftPageId = order < 0 ? await insertPageNode(tx, route, notebookId, root.leftPageId, value) : root.leftPageId;
  const rightPageId =
    order > 0 ? await insertPageNode(tx, route, notebookId, root.rightPageId, value) : root.rightPageId;
  return rebalancePageNode(tx, route, notebookId, pageValue(root), leftPageId, rightPageId);
}

async function removeMinimum(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  root: KnowledgeOrderPageNode,
): Promise<Readonly<{ value: PageValue; rootPageId: string | null }>> {
  if (root.leftPageId === null) return { value: pageValue(root), rootPageId: root.rightPageId };
  const left = await readPageNode(tx, route, notebookId, root.leftPageId);
  if (!left) throw new Error('Knowledge order left child is missing');
  const removed = await removeMinimum(tx, route, notebookId, left);
  return {
    value: removed.value,
    rootPageId: await rebalancePageNode(tx, route, notebookId, pageValue(root), removed.rootPageId, root.rightPageId),
  };
}

async function removePageNode(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  rootPageId: string | null,
  key: Readonly<{ position: bigint; placementId: string }>,
): Promise<Readonly<{ rootPageId: string | null; removed: KnowledgeOrderPageNode | null }>> {
  if (rootPageId === null) return { rootPageId: null, removed: null };
  const root = await readPageNode(tx, route, notebookId, rootPageId);
  if (!root) throw new Error('Knowledge order root references a missing page');
  const order = compare(key, root);
  if (order === 0) {
    if (root.placementId !== key.placementId) throw new Error('Knowledge order key does not identify its placement');
    if (root.leftPageId === null) return { rootPageId: root.rightPageId, removed: root };
    if (root.rightPageId === null) return { rootPageId: root.leftPageId, removed: root };
    const right = await readPageNode(tx, route, notebookId, root.rightPageId);
    if (!right) throw new Error('Knowledge order right child is missing');
    const minimum = await removeMinimum(tx, route, notebookId, right);
    return {
      rootPageId: await rebalancePageNode(tx, route, notebookId, minimum.value, root.leftPageId, minimum.rootPageId),
      removed: root,
    };
  }
  const result = await removePageNode(tx, route, notebookId, order < 0 ? root.leftPageId : root.rightPageId, key);
  if (!result.removed) return { rootPageId, removed: null };
  return {
    rootPageId: await rebalancePageNode(
      tx,
      route,
      notebookId,
      pageValue(root),
      order < 0 ? result.rootPageId : root.leftPageId,
      order > 0 ? result.rootPageId : root.rightPageId,
    ),
    removed: result.removed,
  };
}

export function insertKnowledgeOrderEntry(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  rootPageId: string | null,
  entry: KnowledgeOrderEntry,
): Promise<string> {
  return insertPageNode(tx, route, notebookId, rootPageId, entry);
}

export function removeKnowledgeOrderEntry(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  rootPageId: string | null,
  entry: Pick<KnowledgeOrderEntry, 'placementId' | 'position'>,
): Promise<Readonly<{ rootPageId: string | null; removed: KnowledgeOrderPageNode | null }>> {
  return removePageNode(tx, route, notebookId, rootPageId, entry);
}

/** The immutable AVL index gives a historical keyset page in O(log N + page size) node reads. */
export async function readKnowledgeOrderPage(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  rootPageId: string | null,
  after: Readonly<{ position: bigint; placementId: string }> | null,
  limit: number,
): Promise<readonly KnowledgeOrderPageNode[]> {
  if (rootPageId === null) return [];
  const stack: KnowledgeOrderPageNode[] = [];
  let nodeId: string | null = rootPageId;
  while (nodeId !== null) {
    const node = await readPageNode(tx, route, notebookId, nodeId);
    if (!node) throw new Error('Knowledge order root references a missing page');
    if (after === null || compare(node, after) > 0) {
      stack.push(node);
      nodeId = node.leftPageId;
    } else {
      nodeId = node.rightPageId;
    }
  }

  const page: KnowledgeOrderPageNode[] = [];
  while (stack.length > 0 && page.length < limit) {
    const node = stack.pop()!;
    page.push(node);
    nodeId = node.rightPageId;
    while (nodeId !== null) {
      const child = await readPageNode(tx, route, notebookId, nodeId);
      if (!child) throw new Error('Knowledge order page references a missing child');
      stack.push(child);
      nodeId = child.leftPageId;
    }
  }
  return page;
}
