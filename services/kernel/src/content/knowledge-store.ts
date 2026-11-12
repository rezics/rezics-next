import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import publicRead from './knowledge-public-read.sql';
import publicSelection from './knowledge-public-selection.sql';
import privateRead from './knowledge-private-read.sql';
import readAncestors from './knowledge-placement-ancestors.sql';
import ownedNotebooks from './knowledge-owned-notebooks.sql';
import ownedNotebooksAfter from './knowledge-owned-notebooks-after.sql';
import notebookSelection from './knowledge-notebook-selection.sql';
import outlineChildren from './knowledge-outline-children.sql';
import outlineChildrenAfter from './knowledge-outline-children-after.sql';
import outlineRoot from './knowledge-outline-root.sql';
import outlineRootAfter from './knowledge-outline-root-after.sql';
import { KNOWLEDGE_ANCESTOR_LIMIT } from './knowledge-model.ts';

export type KnowledgePublicRow = Readonly<{
  route: number;
  document_id: string;
  current_publication_id: string;
  revision_id: string;
  subject_id: string;
  publication_sha256: Buffer;
  title: string;
  language: string | null;
  canonical_bytes: Buffer;
  body_sha256: Buffer;
  licence: string;
  subject_ids: string[];
  author_account_id: string | null;
  published_at: Date;
}>;

export type KnowledgePublicSelection = Readonly<{
  route: number;
  document_id: string;
  current_publication_id: string;
  publication_id: string;
  revision_id: string;
  subject_id: string;
  publication_sha256: Buffer;
  subject_ids: string[];
}>;

export type KnowledgePrivateRow = Readonly<{
  route: number;
  notebook_id: string;
  owner_account_id: string;
  subject_id: string;
  structure_revision_id: string;
  document_id: string;
  head_revision_id: string;
  current_publication_id: string | null;
  placement_id: string;
  parent_id: string | null;
  title: string;
  language: string | null;
  canonical_bytes: Buffer;
  body_sha256: Buffer;
  licence: string;
  subject_ids: string[];
  author_account_id: string | null;
}>;

export type KnowledgeAncestorRow = Readonly<{ placement_id: string; parent_id: string | null; depth: number }>;
export type KnowledgeOwnedNotebookRow = Readonly<{
  notebook_id: string;
  owner_account_id: string;
  subject_id: string;
  title: string;
  structure_revision_id: string;
  created_at: Date;
  created_at_key: string;
}>;
export type KnowledgeNotebookSelection = Readonly<{
  owner_account_id: string;
  structure_revision_id: string;
}>;
export type KnowledgeOutlineChildRow = Readonly<{
  placement_id: string;
  document_id: string;
  parent_id: string | null;
  position: string;
  title: string;
}>;

/** Revision writes validate every Subject id before storing this JSON array. */
function storedSubjectIds(ids: (string | null)[]): string[] {
  return ids as string[];
}

export async function knowledgeOwner(
  pool: Pool,
  documentId: string,
): Promise<Readonly<{ route: number; notebook_id: string; owner_account_id: string }> | null> {
  const route = routeOf(documentId);
  if (route === null) return null;
  return withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (!partition) return null;
    const result = await client.query<{ notebook_id: string; owner_account_id: string }>(
      `SELECT d.notebook_id,n.owner_account_id
       FROM content.knowledge_document d
       JOIN content.knowledge_notebook n ON n.route=d.route AND n.notebook_id=d.notebook_id
       WHERE d.route=$1 AND d.document_id=$2`,
      [route, documentId],
    );
    const row = result.rows[0];
    return row ? { route, ...row } : null;
  });
}

export async function knowledgeNotebookOwner(
  pool: Pool,
  notebookId: string,
): Promise<Readonly<{ route: number; owner_account_id: string }> | null> {
  const route = routeOf(notebookId);
  if (route === null) return null;
  return withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (!partition) return null;
    const result = await client.query<{ owner_account_id: string }>(
      `SELECT owner_account_id FROM content.knowledge_notebook WHERE route=$1 AND notebook_id=$2`,
      [route, notebookId],
    );
    const row = result.rows[0];
    return row ? { route, ...row } : null;
  });
}

