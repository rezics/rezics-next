import type { Actor, AccessClient } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accessCheck } from './access-port.ts';
import { ContentForbiddenError, RevisionPreconditionError } from './commands.ts';
import { snapshot } from './reads.ts';
import { knowledgeOwner } from './knowledge-store.ts';
import { lockKnowledgeNotebook, requireKnowledgeDocumentEligible } from './knowledge-eligibility.ts';
import {
  KnowledgeNotFoundError,
  type KnowledgeDependencies,
  type KnowledgeCommandContext,
  type KnowledgeReadContext,
} from './knowledge-model.ts';

export type KnowledgeLifecycleInput = Readonly<{
  expectedStructureRevisionId: string;
  expectedGeneration: string;
}>;
export type KnowledgeLifecycleValue = Readonly<{
  documentId: string;
  notebookId: string;
  structureRevisionId: string;
  generation: string;
  state: 'active' | 'trashed';
  restoreUntil: string | null;
}>;
export type KnowledgeLifecycleResult = KnowledgeLifecycleValue &
  Readonly<{ complete: boolean; reason: 'subtree_work_required' | null }>;

type LifecycleRow = Readonly<{
  notebook_id: string;
  lifecycle_generation: string;
  deleted_at: Date | null;
  purge_started_at: Date | null;
  purge_completed: boolean;
  placement_id: string;
  current_publication_id: string | null;
}>;
const RETENTION_MS = 30 * 86400000;

async function lifecycleRow(
  tx: CommandTransaction,
  route: number,
  documentId: string,
  lock = false,
): Promise<LifecycleRow | null> {
  const result = await tx.query<LifecycleRow>(
    `SELECT d.notebook_id,d.lifecycle_generation::text,d.deleted_at,d.purge_started_at,d.purge_completed,
            d.current_publication_id,p.placement_id
     FROM content.knowledge_document d
     JOIN content.knowledge_placement p
       ON p.route=d.route AND p.notebook_id=d.notebook_id AND p.document_id=d.document_id
     WHERE d.route=$1 AND d.document_id=$2${lock ? ' FOR UPDATE OF d' : ''}`,
    [route, documentId],
  );
  return result.rows[0] ?? null;
}

function retained(row: LifecycleRow, at: number): boolean {
  return (
    row.purge_started_at === null &&
    !row.purge_completed &&
    (row.deleted_at === null || row.deleted_at.getTime() + RETENTION_MS > at)
  );
}

function lifecycleValue(documentId: string, structureRevisionId: string, row: LifecycleRow): KnowledgeLifecycleValue {
  return {
    documentId,
    notebookId: row.notebook_id,
    structureRevisionId,
    generation: row.lifecycle_generation,
    state: row.deleted_at === null ? 'active' : 'trashed',
    restoreUntil: row.deleted_at === null ? null : new Date(row.deleted_at.getTime() + RETENTION_MS).toISOString(),
  };
}

/** Metadata-only recovery after a reload. Trashed documents disclose no title, revision or body here. */
export async function readKnowledgeLifecycle(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  documentId: string,
  context: KnowledgeReadContext,
) {
  const route = routeOf(documentId);
  if (
    route === null ||
    context.actor.kind !== 'account' ||
    context.actor.accountId !== accountId ||
    routeOf(accountId) !== route ||
    routeOf(notebookId) !== route
  )
    throw new KnowledgeNotFoundError();
  const check = await accessCheck(
    deps.access,
    context.actor,
    'account:read',
    { route, id: accountId },
    { pool: deps.pool, deadline: context.deadline },
  );
  const result = await snapshot(deps, documentId, context, async (tx) => {
    if (!(await check(tx as AccessClient))) return null;
    const notebook = await tx.query<{ owner_account_id: string; structure_revision_id: string }>(
      `SELECT owner_account_id,structure_revision_id FROM content.knowledge_notebook WHERE route=$1 AND notebook_id=$2`,
      [route, notebookId],
    );
    const owner = notebook.rows[0];
    if (!owner || owner.owner_account_id !== accountId) return null;
    const row = await lifecycleRow(tx, route, documentId);
    if (!row || row.notebook_id !== notebookId || !retained(row, deps.clock().getTime())) return null;
    await requireKnowledgeDocumentEligible(tx, route, documentId, true);
    return lifecycleValue(documentId, owner.structure_revision_id, row);
  });
  if (!result.value) throw new KnowledgeNotFoundError();
  return { value: result.value, anchors: [result.anchor] };
}

