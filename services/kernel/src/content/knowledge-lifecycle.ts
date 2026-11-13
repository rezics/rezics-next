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
export type KnowledgeLifecycleProgress = Readonly<{
  processedDocuments: string;
  pendingPlacements: string;
}>;
export type KnowledgeLifecycleValue = Readonly<{
  documentId: string;
  notebookId: string;
  structureRevisionId: string;
  generation: string;
  state: 'active' | 'trashed';
  restoreUntil: string | null;
  restoreProgress: KnowledgeLifecycleProgress | null;
}>;
export type KnowledgeLifecycleResult = KnowledgeLifecycleValue &
  Readonly<{ complete: boolean; reason: 'restoring' | null }>;

type LifecycleRow = Readonly<{
  notebook_id: string;
  lifecycle_generation: string;
  deleted_at: Date | null;
  purge_started_at: Date | null;
  purge_completed: boolean;
  placement_id: string;
  current_publication_id: string | null;
}>;
type RestoreProgressRow = Readonly<{
  processed_documents: string;
  pending_placements: string;
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

async function restoreProgress(
  tx: CommandTransaction,
  route: number,
  documentId: string,
): Promise<KnowledgeLifecycleProgress | null> {
  const result = await tx.query<RestoreProgressRow>(
    `SELECT processed_documents::text,pending_placements::text
     FROM content.knowledge_lifecycle_restore
     WHERE route=$1 AND root_document_id=$2 AND state='running'`,
    [route, documentId],
  );
  const row = result.rows[0];
  return row ? { processedDocuments: row.processed_documents, pendingPlacements: row.pending_placements } : null;
}

function retained(row: LifecycleRow, at: number): boolean {
  return (
    row.purge_started_at === null &&
    !row.purge_completed &&
    (row.deleted_at === null || row.deleted_at.getTime() + RETENTION_MS > at)
  );
}

function lifecycleValue(
  documentId: string,
  structureRevisionId: string,
  row: LifecycleRow,
  progress: KnowledgeLifecycleProgress | null = null,
): KnowledgeLifecycleValue {
  return {
    documentId,
    notebookId: row.notebook_id,
    structureRevisionId,
    generation: row.lifecycle_generation,
    state: row.deleted_at === null ? 'active' : 'trashed',
    restoreUntil: row.deleted_at === null ? null : new Date(row.deleted_at.getTime() + RETENTION_MS).toISOString(),
    restoreProgress: progress,
  };
}

async function lifecycleEvents(
  tx: CommandTransaction,
  route: number,
  documentId: string,
  notebookId: string,
  generation: string,
  action: 'trash' | 'restore',
  previousPublicationId: string | null,
) {
  const events: { type: string; subject: string; data: unknown }[] = [
    {
      type: 'com.rezics.content.knowledge.lifecycle.changed.v1',
      subject: documentId,
      data: { documentId, notebookId, generation, action },
    },
  ];
  if (previousPublicationId !== null) {
    const publication = await tx.query<{ revision_id: string; subject_id: string }>(
      `SELECT revision_id,subject_id FROM content.knowledge_publication
       WHERE route=$1 AND document_id=$2 AND publication_id=$3`,
      [route, documentId, previousPublicationId],
    );
    const selected = publication.rows[0]!;
    events.push({
      type: 'com.rezics.content.knowledge.publication.changed.v1',
      subject: documentId,
      data: {
        action: 'withdrawn',
        documentId,
        publicationId: previousPublicationId,
        revisionId: selected.revision_id,
        subjectId: selected.subject_id,
      },
    });
  }
  return events;
}

/** Metadata-only recovery after a reload. Trashed documents disclose no title, revision or body. */
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
    return lifecycleValue(documentId, owner.structure_revision_id, row, await restoreProgress(tx, route, documentId));
  });
  if (!result.value) throw new KnowledgeNotFoundError();
  return { value: result.value, anchors: [result.anchor] };
}