export async function knowledgeSelectedSubject(
  pool: Pool,
  route: number,
  documentId: string,
  revisionId: string,
): Promise<Readonly<{ subject_id: string; subject_ids: string[] }> | null> {
  return withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (!partition) return null;
    const result = await client.query<{ subject_id: string; subject_ids: string[] }>(
      `SELECT n.subject_id,r.subject_ids
       FROM content.knowledge_document d
       JOIN content.knowledge_notebook n ON n.route=d.route AND n.notebook_id=d.notebook_id
       JOIN content.knowledge_revision r ON r.route=d.route AND r.document_id=d.document_id AND r.revision_id=$3
       WHERE d.route=$1 AND d.document_id=$2`,
      [route, documentId, revisionId],
    );
    return result.rows[0] ?? null;
  });
}

export async function knowledgePrivateRow(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  documentId: string,
): Promise<KnowledgePrivateRow | null> {
  const row = await privateRead.run(tx, { route, notebook_id: notebookId, document_id: documentId });
  if (!row) return null;
  return {
    ...row,
    canonical_bytes: Buffer.from(row.canonical_bytes),
    body_sha256: Buffer.from(row.body_sha256),
    subject_ids: storedSubjectIds(row.subject_ids),
  };
}

export async function knowledgePublicRow(
  tx: CommandTransaction,
  route: number,
  documentId: string,
): Promise<KnowledgePublicRow | null> {
  const row = await publicRead.run(tx, { route, document_id: documentId });
  if (!row) return null;
  return {
    ...row,
    publication_sha256: Buffer.from(row.publication_sha256),
    canonical_bytes: Buffer.from(row.canonical_bytes),
    body_sha256: Buffer.from(row.body_sha256),
    subject_ids: storedSubjectIds(row.subject_ids),
    published_at: new Date(row.published_at),
  };
}

export async function knowledgePublicSelection(
  tx: CommandTransaction,
  route: number,
  documentId: string,
): Promise<KnowledgePublicSelection | null> {
  const row = await publicSelection.run(tx, { route, document_id: documentId });
  return row
    ? {
        ...row,
        publication_sha256: Buffer.from(row.publication_sha256),
        subject_ids: storedSubjectIds(row.subject_ids),
      }
    : null;
}

export async function knowledgeAncestorPath(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  placementId: string,
): Promise<readonly KnowledgeAncestorRow[]> {
  return readAncestors.run(tx, {
    route,
    notebook_id: notebookId,
    placement_id: placementId,
    maximum_depth: KNOWLEDGE_ANCESTOR_LIMIT,
  });
}

/** Reads the bounded owner directory through its `(route, owner, created_at, notebook)` index. */
export async function knowledgeOwnedNotebookPage(
  tx: CommandTransaction,
  route: number,
  ownerId: string,
  after: Readonly<{ createdAt: string; notebookId: string }> | null,
  limit: number,
): Promise<readonly KnowledgeOwnedNotebookRow[]> {
  const rows = after
    ? await ownedNotebooksAfter.run(tx, {
        route,
        owner_account_id: ownerId,
        after_created_at: after.createdAt,
        after_notebook_id: after.notebookId,
        limit,
      })
    : await ownedNotebooks.run(tx, { route, owner_account_id: ownerId, limit });
  return rows.map((row) => ({ ...row, created_at: new Date(row.created_at) }));
}

export async function knowledgeNotebookSelection(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
): Promise<KnowledgeNotebookSelection | null> {
  const row = await notebookSelection.run(tx, { route, notebook_id: notebookId });
  return row ?? null;
}

/** Reads only one indexed sibling range. Sparse rows are resumed by the caller's last examined key. */
export async function knowledgeOutlineChildrenPage(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  parentId: string | null,
  after: Readonly<{ position: string; placementId: string }> | null,
  limit: number,
): Promise<readonly KnowledgeOutlineChildRow[]> {
  const params = { route, notebook_id: notebookId, parent_id: parentId, limit };
  const afterParams = after ? { after_position: after.position, after_placement_id: after.placementId } : null;
  const rows =
    parentId === null
      ? afterParams
        ? await outlineRootAfter.run(tx, { route, notebook_id: notebookId, limit, ...afterParams })
        : await outlineRoot.run(tx, { route, notebook_id: notebookId, limit })
      : afterParams
        ? await outlineChildrenAfter.run(tx, { ...params, ...afterParams })
        : await outlineChildren.run(tx, params);
  return rows.map((row) => ({ ...row, position: String(row.position) }));
}
