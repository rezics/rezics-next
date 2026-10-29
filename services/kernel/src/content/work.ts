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
import { purgeDeletedPostPage } from './deleted-post-purge.ts';
import { clearErasedPostRevisions } from './erased-post-cleanup.ts';
import readOperationEnqueue from './read-operation-enqueue.sql';
import readOperationEnqueueReceipt from './read-operation-enqueue-receipt.sql';
import { CONTENT_EVENTS } from './events.ts';
import { createImageJob } from './image-job.ts';
import { createCollectionJob } from './collection-job.ts';
import { refreshBoardRankBatch } from './board-rank.ts';
import { createErasureJob } from './erasure-job.ts';
import { createReactionCountEffect } from './reaction-projection.ts';
import { createPartyLocatorEffect } from './party-locator.ts';
import { createAuthorItemEffect } from './author-item-index.ts';
import { createReportLocatorEffect } from './report-locator.ts';
import { createSubjectThreadEffect } from './subject-thread-index.ts';
import { processSubjectReactionMergePage, runSubjectReactionMerge } from './subject-reaction-merge.ts';
import { deleteExpiredNoticesPage, NOTICE_PAGE_SIZE, NOTICE_RETENTION_MS } from './notices.ts';
import type { MediaStorage } from './media-storage.ts';
import {
  CONTENT_QUEUES,
  CONTENT_WORKFLOWS,
  contentWorkWorkflowId,
  type ContentWorkInput,
  type AuthorEraseWorkInput,
  type SubjectReactionMergeWorkInput,
} from './work-contract.ts';

export const CONTENT_OPERATION_PROGRESS = 'content.authorErasure.progress';
export const CONTENT_COLLECTION_SCHEDULE = 'content.collection.hourly';
export const CONTENT_BOARD_RANK_SCHEDULE = 'content.board-rank.every-10-minutes';
export const CONTENT_NOTICE_RETENTION_SCHEDULE = 'content.notice-retention.hourly';
const PARTITION_WORKFLOW = 'content.collect.partition';
const BOARD_RANK_WORKFLOW = 'content.board-rank.refresh';
const NOTICE_RETENTION_WORKFLOW = 'content.notice-retention';
const NOTICE_RETENTION_PARTITION_WORKFLOW = 'content.notice-retention.partition';
const BATCH_SIZE = 100;
const PARTITION_CONCURRENCY = 8;
const STEP_RETRY_DELAY_SECONDS = 1;

/** DBOS retries count attempts, so eleven attempts provide ten exponentially growing waits. */
export function contentStepRetryOptions(intervalSeconds = STEP_RETRY_DELAY_SECONDS) {
  return {
    retriesAllowed: true,
    intervalSeconds,
    backoffRate: 2,
    maxAttempts: 11,
  } as const;
}

type ContentWorkOptions = Readonly<{
  storage: MediaStorage;
  access: Access;
  readConsent: CurrentConsentReader;
  routeKey: Uint8Array;
  fetchConfig: MediaImportFetchConfig;
  /** Trusted operational fixture only. Production always enumerates all fixed partition numbers. */
  collectionPartitions?: readonly number[];
  /** Delay between attempts of a failed durable step. Production keeps one second; a test may pass a shorter one. */
  stepRetryDelaySeconds?: number;
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
  const retryDelay = options.stepRetryDelaySeconds ?? STEP_RETRY_DELAY_SECONDS;
  if (!Number.isFinite(retryDelay) || retryDelay <= 0 || retryDelay > STEP_RETRY_DELAY_SECONDS)
    throw new RangeError('Invalid content step retry delay');
  return { name: 'content', register: (context) => registerWork(context, options, partitions) };
}

