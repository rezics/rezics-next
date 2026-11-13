import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
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
import { WORK_APPLICATION, type WorkClient } from '../work/client.ts';
import type { WorkContext } from '../work/registry.ts';
import type { Access, AccessClient, AccountActor } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { accessCheck } from './access-port.ts';
import { ContentForbiddenError } from './commands.ts';
import { lockKnowledgeNotebook, requireKnowledgeDocumentEligible } from './knowledge-eligibility.ts';
import { contentStepRetryOptions } from './work.ts';

export const KNOWLEDGE_LIFECYCLE_RESTORE_WORKFLOW = 'content.knowledge.restore';
export const KNOWLEDGE_LIFECYCLE_RESTORE_STEP = 'content.knowledge.restore.page';
const RESTORE_PAGE_SIZE = 64;
const RESTORE_PAGES_PER_WORKFLOW = 16;
const RESTORE_PAGE_DEADLINE_MS = 30_000;
const LIFECYCLE_CHANGED = 'com.rezics.content.knowledge.lifecycle.changed.v1';
const PUBLICATION_CHANGED = 'com.rezics.content.knowledge.publication.changed.v1';

type RestoreOperation = Readonly<{
  route: number;
  notebook_id: string;
  root_document_id: string;
  operation_id: string;
  owner_account_id: string;
  actor_client_id: string | null;
  actor_scopes: string[] | null;
  actor_requested_by: string | null;
  actor_authn_epoch: number | null;
  root_generation: string;
  restore_until: Date;
  state: 'running' | 'complete' | 'expired' | 'purged' | 'superseded';
  processed_documents: string;
  pending_placements: string;
  page_number: string;
}>;
type RestorePageResult = Readonly<{
  state: RestoreOperation['state'] | 'missing';
  complete: boolean;
  pageNumber: string;
  processedDocuments: string;
  pendingPlacements: string;
}>;
type RestoreFrontier = Readonly<{
  parent_placement_id: string;
  after_position: string | null;
  after_placement_id: string | null;
}>;
type RestoreChild = Readonly<{
  placement_id: string;
  position: string;
  document_id: string;
  lifecycle_generation: string;
  deleted_at: Date | null;
  purge_started_at: Date | null;
  purge_completed: boolean;
  current_publication_id: string | null;
  revision_id: string | null;
  subject_id: string | null;
}>;
type RestoreDocument = Readonly<{
  lifecycle_generation: string;
  deleted_at: Date | null;
  purge_started_at: Date | null;
  purge_completed: boolean;
  current_publication_id: string | null;
  placement_id: string;
}>;

function restorePageResult(
  operation: Pick<RestoreOperation, 'state' | 'page_number' | 'processed_documents' | 'pending_placements'>,
): RestorePageResult {
  return {
    state: operation.state,
    complete: operation.state !== 'running',
    pageNumber: operation.page_number,
    processedDocuments: operation.processed_documents,
    pendingPlacements: operation.pending_placements,
  };
}

function restoreActor(operation: RestoreOperation): AccountActor {
  return {
    kind: 'account',
    accountId: operation.owner_account_id,
    clientId: operation.actor_client_id!,
    scopes: operation.actor_scopes!,
    requestedBy: operation.actor_requested_by,
    authnEpoch: operation.actor_authn_epoch!,
  };
}

async function readRestoreOperation(pool: Pool, operationId: string): Promise<RestoreOperation | null> {
  const result = await pool.query<RestoreOperation>(
    `SELECT route,notebook_id,root_document_id,operation_id,owner_account_id,
            actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,
            root_generation::text,restore_until,state,processed_documents::text,
            pending_placements::text,page_number::text
     FROM content.knowledge_lifecycle_restore WHERE operation_id=$1`,
    [operationId],
  );
  return result.rows[0] ?? null;
}

async function lockedRestoreOperation(tx: CommandTransaction, operationId: string): Promise<RestoreOperation | null> {
  const result = await tx.query<RestoreOperation>(
    `SELECT route,notebook_id,root_document_id,operation_id,owner_account_id,
            actor_client_id,actor_scopes,actor_requested_by,actor_authn_epoch,
            root_generation::text,restore_until,state,processed_documents::text,
            pending_placements::text,page_number::text
     FROM content.knowledge_lifecycle_restore WHERE operation_id=$1 FOR UPDATE`,
    [operationId],
  );
  return result.rows[0] ?? null;
}

