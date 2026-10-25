import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import { createInitiatorRestorer, DurableInitiatorUnavailableError } from '../access/durable-initiator.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { erasePostLogicalAsInitiator, type ErasureInitiator } from './erase-post.ts';
import type { ErasureJob } from './erasure-job.ts';
import { readErasureInitiator } from './erasure-initiator.ts';
import type { OperationProgress, Status } from './operation-contract.ts';
import readOperation from './read-workflow-erasure-operation.sql';
import pagePosts from './page-erasure-posts.sql';
import nullRevisions from './null-erased-revisions.sql';
import eraseMedia from './page-erasure-media.sql';

export type NativeDurableStep = <T>(name: string, action: () => Promise<T>) => Promise<T>;

export interface ErasureCheckpointAdapter {
  read(operationId: string): Promise<OperationProgress | null>;
  write(operationId: string, progress: OperationProgress): Promise<void>;
}

export type AuthorErasureWorkflowDependencies = Readonly<{
  pool: Pool;
  access: Access;
  readConsent: CurrentConsentReader;
  currentTime: () => Date;
  durableStep: NativeDurableStep;
  checkpoint: ErasureCheckpointAdapter;
  /** The existing erasure job, composed by the governance workflow registration.
   * A missing job fails closed if a post actually has owned media to purge.
   */
  erasureJob?: ErasureJob;
}>;

export type AuthorErasureWorkflowResult = Readonly<{
  processedPosts: number;
  erasedRevisions: number;
}>;

/** Native failure is the operation's google.rpc.Status; adapters preserve code 7
 * from DBOS's stored error, alongside its native progress event.
 */
class ErasurePermissionDenied extends Error implements Status {
  readonly code = 7;
  constructor() {
    super('Author erasure permission is no longer available');
    this.name = 'ErasurePermissionDenied';
  }
}

type Statement = { sql: string; params: readonly string[]; '~reylo': { input: object; element: object } };
async function query<S extends Statement>(client: AccessClient, statement: S, input: S['~reylo']['input']) {
  const values = input as Record<string, unknown>;
  return (
    await client.query<S['~reylo']['element']>(
      statement.sql,
      statement.params.map((name) => values[name]),
    )
  ).rows;
}

/** Shared by native read steps and cost tests. The supplied client has one
 * independently anchored content partition. No authority is derived here.
 */
export function pageAuthorErasurePosts(client: AccessClient, input: (typeof pagePosts)['~reylo']['input']) {
  return query(client, pagePosts, input);
}

export async function nullErasedRevisionPage(client: AccessClient, input: (typeof nullRevisions)['~reylo']['input']) {
  return (await query(client, nullRevisions, input)).map((row) => {
    if (row.revision_id === null || row.at === null || row.changed === null)
      throw new Error('Invalid retained revision identity');
    return { revision_id: row.revision_id, at: row.at, changed: row.changed };
  });
}

export async function eraseRevisionMedia(client: AccessClient, input: (typeof eraseMedia)['~reylo']['input']) {
  return (await query(client, eraseMedia, input)).map((row) => {
    if (row.media_id === null || row.container_id === null || row.changed === null)
      throw new Error('Invalid owned media identity');
    return { media_id: row.media_id, container_id: row.container_id, changed: row.changed };
  });
}

function add(value: number, increment = 1): number {
  const next = value + increment;
  if (!Number.isSafeInteger(next) || next < 0) throw new RangeError('Operation counter overflow');
  return next;
}

/** Native DBOS orchestration only. Each durable action is a bounded page, point
 * command or prefix purge. Replaying DBOS checkpoints rebuilds cursors/counters;
 * source command receipts fence the commit-to-step-checkpoint crash window.
 * Registration owns the sole worker launch and runs this on governance.
 */
