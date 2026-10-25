import type { Pool } from 'pg';
import canonicalize from 'canonicalize';
import { within, deadlineClient } from '../access/authenticate.ts';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import type { Access } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { runAuthorErasure, type NativeDurableStep } from './erasure-workflow.ts';
import { processImportedMedia } from './media-import-job.ts';
import type { MediaImportFetchConfig } from './media-import.ts';
import type {
  NativeAuthorErasureWorkflows,
  NativeWorkflowStatus,
  OperationProgress,
  OperationResponse,
} from './operation-contract.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Value } from 'typebox/value';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import { WORK_APPLICATION, type WorkClient } from '../work/client.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import { clearErasedPostRevisions } from './erased-post-cleanup.ts';
import { CONTENT_EVENTS } from './events.ts';
import { createImageJob } from './image-job.ts';
import { createCollectionJob } from './collection-job.ts';
import { refreshBoardRankBatch } from './board-rank.ts';
import { createErasureJob } from './erasure-job.ts';
import { createReactionCountEffect } from './reaction-projection.ts';
import type { MediaStorage } from './media-storage.ts';
import {
  CONTENT_QUEUES,
  CONTENT_WORKFLOWS,
  contentWorkWorkflowId,
  type ContentWorkInput,
  type AuthorEraseWorkInput,
} from './work-contract.ts';

export const CONTENT_OPERATION_PROGRESS = 'content.authorErasure.progress';
export const CONTENT_COLLECTION_SCHEDULE = 'content.collection.hourly';
export const CONTENT_BOARD_RANK_SCHEDULE = 'content.board-rank.every-10-minutes';
const PARTITION_WORKFLOW = 'content.collect.partition';
const BOARD_RANK_WORKFLOW = 'content.board-rank.refresh';
const BATCH_SIZE = 100;
const PARTITION_CONCURRENCY = 8;
const RETRY = { retriesAllowed: true, intervalSeconds: 1, backoffRate: 1, maxAttempts: 100 } as const;

type ContentWorkOptions = Readonly<{
  storage: MediaStorage;
  access: Access;
  readConsent: CurrentConsentReader;
  routeKey: Uint8Array;
  fetchConfig: MediaImportFetchConfig;
  /** Trusted operational fixture only. Production always enumerates all fixed partition numbers. */
  collectionPartitions?: readonly number[];
}>;

function validateInput(input: ContentWorkInput): void {
  const route = routeOf(input.mediaId);
  const source = input.source;
  if (
    route === null ||
    !source ||
    partitionOf(route) !== source.partition ||
    !Number.isSafeInteger(source.epoch) ||
    source.epoch < 1 ||
    source.epoch > 2147483647 ||
    !Number.isSafeInteger(source.eventIndex) ||
    source.eventIndex < 0 ||
    source.eventIndex >= 1000 ||
    !/^[1-9][0-9]{0,18}$/.test(source.position) ||
    BigInt(source.position) > 9_223_372_036_854_775_807n
  )
    throw new TypeError('Invalid content work source');
}