async function restoreDocument(
  tx: CommandTransaction,
  route: number,
  notebookId: string,
  documentId: string,
): Promise<RestoreDocument | null> {
  const result = await tx.query<RestoreDocument>(
    `SELECT d.lifecycle_generation::text,d.deleted_at,d.purge_started_at,d.purge_completed,
            d.current_publication_id,p.placement_id
     FROM content.knowledge_document d
     JOIN content.knowledge_placement p
       ON p.route=d.route AND p.notebook_id=d.notebook_id AND p.document_id=d.document_id
     WHERE d.route=$1 AND d.notebook_id=$2 AND d.document_id=$3
     FOR UPDATE OF d`,
    [route, notebookId, documentId],
  );
  return result.rows[0] ?? null;
}

function lifecycleEvent(documentId: string, notebookId: string, generation: string, action: 'restore') {
  return {
    type: LIFECYCLE_CHANGED,
    subject: documentId,
    data: { documentId, notebookId, generation, action },
  };
}

function publicationWithdrawal(child: RestoreChild) {
  return child.current_publication_id === null
    ? null
    : {
        type: PUBLICATION_CHANGED,
        subject: child.document_id,
        data: {
          action: 'withdrawn',
          documentId: child.document_id,
          publicationId: child.current_publication_id,
          revisionId: child.revision_id!,
          subjectId: child.subject_id!,
        },
      };
}

