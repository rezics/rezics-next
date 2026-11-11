import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import publicRead from './knowledge-public-read.sql';
import publicSelection from './knowledge-public-selection.sql';
import privateRead from './knowledge-private-read.sql';
import readAncestors from './knowledge-placement-ancestors.sql';
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
  return privateRead.run(tx, { route, notebook_id: notebookId, document_id: documentId });
}

export async function knowledgePublicRow(
  tx: CommandTransaction,
  route: number,
  documentId: string,
): Promise<KnowledgePublicRow | null> {
  return publicRead.run(tx, { route, document_id: documentId });
}

export async function knowledgePublicSelection(
  tx: CommandTransaction,
  route: number,
  documentId: string,
): Promise<KnowledgePublicSelection | null> {
  return publicSelection.run(tx, { route, document_id: documentId });
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
