import type { CommandTransaction } from '../command/command.ts';
import { newId } from '../route/route.ts';
import {
  insertVersionedOutlineEntry,
  readVersionedOutlinePage,
  removeVersionedOutlineEntry,
  type VersionedOutlineNode,
  type VersionedOutlinePorts,
  type VersionedOutlineSummary,
} from './versioned-outline-order.ts';

export type KnowledgeOrderEntry = Readonly<{
  placementId: string;
  documentId: string;
  parentId: string | null;
  position: bigint;
}>;

export type KnowledgeOrderPageNode = KnowledgeOrderEntry &
  Readonly<{ pageId: string; treeHeight: number; leftPageId: string | null; rightPageId: string | null }>;

export type KnowledgeOrderKey = Readonly<{ position: bigint; placementId: string }>;

type PageValue = KnowledgeOrderEntry;
type KnowledgeOrderSummary = VersionedOutlineSummary;

function compareKnowledgeOrder(left: KnowledgeOrderKey, right: KnowledgeOrderKey) {
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

function outlineNode(node: KnowledgeOrderPageNode): VersionedOutlineNode<PageValue, KnowledgeOrderSummary> {
  return {
    id: node.pageId,
    leftId: node.leftPageId,
    rightId: node.rightPageId,
    value: pageValue(node),
    summary: { height: node.treeHeight },
  };
}

function pageNode(node: VersionedOutlineNode<PageValue, KnowledgeOrderSummary>): KnowledgeOrderPageNode {
  return {
    ...node.value,
    pageId: node.id,
    treeHeight: node.summary.height,
    leftPageId: node.leftId,
    rightPageId: node.rightId,
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
  summary: KnowledgeOrderSummary,
): Promise<KnowledgeOrderPageNode> {
  const pageId = newId(route);
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
      summary.height,
      leftPageId,
      rightPageId,
    ],
  );
  return { ...value, pageId, treeHeight: summary.height, leftPageId, rightPageId };
}

function knowledgeOrderPorts(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
): VersionedOutlinePorts<KnowledgeOrderKey, PageValue, KnowledgeOrderSummary> {
  return {
    compare: compareKnowledgeOrder,
    keyOf: (value) => ({ position: value.position, placementId: value.placementId }),
    read: async (id) => {
      const node = await readPageNode(tx, route, notebookId, id);
      return node ? outlineNode(node) : null;
    },
    write: async (value, leftId, rightId, summary) =>
      outlineNode(await writePageNode(tx, route, notebookId, value, leftId, rightId, summary)),
    summarize: (_value, left, right) => ({ height: Math.max(left?.height ?? 0, right?.height ?? 0) + 1 }),
  };
}

export function insertKnowledgeOrderEntry(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  rootPageId: string | null,
  entry: KnowledgeOrderEntry,
): Promise<string> {
  return insertVersionedOutlineEntry(knowledgeOrderPorts(tx, route, notebookId), rootPageId, entry);
}

export async function removeKnowledgeOrderEntry(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  rootPageId: string | null,
  entry: Pick<KnowledgeOrderEntry, 'placementId' | 'position'>,
): Promise<Readonly<{ rootPageId: string | null; removed: KnowledgeOrderPageNode | null }>> {
  const result = await removeVersionedOutlineEntry(knowledgeOrderPorts(tx, route, notebookId), rootPageId, entry);
  return { rootPageId: result.rootId, removed: result.removed ? pageNode(result.removed) : null };
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
  const page = await readVersionedOutlinePage(knowledgeOrderPorts(tx, route, notebookId), rootPageId, after, limit);
  return page.map(pageNode);
}