/** Execute one bounded native command page; all traversal state lives in Content rows. */
export async function advanceKnowledgeLifecycleRestorePage(
  pool: Pool,
  access: Access,
  operationId: string,
  clock: KernelClock,
): Promise<RestorePageResult> {
  const operation = await readRestoreOperation(pool, operationId);
  if (!operation) {
    return {
      state: 'missing',
      complete: true,
      pageNumber: '0',
      processedDocuments: '0',
      pendingPlacements: '0',
    };
  }
  if (operation.state !== 'running') return restorePageResult(operation);

  const actor = restoreActor(operation);
  const deadline = Date.now() + RESTORE_PAGE_DEADLINE_MS;
  const check = await accessCheck(
    access,
    actor,
    'account:update',
    { route: operation.route, id: operation.owner_account_id },
    { pool, deadline },
  );
  const kind = 'content.knowledge.lifecycle.restore.page';
  const expectedPage = operation.page_number;
  const authorization: CommandAuthorization = {
    action: 'account:update',
    resource: { route: operation.route, id: operation.owner_account_id },
    async authorize(tx) {
      if (!(await check(tx as AccessClient))) throw new ContentForbiddenError();
      await lockKnowledgeNotebook(tx, operation.route, operation.notebook_id, operation.owner_account_id);
      const root = await restoreDocument(tx, operation.route, operation.notebook_id, operation.root_document_id);
      const active = await lockedRestoreOperation(tx, operationId);
      if (active?.state === 'running') {
        if (
          root &&
          root.purge_started_at === null &&
          !root.purge_completed &&
          root.lifecycle_generation === active.root_generation
        )
          await requireKnowledgeDocumentEligible(tx, operation.route, operation.root_document_id, true);
      }
      return 'execute';
    },
    denied: () => new ContentForbiddenError(),
  };
  const result = await runCommand<RestorePageResult>(
    pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(operation.route),
      deadline,
      clock,
      authorization,
      receipt: {
        kind,
        key: `knowledge-restore:${operationId}:${expectedPage}`,
        digest: requestDigest(kind, actor, { operationId, pageNumber: expectedPage }),
      },
    },
    async (tx, { time }) => {
      const root = await restoreDocument(tx, operation.route, operation.notebook_id, operation.root_document_id);
      const current = await lockedRestoreOperation(tx, operationId);
      if (!current)
        return noEffect({
          state: 'missing',
          complete: true,
          pageNumber: expectedPage,
          processedDocuments: '0',
          pendingPlacements: '0',
        });
      if (current.state !== 'running') return noEffect(restorePageResult(current));
      if (current.page_number !== expectedPage) return noEffect(restorePageResult(current));

      if (!root) {
        await tx.query(
          `UPDATE content.knowledge_lifecycle_restore
           SET state='purged',completed_at=$2::timestamptz,pending_placements=0,
               actor_client_id=NULL,actor_scopes=NULL,actor_requested_by=NULL,actor_authn_epoch=NULL
           WHERE operation_id=$1 AND state='running'`,
          [operationId, authoritativeTimeValue(time)],
        );
        await tx.query(
          `DELETE FROM content.knowledge_lifecycle_frontier
           WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3`,
          [current.route, current.notebook_id, current.root_document_id],
        );
        return {
          value: { ...restorePageResult({ ...current, state: 'purged', pending_placements: '0' }) },
          events: [],
        };
      }
      const instant = Date.parse(authoritativeTimeValue(time));
      if (current.restore_until.getTime() <= instant) {
        await tx.query(
          `UPDATE content.knowledge_lifecycle_restore
           SET state='expired',completed_at=$2::timestamptz,pending_placements=0,
               actor_client_id=NULL,actor_scopes=NULL,actor_requested_by=NULL,actor_authn_epoch=NULL
           WHERE operation_id=$1 AND state='running'`,
          [operationId, authoritativeTimeValue(time)],
        );
        await tx.query(
          `DELETE FROM content.knowledge_lifecycle_frontier
           WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3`,
          [current.route, current.notebook_id, current.root_document_id],
        );
        return { value: restorePageResult({ ...current, state: 'expired', pending_placements: '0' }), events: [] };
      }
      if (root.purge_started_at !== null || root.purge_completed) {
        await tx.query(
          `UPDATE content.knowledge_lifecycle_restore
           SET state='purged',completed_at=$2::timestamptz,pending_placements=0,
               actor_client_id=NULL,actor_scopes=NULL,actor_requested_by=NULL,actor_authn_epoch=NULL
           WHERE operation_id=$1 AND state='running'`,
          [operationId, authoritativeTimeValue(time)],
        );
        await tx.query(
          `DELETE FROM content.knowledge_lifecycle_frontier
           WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3`,
          [current.route, current.notebook_id, current.root_document_id],
        );
        return { value: restorePageResult({ ...current, state: 'purged', pending_placements: '0' }), events: [] };
      }
      if (root.deleted_at === null || root.lifecycle_generation !== current.root_generation) {
        await tx.query(
          `UPDATE content.knowledge_lifecycle_restore
           SET state='superseded',completed_at=$2::timestamptz,pending_placements=0,
               actor_client_id=NULL,actor_scopes=NULL,actor_requested_by=NULL,actor_authn_epoch=NULL
           WHERE operation_id=$1 AND state='running'`,
          [operationId, authoritativeTimeValue(time)],
        );
        await tx.query(
          `DELETE FROM content.knowledge_lifecycle_frontier
           WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3`,
          [current.route, current.notebook_id, current.root_document_id],
        );
        return { value: restorePageResult({ ...current, state: 'superseded', pending_placements: '0' }), events: [] };
      }

      const frontierResult = await tx.query<RestoreFrontier>(
        `SELECT parent_placement_id,after_position::text,after_placement_id
         FROM content.knowledge_lifecycle_frontier
         WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3 AND NOT exhausted
         ORDER BY parent_placement_id LIMIT 1 FOR UPDATE`,
        [current.route, current.notebook_id, current.root_document_id],
      );
      const frontier = frontierResult.rows[0];
      const events: { type: string; subject: string; data: unknown }[] = [];
      let processed = 0;
      let discovered = 0;
      let exhausted = false;

      if (frontier) {
        const children = await tx.query<RestoreChild>(
          `SELECT p.placement_id,p.position::text,p.document_id,
                  d.lifecycle_generation::text,d.deleted_at,d.purge_started_at,d.purge_completed,
                  d.current_publication_id,pub.revision_id,pub.subject_id
           FROM content.knowledge_placement p
           JOIN content.knowledge_document d
             ON d.route=p.route AND d.notebook_id=p.notebook_id AND d.document_id=p.document_id
           LEFT JOIN content.knowledge_publication pub
             ON pub.route=d.route AND pub.document_id=d.document_id
            AND pub.publication_id=d.current_publication_id
           WHERE p.route=$1 AND p.notebook_id=$2 AND p.parent_id=$3
             AND ($4::numeric IS NULL OR (p.position,p.placement_id)>($4::numeric,$5::uuid))
           ORDER BY p.position,p.placement_id LIMIT $6
           FOR UPDATE OF d`,
          [
            current.route,
            current.notebook_id,
            frontier.parent_placement_id,
            frontier.after_position,
            frontier.after_placement_id,
            RESTORE_PAGE_SIZE,
          ],
        );
        const last = children.rows.at(-1);
        exhausted = children.rows.length < RESTORE_PAGE_SIZE;
        for (const child of children.rows) {
          // An independently trashed placement remains its own hidden root. Its descendants wait for
          // that root's explicit restore and are not admitted into this operation's frontier.
          if (child.deleted_at !== null || child.purge_started_at !== null || child.purge_completed) continue;
          const changed = await tx.query<{ lifecycle_generation: string }>(
            `UPDATE content.knowledge_document
             SET lifecycle_generation=lifecycle_generation+1,current_publication_id=NULL
             WHERE route=$1 AND document_id=$2 AND lifecycle_generation=$3::bigint
               AND deleted_at IS NULL AND purge_started_at IS NULL AND NOT purge_completed
             RETURNING lifecycle_generation::text`,
            [current.route, child.document_id, child.lifecycle_generation],
          );
          const generation = changed.rows[0]?.lifecycle_generation;
          if (generation === undefined) continue;
          await tx.query(
            `INSERT INTO content.knowledge_lifecycle_frontier(
               route,notebook_id,root_document_id,parent_placement_id
             ) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [current.route, current.notebook_id, current.root_document_id, child.placement_id],
          );
          discovered++;
          processed++;
          events.push(lifecycleEvent(child.document_id, current.notebook_id, generation, 'restore'));
          const withdrawn = publicationWithdrawal(child);
          if (withdrawn) events.push(withdrawn);
        }
        if (last) {
          await tx.query(
            `UPDATE content.knowledge_lifecycle_frontier
             SET after_position=$5::numeric,after_placement_id=$6::uuid,exhausted=$7
             WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3 AND parent_placement_id=$4`,
            [
              current.route,
              current.notebook_id,
              current.root_document_id,
              frontier.parent_placement_id,
              last.position,
              last.placement_id,
              exhausted,
            ],
          );
        } else {
          // A purge may have removed this frontier's parent placement. Retaining the durable row
          // lets this empty scan retire its pending count instead of stranding the operation.
          exhausted = true;
          await tx.query(
            `UPDATE content.knowledge_lifecycle_frontier SET exhausted=true
             WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3 AND parent_placement_id=$4`,
            [current.route, current.notebook_id, current.root_document_id, frontier.parent_placement_id],
          );
        }
      }

      const nextProcessed = (BigInt(current.processed_documents) + BigInt(processed)).toString();
      const nextPending = BigInt(current.pending_placements) + BigInt(discovered) - (exhausted ? 1n : 0n);
      const nextPage = (BigInt(current.page_number) + 1n).toString();
      await tx.query(
        `UPDATE content.knowledge_lifecycle_restore
         SET processed_documents=$2::bigint,pending_placements=$3::bigint,page_number=$4::bigint
         WHERE operation_id=$1 AND state='running'`,
        [operationId, nextProcessed, nextPending.toString(), nextPage],
      );

      if (nextPending === 0n) {
        const reopened = await tx.query<{ lifecycle_generation: string }>(
          `UPDATE content.knowledge_document
           SET deleted_at=NULL,lifecycle_generation=lifecycle_generation+1,current_publication_id=NULL
           WHERE route=$1 AND document_id=$2 AND lifecycle_generation=$3::bigint
             AND deleted_at IS NOT NULL AND purge_started_at IS NULL AND NOT purge_completed
             AND deleted_at>$4::timestamptz-interval '30 days'
           RETURNING lifecycle_generation::text`,
          [current.route, current.root_document_id, current.root_generation, authoritativeTimeValue(time)],
        );
        const generation = reopened.rows[0]?.lifecycle_generation;
        if (generation !== undefined) {
          await tx.query(
            `UPDATE content.knowledge_lifecycle_restore
             SET state='complete',completed_at=$2::timestamptz,pending_placements=0,
                 actor_client_id=NULL,actor_scopes=NULL,actor_requested_by=NULL,actor_authn_epoch=NULL
             WHERE operation_id=$1 AND state='running'`,
            [operationId, authoritativeTimeValue(time)],
          );
          await tx.query(
            `DELETE FROM content.knowledge_lifecycle_frontier
             WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3`,
            [current.route, current.notebook_id, current.root_document_id],
          );
          events.push(lifecycleEvent(current.root_document_id, current.notebook_id, generation, 'restore'));
          return {
            value: {
              state: 'complete',
              complete: true,
              pageNumber: nextPage,
              processedDocuments: nextProcessed,
              pendingPlacements: '0',
            },
            events,
          };
        }

        const state = current.restore_until.getTime() <= instant ? 'expired' : 'superseded';
        await tx.query(
          `UPDATE content.knowledge_lifecycle_restore
           SET state=$2,completed_at=$3::timestamptz,pending_placements=0,
               actor_client_id=NULL,actor_scopes=NULL,actor_requested_by=NULL,actor_authn_epoch=NULL
           WHERE operation_id=$1 AND state='running'`,
          [operationId, state, authoritativeTimeValue(time)],
        );
        await tx.query(
          `DELETE FROM content.knowledge_lifecycle_frontier
           WHERE route=$1 AND notebook_id=$2 AND root_document_id=$3`,
          [current.route, current.notebook_id, current.root_document_id],
        );
        return {
          value: {
            state,
            complete: true,
            pageNumber: nextPage,
            processedDocuments: nextProcessed,
            pendingPlacements: '0',
          },
          events,
        };
      }

      return {
        value: {
          state: 'running',
          complete: false,
          pageNumber: nextPage,
          processedDocuments: nextProcessed,
          pendingPlacements: nextPending.toString(),
        },
        events,
      };
    },
  );
  return result.value;
}

export function knowledgeLifecycleRestoreWorkflowId(operationId: string, pageNumber: string): string {
  return `${KNOWLEDGE_LIFECYCLE_RESTORE_WORKFLOW}:${operationId}:${pageNumber}`;
}

/** Register bounded restore pages in Content's existing native Work module. */
export function registerKnowledgeLifecycleRestoreWork(context: WorkContext, access: Access): void {
  const advance = DBOS.registerStep(
    async (operationId: string) =>
      advanceKnowledgeLifecycleRestorePage(context.pool, access, operationId, context.clock),
    { name: KNOWLEDGE_LIFECYCLE_RESTORE_STEP, ...contentStepRetryOptions() },
  );
  DBOS.registerWorkflow(
    async (operationId: string) => {
      let result: RestorePageResult = {
        state: 'running',
        complete: false,
        pageNumber: '0',
        processedDocuments: '0',
        pendingPlacements: '1',
      };
      for (let page = 0; page < RESTORE_PAGES_PER_WORKFLOW; page++) {
        result = await advance(operationId);
        if (result.complete) return;
      }
      if (result.state !== 'running') return;
      await context.client.enqueue(
        {
          applicationName: WORK_APPLICATION,
          workflowName: KNOWLEDGE_LIFECYCLE_RESTORE_WORKFLOW,
          queueName: 'maintenance',
          workflowID: knowledgeLifecycleRestoreWorkflowId(operationId, result.pageNumber),
          workflowIDReusePolicy: 'return-existing',
        },
        operationId,
      );
    },
    { name: KNOWLEDGE_LIFECYCLE_RESTORE_WORKFLOW },
  );
}

/** Start a persisted restore from Content's existing outbox relay. */
export function createKnowledgeLifecycleRestoreEffect(pool: Pool, client: WorkClient) {
  return {
    name: 'content_knowledge_lifecycle_restore',
    types: [LIFECYCLE_CHANGED],
    async run(event: { type: string; subject?: string; data: unknown }) {
      const data = event.data as { action: 'trash' | 'restore' };
      if (data.action !== 'restore') return;
      const subject = event.subject!;
      const route = routeOf(subject)!;
      const operation = await pool.query<{ operation_id: string }>(
        `SELECT operation_id FROM content.knowledge_lifecycle_restore
         WHERE route=$1 AND root_document_id=$2 AND state='running'`,
        [route, subject],
      );
      const row = operation.rows[0];
      if (!row) return;
      await client.enqueue(
        {
          applicationName: WORK_APPLICATION,
          workflowName: KNOWLEDGE_LIFECYCLE_RESTORE_WORKFLOW,
          queueName: 'maintenance',
          workflowID: knowledgeLifecycleRestoreWorkflowId(row.operation_id, '0'),
          workflowIDReusePolicy: 'return-existing',
        },
        row.operation_id,
      );
    },
  };
}