async function registerWork(
  context: WorkContext,
  options: ContentWorkOptions,
  partitions: readonly number[],
): Promise<void> {
  const { storage } = options;
  const retry = contentStepRetryOptions(options.stepRetryDelaySeconds);
  for (const queue of Object.values(CONTENT_QUEUES)) {
    if (!(queue in context.queues)) throw new Error('Content requires shared kernel queues');
  }
  const purge = DBOS.registerStep(
    async (input: ContentWorkInput) => {
      validateInput(input);
      return createErasureJob(context.pool, storage).purgeObject(input.mediaId);
    },
    { name: 'content.purge.step', ...retry },
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
    { name: 'content.image.step', ...retry },
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
    { name: 'content.import.step', ...retry },
  );
  DBOS.registerWorkflow(async (input: ContentWorkInput) => imported(input), { name: CONTENT_WORKFLOWS.importFromUrl });

  // Register one retrying SDK step. The production orchestrator supplies its
  // deterministic bounded actions; DBOS records each invocation in native order.
  const authorStep = DBOS.registerStep(async (_name: string, action: () => Promise<unknown>) => action(), {
    name: 'content.authorErase.step',
    ...retry,
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
            // A zero timeout reads again whenever the first read returns within the same millisecond, so the statement
            // count varies from run to run. A deadline already past makes the read exactly once.
            read: () => DBOS.getEvent<OperationProgress>(DBOS.workflowID!, CONTENT_OPERATION_PROGRESS, -1),
            write: (_id, progress) => DBOS.setEvent(CONTENT_OPERATION_PROGRESS, progress),
          },
        },
        input.operationId,
      );
    },
    { name: CONTENT_WORKFLOWS.authorErase },
  );

  const subjectReactionMergePage = DBOS.registerStep(
    async (input: SubjectReactionMergeWorkInput, cursor: string | null) => {
      validateInput({ mediaId: input.id, source: input.source });
      if (routeOf(input.survivor) === null || input.id === input.survivor)
        throw new TypeError('Invalid subject reaction merge work input');
      return processSubjectReactionMergePage(
        { pool: context.pool, access: options.access },
        { id: input.id, survivor: input.survivor, cursor },
      );
    },
    { name: 'content.subjectReactionMerge.page', ...retry },
  );
  DBOS.registerWorkflow(
    async (input: SubjectReactionMergeWorkInput) => {
      validateInput({ mediaId: input.id, source: input.source });
      if (routeOf(input.survivor) === null || input.id === input.survivor)
        throw new TypeError('Invalid subject reaction merge work input');
      return runSubjectReactionMerge(input, (cursor) => subjectReactionMergePage(input, cursor));
    },
    { name: CONTENT_WORKFLOWS.subjectReactionMerge },
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
    { name: 'content.collect.step', ...retry },
  );
  const purgeDeleted = DBOS.registerStep(async (_name: string, action: () => Promise<unknown>) => action(), {
    name: 'content.deletedPostPurge.step',
    ...retry,
  });
  const drain = DBOS.registerWorkflow(
    async (partition: number) => {
      if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
        throw new RangeError('Invalid collection partition');
      for (let offset = 0; offset < 16; offset++) {
        while (
          (
            await purgeDeletedPostPage(
              context.pool,
              partition * 16 + offset,
              context.clock(),
              () => Date.now() + 120_000,
              <T>(name: string, action: () => Promise<T>) => purgeDeleted(name, action) as Promise<T>,
              createErasureJob(context.pool, storage),
            )
          ).postIds.length === 100
        ) {
          /* Completed posts leave the index before the next bounded durable step. */
        }
      }
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
  const refreshRanks = DBOS.registerStep(
    async (chunk: readonly number[]) => {
      const at = context.clock();
      return Promise.all(chunk.map((partition) => refreshBoardRankBatch(context.pool, at, [partition])));
    },
    {
      name: 'content.board-rank.refresh.step',
      ...retry,
    },
  );
  DBOS.registerWorkflow(
    async (_scheduledDate: Date, _context: unknown) => {
      for (let offset = 0; offset < partitions.length; offset += PARTITION_CONCURRENCY)
        await refreshRanks(partitions.slice(offset, offset + PARTITION_CONCURRENCY));
    },
    {
      name: BOARD_RANK_WORKFLOW,
    },
  );
  const noticeRetentionCutoff = DBOS.registerStep(
    async () => new Date(context.clock().getTime() - NOTICE_RETENTION_MS).toISOString(),
    { name: 'content.notice-retention.cutoff', ...retry },
  );
  const noticeRetentionPage = DBOS.registerStep(
    async (route: number, cutoff: string) => deleteExpiredNoticesPage(context.pool, route, new Date(cutoff)),
    { name: 'content.notice-retention.page', ...retry },
  );
  const noticeRetentionPartition = DBOS.registerWorkflow(
    async (partition: number, cutoff: string) => {
      if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
        throw new RangeError('Invalid notice retention partition');
      for (let routeOffset = 0; routeOffset < 16; routeOffset++) {
        const route = partition * 16 + routeOffset;
        for (;;) {
          if ((await noticeRetentionPage(route, cutoff)) < NOTICE_PAGE_SIZE) break;
        }
      }
    },
    { name: NOTICE_RETENTION_PARTITION_WORKFLOW },
  );
  DBOS.registerWorkflow(
    async (_scheduledDate: Date, _context: unknown) => {
      const cutoff = await noticeRetentionCutoff();
      const sweep = DBOS.workflowID!;
      for (let offset = 0; offset < partitions.length; offset += PARTITION_CONCURRENCY) {
        const handles = await Promise.all(
          partitions.slice(offset, offset + PARTITION_CONCURRENCY).map((partition) =>
            DBOS.startWorkflow(noticeRetentionPartition, {
              workflowID: `${sweep}:partition:${partition}`,
            })(partition, cutoff),
          ),
        );
        await Promise.all(handles.map((handle) => handle.getResult()));
      }
    },
    { name: NOTICE_RETENTION_WORKFLOW },
  );
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
    {
      scheduleName: CONTENT_NOTICE_RETENTION_SCHEDULE,
      workflowName: NOTICE_RETENTION_WORKFLOW,
      schedule: '0 * * * *',
      queueName: CONTENT_QUEUES.collect,
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);

  // The erased-post event carries only identity. The committed tombstone is the
  // authority, so a retry or a new event id reads it again and leaves erased rows unchanged.
  const erasedPostEvent = 'com.rezics.content.post.erased.v1' as const;
  const clearErasedPost = DBOS.registerStep(async (_name: string, action: () => Promise<unknown>) => action(), {
    name: 'content.erasePostRevisions.step',
    ...retry,
  });
  DBOS.registerWorkflow(
    async (postId: string) =>
      clearErasedPostRevisions(
        context.pool,
        { postId },
        () => Date.now() + 120_000,
        context.clock,
        <T>(name: string, action: () => Promise<T>) => clearErasedPost(name, action) as Promise<T>,
        createErasureJob(context.pool, storage),
      ),
    { name: 'content.erasePostRevisions' },
  );
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
  // Projections consume the source events after the source read has been released.
  context.addEffects([
    createReactionCountEffect(context.pool),
    createSubjectThreadEffect(context.pool),
    createAuthorItemEffect(context.pool),
    createReportLocatorEffect(context.pool),
    createPartyLocatorEffect(context.pool),
  ]);
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
            const row = await readOperationEnqueue.run(tx, {
              route,
              operation_id: input.operationId,
            });
            const receipt =
              row &&
              row.initiator_account_id !== null &&
              (await readOperationEnqueueReceipt.run(tx, {
                partition_no: partitionOf(route),
                initiator_account_id: row.initiator_account_id,
                creation_command_kind: row.creation_command_kind,
                creation_idempotency_key: row.creation_idempotency_key,
                recorded_transaction_id: row.recorded_transaction_id,
                creation_request_digest: row.creation_request_digest,
                operation_id: row.operation_id,
              }));
            await tx.query('COMMIT');
            return receipt ? row : null;
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          }
        }),
      );
      if (
        row === null ||
        row.native_workflow_id === null ||
        row.source_epoch === null ||
        row.source_partition === null ||
        row.source_position === null ||
        row.source_event_index === null ||
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
        // A zero timeout reads again whenever the first read returns within the same millisecond, so the statement
        // count varies from run to run. A deadline already past makes the read exactly once.
        const event = await client.getEvent<OperationProgress>(workflowID, CONTENT_OPERATION_PROGRESS, -1);
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