export async function runAuthorErasure(
  deps: AuthorErasureWorkflowDependencies,
  operationId: string,
): Promise<AuthorErasureWorkflowResult> {
  const route = routeOf(operationId);
  if (route === null) throw new ErasurePermissionDenied();
  const partition = partitionOf(route);
  const prefix = `wf:${operationId}:`;
  let progress: OperationProgress = { processedPosts: 0, erasedRevisions: 0, steps: 0 };
  const step: NativeDurableStep = async (name, action) => {
    const result = await deps.durableStep(prefix + name, action);
    progress = { ...progress, steps: add(progress.steps) };
    return result;
  };
  const read = <T>(action: (client: AccessClient) => Promise<T>) =>
    withConnection(deps.pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const anchor = await readPartition(client, partition);
        if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition unavailable');
        const value = await action(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  const source = await step('source', () =>
    read(async (client) => {
      const [row] = await query(client, readOperation, { partition_no: partition, route, operation_id: operationId });
      if (!row || !row.native_workflow_id || row.native_workflow_id !== DBOS.workflowID)
        throw new ErasurePermissionDenied();
      return {
        threadId: row.thread_id,
        authorId: row.author_account_id,
        accountId: row.initiator_account_id,
        clientId: row.actor_client_id,
        requestedBy: row.actor_requested_by,
        upperAt: row.upper_created_at,
        upperId: row.upper_post_id,
        empty: row.empty_scope,
      };
    }),
  );
  const restorer = createInitiatorRestorer({
    pool: deps.pool,
    access: deps.access,
    readOperation: readErasureInitiator,
    readConsent: deps.readConsent,
  });
  const initiator: ErasureInitiator = {
    kind: 'durable-initiator',
    restorer,
    operation: { route, id: operationId, kind: 'content.author-erasure', sourceId: operationId },
    accountId: source.accountId,
    clientId: source.clientId,
    requestedBy: source.requestedBy,
  };
  const pointDependencies = {
    pool: deps.pool,
    access: deps.access,
    clock: deps.currentTime,
  };
  const pageInput = {
    partition_no: partition,
    route,
    operation_id: operationId,
    initiator_id: source.accountId,
    thread_id: source.threadId,
    author_id: source.authorId,
    upper_at: source.upperAt!,
    upper_id: source.upperId!,
  };
  // Mechanical receipts retain the actual initiating person's receipt namespace,
  // with NULL command basis (platform attribution). No worker identity or grant
  // is invented; only already committed post tombstones authorize this work.
  const cleanup = <T>(name: string, action: (client: AccessClient) => Promise<{ value: T; mediaIds: string[] }>) =>
    runCommand(
      deps.pool,
      {
        partition,
        clock: deps.currentTime,
        receipt: {
          actorAccountId: source.accountId,
          kind: 'content.author-erasure.cleanup',
          key: prefix + name,
          digest: createHash('sha256')
            .update(prefix + name)
            .digest(),
        },
      },
      async (tx) => {
        const { value, mediaIds } = await action(tx);
        return {
          value,
          events: [
            {
              type: 'com.rezics.content.moderation.erasure.v1',
              data: { threadId: source.threadId, postIds: [], mediaIds },
            },
          ],
        };
      },
    ).then((outcome) => outcome.value);

  let after = { at: '-infinity', id: operationId };
  if (!source.empty && source.upperAt && source.upperId) {
    for (;;) {
      const posts = await step(`posts:${after.at}:${after.id}`, () =>
        read((client) => pageAuthorErasurePosts(client, { ...pageInput, after_at: after.at, after_id: after.id })),
      );
      for (const post of posts) {
        let denied = false;
        // A native completed step is a prior action. An executing retry/replay
        // always restores at its own T, before the source receipt lookup.
        const logical = await step(`erase:${post.post_id}`, async () => {
          try {
            await erasePostLogicalAsInitiator(
              pointDependencies,
              initiator,
              { postId: post.post_id, reason: 'Author erasure' },
              {
                deadline: Date.now() + 10_000,
                idempotencyKey: `${prefix}erase:${post.post_id}`,
                requestId: operationId,
              },
            );
            return { committed: true, denied: false };
          } catch (error) {
            if (!(error instanceof GrantDeniedError || error instanceof DurableInitiatorUnavailableError)) throw error;
            // A command may have committed before DBOS recorded its result.
            // Exact own receipt + tombstone permit finishing that decision even
            // when a now-revoked person cannot replay its response.
            const rows = await read((client) =>
              pageAuthorErasurePosts(client, {
                ...pageInput,
                after_at: after.at,
                after_id: after.id,
                upper_at: post.at,
                upper_id: post.post_id,
              }),
            );
            return { committed: rows.find((row) => row.post_id === post.post_id)?.committed === true, denied: true };
          }
        });
        denied = logical.denied;
        if (logical.committed) {
          progress = { ...progress, processedPosts: add(progress.processedPosts) };
          await deps.checkpoint.write(operationId, progress);
          let revisionAfter = { at: '-infinity', id: post.post_id };
          for (;;) {
            const name = `revisions:${post.post_id}:${revisionAfter.at}:${revisionAfter.id}`;
            const revisions = await step(name, () =>
              cleanup(name, async (client) => ({
                value: await nullErasedRevisionPage(client, {
                  route,
                  post_id: post.post_id,
                  after_at: revisionAfter.at,
                  after_id: revisionAfter.id,
                }),
                mediaIds: [],
              })),
            );
            progress = {
              ...progress,
              erasedRevisions: add(progress.erasedRevisions, revisions.filter((revision) => revision.changed).length),
            };
            for (const revision of revisions) {
              const mediaName = `media:${post.post_id}:${revision.revision_id}`;
              const media = await step(mediaName, () =>
                cleanup(mediaName, async (client) => {
                  const value = await eraseRevisionMedia(client, {
                    route,
                    post_id: post.post_id,
                    revision_id: revision.revision_id,
                  });
                  return { value, mediaIds: value.map((row) => row.media_id) };
                }),
              );
              for (const item of media)
                await step(`purge:${post.post_id}:${revision.revision_id}:${item.media_id}`, async () => {
                  if (!deps.erasureJob) throw new Error('Content erasure job is not composed');
                  const result = await deps.erasureJob.purgeObject(item.media_id);
                  if (result.outcome === 'fenced') throw new Error('Committed media purge is fenced');
                  return result;
                });
            }
            await deps.checkpoint.write(operationId, progress);
            if (revisions.length < 100) break;
            const last = revisions.at(-1)!;
            revisionAfter = { at: last.at, id: last.revision_id };
          }
        }
        if (denied) {
          await deps.checkpoint.write(operationId, progress);
          throw new ErasurePermissionDenied();
        }
        after = { at: post.at, id: post.post_id };
      }
      if (posts.length < 100) break;
    }
  }
  await deps.checkpoint.write(operationId, progress);
  return { processedPosts: progress.processedPosts, erasedRevisions: progress.erasedRevisions };
}