/** Registers into the shared kernel runtime; owns neither queues nor process resources. */
export function createContentWork(options: ContentWorkOptions): WorkModule {
  const partitions =
    options.collectionPartitions === undefined
      ? Array.from({ length: PARTITIONS }, (_, partition) => partition)
      : [...options.collectionPartitions];
  if (
    partitions.length === 0 ||
    new Set(partitions).size !== partitions.length ||
    partitions.some((partition) => !Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
  )
    throw new RangeError('Invalid content collection partitions');
  return { name: 'content', register: (context) => registerWork(context, options, partitions) };
}

async function registerWork(
  context: WorkContext,
  options: ContentWorkOptions,
  partitions: readonly number[],
): Promise<void> {
  const { storage } = options;
  for (const queue of Object.values(CONTENT_QUEUES)) {
    if (!(queue in context.queues)) throw new Error('Content requires shared kernel queues');
  }
  const purge = DBOS.registerStep(
    async (input: ContentWorkInput) => {
      validateInput(input);
      return createErasureJob(context.pool, storage).purgeObject(input.mediaId);
    },
    { name: 'content.purge.step', ...RETRY },
  );
  DBOS.registerWorkflow(async (input: ContentWorkInput) => purge(input), { name: CONTENT_WORKFLOWS.purge });

  function rejectionStorage(input: ContentWorkInput): MediaStorage {
    // The production image job commits rejection before requesting cleanup. Route
    // that cleanup through the independent governance queue, including on replay.
    const imageStorage: MediaStorage = {
      get: (key) => storage.get(key),
      put: (key, bytes, metadata) => storage.put(key, bytes, metadata),
      async deletePrefix(prefix) {
        if (prefix !== `m/${input.mediaId}/`) throw new Error('Invalid rejected image prefix');
        const workflowID = contentWorkWorkflowId(
          { ...input.source, position: BigInt(input.source.position) },
          input.source.eventIndex,
          'purge',
          input.mediaId,
        );
        const cleanup = await context.client.enqueue(
          { workflowName: CONTENT_WORKFLOWS.purge, queueName: CONTENT_QUEUES.purge, workflowID },
          input,
        );
        await cleanup.getResult();
      },
    };
    return imageStorage;
  }
  const image = DBOS.registerStep(
    async (input: ContentWorkInput) => {
      validateInput(input);
      const imageStorage = rejectionStorage(input);
      return createImageJob(context.pool, imageStorage).process(input.mediaId);
    },
    { name: 'content.image.step', ...RETRY },
  );
  DBOS.registerWorkflow(async (input: ContentWorkInput) => image(input), { name: CONTENT_WORKFLOWS.image });

  const imported = DBOS.registerStep(
    async (input: ContentWorkInput) => {
      validateInput(input);
      return processImportedMedia(
        {
          pool: context.pool,
          access: options.access,
          routeKey: options.routeKey,
          clock: context.clock,
          fetchConfig: options.fetchConfig,
          storage: rejectionStorage(input),
        },
        input.mediaId,
      );
    },
    { name: 'content.import.step', ...RETRY },
  );
  DBOS.registerWorkflow(async (input: ContentWorkInput) => imported(input), { name: CONTENT_WORKFLOWS.importFromUrl });

  // Register one retrying SDK step. The production orchestrator supplies its
  // deterministic bounded actions; DBOS records each invocation in native order.
  const authorStep = DBOS.registerStep(async (_name: string, action: () => Promise<unknown>) => action(), {
    name: 'content.authorErase.step',
    ...RETRY,
    shouldRetry: (error) => !(error instanceof Error && error.name === 'ErasurePermissionDenied'),
  });
  const durableStep: NativeDurableStep = <T>(name: string, action: () => Promise<T>) =>
    authorStep(name, action) as Promise<T>;
  DBOS.registerWorkflow(
    async (input: AuthorEraseWorkInput) => {
      validateInput({ mediaId: input.operationId, source: input.source });
      return runAuthorErasure(
        {
          pool: context.pool,
          access: options.access,
          readConsent: options.readConsent,
          currentTime: context.clock,
          durableStep,
          erasureJob: createErasureJob(context.pool, storage),
          checkpoint: {
            read: () => DBOS.getEvent<OperationProgress>(DBOS.workflowID!, CONTENT_OPERATION_PROGRESS, 0),
            write: (_id, progress) => DBOS.setEvent(CONTENT_OPERATION_PROGRESS, progress),
          },
        },
        input.operationId,
      );
    },
    { name: CONTENT_WORKFLOWS.authorErase },
  );

  const collect = DBOS.registerStep(
    async (partition: number) => {
      const outcome = await createCollectionJob(context.pool, storage, { clock: context.clock }).collectPartition(
        partition,
        BATCH_SIZE,
      );
      // A stalled pending fence remains retryable native work; no custom checkpoint.
      if (!outcome.complete && outcome.examined === 0) throw new Error('Content collection has pending work');
      return outcome;
    },
    { name: 'content.collect.step', ...RETRY },
  );
  const drain = DBOS.registerWorkflow(
    async (partition: number) => {
      if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
        throw new RangeError('Invalid collection partition');
      // Each bounded batch is its own durable step, so recovery replays progress.
      while (!(await collect(partition)).complete) {
        /* Drain actual changed rows only. */
      }
    },
    { name: PARTITION_WORKFLOW },
  );
  DBOS.registerWorkflow(
    async (_scheduledDate: Date, _context: unknown) => {
      // The scheduled timestamp never supplies a command cutoff. The job obtains T.
      const sweep = DBOS.workflowID!;
      // A maintenance slot stays occupied until all children complete. Queuing
      // children behind their parents would deadlock when two sweeps overlap.
      for (let offset = 0; offset < partitions.length; offset += PARTITION_CONCURRENCY) {
        const handles = await Promise.all(
          partitions.slice(offset, offset + PARTITION_CONCURRENCY).map((partition) =>
            DBOS.startWorkflow(drain, {
              workflowID: `${sweep}:partition:${partition}`,
            })(partition),
          ),
        );
        await Promise.all(handles.map((handle) => handle.getResult()));
      }
    },
    { name: CONTENT_WORKFLOWS.collect },
  );
  const refreshRanks = DBOS.registerStep(async () => refreshBoardRankBatch(context.pool, context.clock()), {
    name: 'content.board-rank.refresh.step',
    ...RETRY,
  });
  DBOS.registerWorkflow(async (_scheduledDate: Date, _context: unknown) => refreshRanks(), {
    name: BOARD_RANK_WORKFLOW,
  });
  // Client schedule provisioning works before launch. SDK applySchedules upserts
  // this stable name and preserves a single persistent schedule across restarts.
  await context.client.applySchedules([
    {
      scheduleName: CONTENT_COLLECTION_SCHEDULE,
      workflowName: CONTENT_WORKFLOWS.collect,
      schedule: '0 * * * *',
      queueName: CONTENT_QUEUES.collect,
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
    {
      scheduleName: CONTENT_BOARD_RANK_SCHEDULE,
      workflowName: BOARD_RANK_WORKFLOW,
      schedule: '*/10 * * * *',
      queueName: CONTENT_QUEUES.collect,
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);

  // The erased-post event carries only identity. The committed tombstone is the
  // authority, so a retry or a new event id reads it again and leaves erased rows unchanged.
  const erasedPostEvent = 'com.rezics.content.post.erased.v1' as const;
  const clearErasedPost = DBOS.registerStep(
    async (postId: string) => clearErasedPostRevisions(context.pool, { postId }, Date.now() + 120_000),
    { name: 'content.erasePostRevisions.step', ...RETRY },
  );
  DBOS.registerWorkflow(async (postId: string) => clearErasedPost(postId), { name: 'content.erasePostRevisions' });
  context.addEffects([
    {
      name: 'content_post_erased',
      types: [erasedPostEvent],
      async run(event) {
        if (event.type !== erasedPostEvent || !Value.Check(CONTENT_EVENTS[erasedPostEvent], event.data))
          throw new TypeError('Invalid erased post event');
        await context.client.enqueue(
          {
            applicationName: WORK_APPLICATION,
            workflowName: 'content.erasePostRevisions',
            queueName: 'governance',
            workflowID: `content.erasePost:${event.id}`,
            workflowIDReusePolicy: 'return-existing',
          },
          (event.data as { postId: string }).postId,
        );
      },
    },
  ]);
  // Registered with the board effect by the content work module. The shared
  // effects relay delivers each change after the source read has been released.
  context.addEffects([createReactionCountEffect(context.pool)]);
}

function counters(value: unknown, steps: boolean): OperationProgress {
  const row = value as OperationProgress | undefined;
  const fields = steps
    ? (['processedPosts', 'erasedRevisions', 'steps'] as const)
    : (['processedPosts', 'erasedRevisions'] as const);
  if (!row || fields.some((key) => !Number.isSafeInteger(row[key]) || row[key] < 0))
    throw new Error('Invalid native content progress');
  return { processedPosts: row.processedPosts, erasedRevisions: row.erasedRevisions, steps: steps ? row.steps : 0 };
}

/** Enqueue/status adapter only. A committed, bound operation supplies all work
 * authority; the supplied actor is compared with its immutable initiating scope
 * and is never forwarded to a job. Accounts restores authority for each action.
 * Pool, SDK client and trusted clock remain owned by the host.
 */
export function createContentOperationClient({
  pool,
  client,
  clock,
}: {
  pool: Pool;
  client: WorkClient;
  clock: KernelClock;
}): NativeAuthorErasureWorkflows {
  return {
    async enqueue(input, context) {
      const route = routeOf(input.operationId);
      if (route === null || input.actor.kind !== 'account' || !Number.isFinite(clock().getTime()))
        throw new Error('Content operation is unavailable');
      const row = await within(context.deadline, () =>
        withConnection(pool, async (connection) => {
          const tx = deadlineClient(connection, context.deadline);
          await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const anchor = await readPartition(tx, partitionOf(route));
            if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition is unavailable');
            const { rows } = await tx.query<{
              thread_id: string;
              author_account_id: string;
              initiator_account_id: string;
              actor_client_id: string;
              actor_requested_by: string | null;
              actor_authn_epoch: string;
              actor_scopes: string[];
              native_workflow_id: string | null;
              source_epoch: number;
              source_partition: number;
              source_position: string;
              source_event_index: number;
            }>(
              `SELECT o.thread_id,o.author_account_id,o.initiator_account_id,o.actor_client_id,
              o.actor_requested_by,o.actor_authn_epoch,o.actor_scopes,o.native_workflow_id,
              o.source_epoch,o.source_partition,o.source_position::text,o.source_event_index
            FROM content.operation o
            JOIN core.receipt r ON r.partition_no=$3 AND r.principal_kind='account'
              AND r.principal_id=o.initiator_account_id AND r.command_kind=o.creation_command_kind
              AND r.idempotency_key=o.creation_idempotency_key AND r.transaction_id=o.recorded_transaction_id
              AND encode(r.request_digest,'hex')=o.creation_request_digest
              AND r.response->>'operationId'=o.operation_id::text
              AND r.response->>'durableInitiator' ~ '^[0-9a-f]{64}$'
            WHERE o.route=$1 AND o.operation_id=$2`,
              [route, input.operationId, partitionOf(route)],
            );
            await tx.query('COMMIT');
            return rows[0];
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          }
        }),
      );
      if (
        !row?.native_workflow_id ||
        row.thread_id !== input.threadId ||
        row.author_account_id !== input.authorId ||
        row.initiator_account_id !== input.actor.accountId ||
        row.actor_client_id !== input.actor.clientId ||
        row.actor_requested_by !== input.actor.requestedBy ||
        Number(row.actor_authn_epoch) !== input.actor.authnEpoch ||
        canonicalize([...row.actor_scopes].sort()) !== canonicalize([...input.actor.scopes].sort())
      )
        throw new Error('Content operation is unavailable');
      const source = {
        epoch: row.source_epoch,
        partition: row.source_partition,
        position: row.source_position,
        eventIndex: row.source_event_index,
      };
      validateInput({ mediaId: input.operationId, source });
      const workflowID = contentWorkWorkflowId(
        { ...source, position: BigInt(source.position) },
        source.eventIndex,
        'authorErase',
        input.operationId,
      );
      if (workflowID !== row.native_workflow_id) throw new Error('Content operation is unavailable');
      // The source read transaction has released its connection before enqueue.
      await within(context.deadline, () =>
        client.enqueue(
          {
            workflowName: CONTENT_WORKFLOWS.authorErase,
            queueName: CONTENT_QUEUES.authorErase,
            workflowID,
            workflowIDReusePolicy: 'return-existing',
          },
          { operationId: input.operationId, source },
        ),
      );
    },
    async status(workflowID, context): Promise<NativeWorkflowStatus | null> {
      return within(context.deadline, async () => {
        const workflow = await client.getWorkflow(workflowID);
        if (!workflow || workflow.workflowName !== CONTENT_WORKFLOWS.authorErase) return null;
        const event = await client.getEvent<OperationProgress>(workflowID, CONTENT_OPERATION_PROGRESS, 0);
        const progress = event === null ? { processedPosts: 0, erasedRevisions: 0, steps: 0 } : counters(event, true);
        if (workflow.status === 'SUCCESS') {
          const { processedPosts, erasedRevisions } = counters(workflow.output, false);
          const response: OperationResponse = { processedPosts, erasedRevisions };
          return { done: true, progress, response };
        }
        if (['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(workflow.status)) {
          const error = workflow.error;
          const permission = error instanceof Error && error.name === 'ErasurePermissionDenied';
          return {
            done: true,
            progress,
            error: permission ? { code: 7, message: 'Permission denied' } : { code: 13, message: 'Internal error' },
          };
        }
        return { done: false, progress };
      });
    },
  };
}
