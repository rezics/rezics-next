import { DBOS } from '@dbos-inc/dbos-sdk';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { registerContent } from '../../src/content/register.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import { effectWorkflowId, type Effect } from '../../src/events/effects.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { accountDeletionRuntime } from '../support/account-deletion.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createReactionRelayBase, type CallResult, type ReactionTarget } from './reaction-relay-convergence-fixture.ts';

export type PointKind = 'board' | 'thread' | 'post';
export type NativePointFixture = Awaited<ReturnType<typeof createNativePointFixture>>;
export type PointTarget = ReactionTarget & { replyId: string; revisions: string[]; sentinel: string };
export const pointReason = { reason: 'Native moderation evidence statement' };
export const targetId = (target: ReactionTarget, kind: PointKind) =>
  kind === 'board' ? target.boardId : kind === 'thread' ? target.threadId : target.postId;
export const pointPath = (kind: PointKind, id: string) => `/v1/${kind}s/${id}:takeDown`;

/** Real Auth registrations and product creation commands; administrative reads only inspect their outcomes. */
export async function createNativePointFixture() {
  const base = await createReactionRelayBase();
  let runtime: Awaited<ReturnType<typeof startPointWork>> | undefined;
  try {
    const moderator = base.system.actors.moderator;
    // The shared native runtime's ordinary registration port issues a fourth independent account.
    const reader = await accountDeletionRuntime(base.system).person();
    async function grant(id: string, actions: string[], accountId = moderator.actor.accountId) {
      const body = {
        resource: { route: routeOf(id)!, id },
        subject: { kind: 'account', id: accountId },
        actions,
        valid: '(,)',
      };
      await base.command('POST', '/v1/grants', body, { bearer: base.governance.bearer });
      return body;
    }
    async function fresh(label: string, separateBoard = false): Promise<PointTarget> {
      const board = separateBoard
        ? await base.createRealmTarget(`${label} ${randomUUID()}`, 'public')
        : base.mainTarget;
      let target = await base.createThread(board.boardId, label);
      // The documented discussion layout puts thread + posts together, independently of their board.
      for (let attempt = 0; partitionOf(target.threadRoute) === partitionOf(target.boardRoute); attempt++) {
        if (attempt === 255) throw new Error('Could not create a thread outside its board partition');
        target = await base.createThread(board.boardId, label);
      }
      const sentinel = `${label} private evidence ${randomUUID()}`;
      const reply = await base.command<{ post: { id: string } }>('POST', `/v1/threads/${target.threadId}/posts`, {
        body: fromPlainText(`${label} independently retained reply`),
        licence: 'MIT',
        parentId: target.postId,
      });
      const first = await base.call('GET', `/v1/posts/${target.postId}`);
      if (first.response.status !== 200) throw new Error(`Opening post read failed: ${first.text}`);
      const revised = await base.command<{ post: { revisionId: string } }>(
        'POST',
        `/v1/posts/${target.postId}/revisions`,
        { body: fromPlainText(sentinel), licence: 'MIT', subjectIds: [base.conceptId] },
        { expectedStatus: 200 },
      );
      return {
        ...target,
        replyId: reply.post.id,
        revisions: [first.value!.post.revisionId, revised.post.revisionId],
        sentinel,
      };
    }
    return {
      ...base,
      moderator,
      reader,
      grant,
      fresh,
      async startWork(pool = base.system.database.pool) {
        if (runtime) throw new Error('Point worker already started');
        runtime = await startPointWork(pool, base.system.database.pool.options.connectionString!, base.system.routeKey);
        return runtime;
      },
      async stopWork() {
        try {
          await runtime?.close();
        } finally {
          runtime = undefined;
        }
      },
      async close() {
        try {
          await runtime?.close();
        } finally {
          await base.system.close();
        }
      },
    };
  } catch (error) {
    await base.system.close();
    throw error;
  }
}