/** Leaf-only admission is deliberate: a subtree needs durable traversal and cannot report completion here. */
export async function changeKnowledgeLifecycle(
  deps: KnowledgeDependencies,
  actor: Actor,
  documentId: string,
  action: 'trash' | 'restore',
  input: KnowledgeLifecycleInput,
  context: KnowledgeCommandContext,
) {
  const owner = await knowledgeOwner(deps.pool, documentId);
  if (!owner || actor.kind !== 'account' || actor.accountId !== owner.owner_account_id)
    throw new KnowledgeNotFoundError();
  const route = owner.route;
  const check = await accessCheck(
    deps.access,
    actor,
    'account:update',
    { route, id: owner.owner_account_id },
    { pool: deps.pool, deadline: context.deadline },
  );
  // authorize precedes receipt lookup on every attempt, including successful replays. Current ownership,
  // retained data, and ancestor eligibility can never be bypassed with an earlier receipt.
  let current: LifecycleRow;
  let structureRevisionId: string;
  const authorization: CommandAuthorization = {
    action: 'account:update',
    resource: { route, id: owner.owner_account_id },
    async authorize(tx, attempt) {
      if (!(await check(tx as AccessClient))) throw new ContentForbiddenError();
      structureRevisionId = await lockKnowledgeNotebook(tx, route, owner.notebook_id, actor.accountId);
      const row = await lifecycleRow(tx, route, documentId, true);
      if (
        !row ||
        row.notebook_id !== owner.notebook_id ||
        !retained(row, Date.parse(authoritativeTimeValue(attempt.time)))
      )
        throw new KnowledgeNotFoundError();
      await requireKnowledgeDocumentEligible(tx, route, documentId, true);
      current = row;
      return 'execute';
    },
    denied: () => new ContentForbiddenError(),
  };
  const kind = `content.knowledge.document.${action}`;
  return runCommand<KnowledgeLifecycleResult>(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      authorization,
      receipt: { kind, key: context.idempotencyKey, digest: requestDigest(kind, actor, { documentId, input }) },
    },
    async (tx, { time }) => {
      if (
        structureRevisionId !== input.expectedStructureRevisionId ||
        current.lifecycle_generation !== input.expectedGeneration ||
        (action === 'trash' ? current.deleted_at !== null : current.deleted_at === null)
      )
        throw new RevisionPreconditionError();
      const child = await tx.query(
        `SELECT placement_id FROM content.knowledge_placement
       WHERE route=$1 AND notebook_id=$2 AND parent_id=$3 LIMIT 1`,
        [route, owner.notebook_id, current.placement_id],
      );
      if (child.rowCount)
        return noEffect({
          ...lifecycleValue(documentId, structureRevisionId, current),
          complete: false,
          reason: 'subtree_work_required',
        });
      // The notebook lock orders this point update with moves, revisions and lifecycle work. The keyed
      // predicates are also the contract for a future purge writer: purge/expiry must win this same fence.
      const changed = await tx.query<{ lifecycle_generation: string; deleted_at: Date | null }>(
        `UPDATE content.knowledge_document SET deleted_at=$4::timestamptz,
         lifecycle_generation=lifecycle_generation+1,current_publication_id=NULL
       WHERE route=$1 AND document_id=$2 AND lifecycle_generation=$3::bigint
         AND purge_started_at IS NULL AND NOT purge_completed
         AND (deleted_at IS NULL OR deleted_at>$5::timestamptz-interval '30 days')
       RETURNING lifecycle_generation::text,deleted_at`,
        [
          route,
          documentId,
          input.expectedGeneration,
          action === 'trash' ? authoritativeTimeValue(time) : null,
          authoritativeTimeValue(time),
        ],
      );
      const row = changed.rows[0];
      if (!row) throw new KnowledgeNotFoundError();
      const value: KnowledgeLifecycleResult = {
        ...lifecycleValue(documentId, structureRevisionId, { ...current, ...row }),
        complete: true,
        reason: null,
      };
      const events: { type: string; subject: string; data: unknown }[] = [
        {
          type: 'com.rezics.content.knowledge.lifecycle.changed.v1',
          subject: documentId,
          data: { documentId, notebookId: owner.notebook_id, generation: value.generation, action },
        },
      ];
      if (current.current_publication_id !== null) {
        const publication = await tx.query<{ revision_id: string; subject_id: string }>(
          `SELECT revision_id,subject_id FROM content.knowledge_publication
         WHERE route=$1 AND document_id=$2 AND publication_id=$3`,
          [route, documentId, current.current_publication_id],
        );
        const selected = publication.rows[0]!;
        events.push({
          type: 'com.rezics.content.knowledge.publication.changed.v1',
          subject: documentId,
          data: {
            action: 'withdrawn',
            documentId,
            publicationId: current.current_publication_id,
            revisionId: selected.revision_id,
            subjectId: selected.subject_id,
          },
        });
      }
      return { value, events };
    },
  );
}
