import type { CommandAuthorization, CommandTransaction } from '../command/command.ts';
import { KnowledgeNotFoundError } from './knowledge-model.ts';

/** All native structure and lifecycle writers take this lock first. It fences a current owner and
 * primary path against concurrent insertion/move, without locking unrelated documents or references. */
export async function lockKnowledgeNotebook(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  ownerId: string,
): Promise<string> {
  const result = await tx.query<{ owner_account_id: string; structure_revision_id: string }>(
    `SELECT owner_account_id,structure_revision_id FROM content.knowledge_notebook
     WHERE route=$1 AND notebook_id=$2 FOR UPDATE`,
    [route, notebookId],
  );
  const row = result.rows[0];
  if (!row || row.owner_account_id !== ownerId) throw new KnowledgeNotFoundError();
  return row.structure_revision_id;
}

/** Same current eligibility as public/private selection, also usable by subsequent subtree work. */
export async function requireKnowledgeDocumentEligible(
  tx: CommandTransaction,
  route: number,
  documentId: string,
  includeTrashedTarget = false,
): Promise<void> {
  const result = await tx.query<{ eligible: boolean }>(
    `SELECT content.knowledge_document_eligible($1,$2,$3) AS eligible`,
    [route, documentId, includeTrashedTarget],
  );
  if (!result.rows[0]!.eligible) throw new KnowledgeNotFoundError();
}

/** A receipt is usable only while its native destination is currently owned and active. */
export function fenceKnowledgeAuthorization(
  authorization: CommandAuthorization,
  route: number,
  notebookId: string,
  ownerId: string,
  documentId?: string,
  placementIds: readonly string[] = [],
): CommandAuthorization {
  return {
    ...authorization,
    async authorize(tx, attempt, evidence) {
      const mode = await authorization.authorize(tx, attempt, evidence);
      await lockKnowledgeNotebook(tx, route, notebookId, ownerId);
      if (documentId !== undefined) await requireKnowledgeDocumentEligible(tx, route, documentId);
      for (const placementId of placementIds) {
        const selected = await tx.query<{ eligible: boolean }>(
          `SELECT content.knowledge_document_eligible(route,document_id) AS eligible
           FROM content.knowledge_placement WHERE route=$1 AND notebook_id=$2 AND placement_id=$3`,
          [route, notebookId, placementId],
        );
        if (!selected.rows[0]?.eligible) throw new KnowledgeNotFoundError();
      }
      return mode;
    },
  };
}