/** Supported Auth-to-Content ownership handoff, as in the delivered reaction-relay fixture. */
async function startPointWork(pool: Pool, databaseUrl: string, routeKey: Uint8Array) {
  const client = await createWorkClient(databaseUrl, pool);
  const registered: Effect[] = [];
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    await DBOS.shutdown({ deregister: true });
    work = await composeWork(
      [
        {
          name: registerContent.name,
          register(context) {
            return registerContent.register({
              ...context,
              addEffects(effects) {
                registered.push(...effects);
                context.addEffects(effects);
              },
            });
          },
        },
      ],
      {
        databaseUrl,
        pool,
        client,
        executorId: `native-point-${randomUUID()}`,
        env: workerTestEnv({
          KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
          CONTENT_TEST_COLLECTION_PARTITIONS: '0',
        }),
      },
    );
    await work.launch();
    return {
      async produce(envelope: Envelope, names: readonly string[]) {
        for (const name of names)
          if (!registered.some((effect) => effect.name === name)) throw new Error(`Missing production effect ${name}`);
        // Dispatch the actual committed envelope through the registered production effects mechanism.
        await work!.effects.enqueue([envelope]);
        for (const [index, event] of envelope.events.entries()) {
          for (const effect of registered.filter((effect) => effect.types.includes(event.type)))
            await client
              .retrieveWorkflow(effectWorkflowId(envelope, index, effect.name))
              .getResult({ pollingIntervalMs: 10 });
          if (event.type === 'com.rezics.content.post.erased.v1' && names.includes('content_post_erased'))
            await client.retrieveWorkflow(`content.erasePost:${event.id}`).getResult({ pollingIntervalMs: 10 });
        }
      },
      async close() {
        try {
          await work?.shutdown();
        } finally {
          await client.close();
        }
      },
    };
  } catch (error) {
    try {
      await work?.shutdown();
    } finally {
      await client.close();
    }
    throw error;
  }
}

/** A native source capture, installed before the command, reads only that partition's next envelope. */
export async function capturePointEvent(pool: Pool, id: string) {
  const partition = partitionOf(routeOf(id)!);
  const head = (
    await pool.query<{ epoch: number; position: string }>(
      'SELECT epoch,position::text AS position FROM core.partition WHERE partition_no=$1',
      [partition],
    )
  ).rows[0]!;
  const consumer = `point_capture_${randomUUID().replaceAll('-', '')}`;
  await pool.query('INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position) VALUES ($1,$2,$3,$4)', [
    partition,
    consumer,
    head.epoch,
    head.position,
  ]);
  return async () => {
    const envelopes: Envelope[] = [];
    const result = await readBatch(pool, {
      consumer,
      partition,
      envelopes: 1,
      apply: async (batch) => {
        envelopes.push(...batch);
      },
    });
    if (result.status !== 'read' || envelopes.length !== 1)
      throw new Error('Point command did not commit one native envelope');
    return envelopes[0]!;
  };
}

export async function partitionHeads(pool: Pool) {
  return (
    await pool.query<{ partition_no: number; epoch: number; position: string }>(
      'SELECT partition_no,epoch,position::text AS position FROM core.partition ORDER BY partition_no',
    )
  ).rows;
}

export async function storedTarget(pool: Pool, kind: PointKind, id: string) {
  return (await pool.query(`SELECT * FROM content.${kind} WHERE route=$1 AND ${kind}_id=$2`, [routeOf(id), id]))
    .rows[0];
}

/** Full retained canonical fields, including references, licence and history; never a substring comparison. */
export async function retainedRevisions(pool: Pool, postId: string) {
  return (
    await pool.query(
      `SELECT *
       FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id`,
      [routeOf(postId), postId],
    )
  ).rows;
}

export async function commandEvidence(pool: Pool, principalId: string, key: string, id: string) {
  const receipts = (
    await pool.query(
      `SELECT partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,
            epoch,position::text AS position,transaction_id,response FROM core.receipt
      WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND idempotency_key=$3`,
      [partitionOf(routeOf(id)!), principalId, key],
    )
  ).rows;
  const events =
    receipts.length === 0
      ? []
      : (
          await pool.query(
            `SELECT partition_no,epoch,position::text AS position,event_seq,event_count,id,type,subject,data
       FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq`,
            [receipts[0]!.partition_no, receipts[0]!.position],
          )
        ).rows;
  return { receipts, events };
}

export function problemShape(result: CallResult) {
  const { request_id: _request, ...shape } = result.value ?? {};
  return shape;
}