/** Trash fences the selected root immediately. Nonleaf restore records a durable bounded traversal. */
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
  // Current ownership and ancestor eligibility are checked before receipt replay on every attempt.
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
      clock: deps.clock,
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

      if (action === 'restore') {
        const existing = await restoreProgress(tx, route, documentId);
        if (existing)
          return noEffect({
            ...lifecycleValue(documentId, structureRevisionId, current, existing),
            complete: false,
            reason: 'restoring',
          });
      }

      const children =
        action === 'restore'
          ? await tx.query<{ placement_id: string }>(
              `SELECT placement_id FROM content.knowledge_placement
               WHERE route=$1 AND notebook_id=$2 AND parent_id=$3 LIMIT 1`,
              [route, owner.notebook_id, current.placement_id],
            )
          : null;
      const asyncRestore = action === 'restore' && Boolean(children?.rowCount);

      const updated = await tx.query<{ lifecycle_generation: string; deleted_at: Date | null }>(
        `UPDATE content.knowledge_document SET
           deleted_at=$4::timestamptz,
           lifecycle_generation=lifecycle_generation+1,
           current_publication_id=NULL
         WHERE route=$1 AND document_id=$2 AND lifecycle_generation=$3::bigint
           AND purge_started_at IS NULL AND NOT purge_completed
           AND (deleted_at IS NULL OR deleted_at>$5::timestamptz-interval '30 days')
         RETURNING lifecycle_generation::text,deleted_at`,
        [
          route,
          documentId,
          input.expectedGeneration,
          action === 'trash' ? authoritativeTimeValue(time) : asyncRestore ? current.deleted_at : null,
          authoritativeTimeValue(time),
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new KnowledgeNotFoundError();
      const changed: LifecycleRow = { ...current, ...row, current_publication_id: null };
      let progress: KnowledgeLifecycleProgress | null = null;
      let complete = true;

      if (asyncRestore) {
        if (children?.rowCount) {
          await tx.query(
            `DELETE FROM content.knowledge_lifecycle_frontier
             WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3`,
            [route, owner.notebook_id, documentId],
          );
          await tx.query(
            `INSERT INTO content.knowledge_lifecycle_restore(
               route,notebook_id,root_document_id,owner_account_id,
               actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,
               root_generation,restore_until,state,processed_documents,pending_placements,page_number,started_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10::timestamptz,'running',0,1,0,$11::timestamptz
             )
             ON CONFLICT (route,root_document_id) DO UPDATE SET
               notebook_id=EXCLUDED.notebook_id,
               owner_account_id=EXCLUDED.owner_account_id,
               actor_client_id=EXCLUDED.actor_client_id,
               actor_scopes=EXCLUDED.actor_scopes,
               actor_requested_by=EXCLUDED.actor_requested_by,
               actor_authn_epoch=EXCLUDED.actor_authn_epoch,
               root_generation=EXCLUDED.root_generation,
               restore_until=EXCLUDED.restore_until,
               state='running',processed_documents=0,pending_placements=1,page_number=0,
               started_at=EXCLUDED.started_at,completed_at=NULL
             RETURNING operation_id`,
            [
              route,
              owner.notebook_id,
              documentId,
              owner.owner_account_id,
              actor.clientId,
              actor.scopes,
              actor.requestedBy,
              actor.authnEpoch,
              row.lifecycle_generation,
              new Date(current.deleted_at!.getTime() + RETENTION_MS).toISOString(),
              authoritativeTimeValue(time),
            ],
          );
          await tx.query(
            `INSERT INTO content.knowledge_lifecycle_frontier(
               route,notebook_id,root_document_id,parent_placement_id
             ) VALUES ($1,$2,$3,$4)`,
            [route, owner.notebook_id, documentId, current.placement_id],
          );
          progress = { processedDocuments: '0', pendingPlacements: '1' };
          complete = false;
        }
      }

      const value: KnowledgeLifecycleResult = {
        ...lifecycleValue(documentId, structureRevisionId, changed, progress),
        complete,
        reason: complete ? null : 'restoring',
      };
      const events = await lifecycleEvents(
        tx,
        route,
        documentId,
        owner.notebook_id,
        value.generation,
        action,
        current.current_publication_id,
      );
      return { value, events };
    },
  );
}
