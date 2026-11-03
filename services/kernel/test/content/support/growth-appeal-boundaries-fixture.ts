import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createKernel } from '../../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { registerContent } from '../../../src/content/register.ts';
import { effectWorkflowId, type Effect } from '../../../src/events/effects.ts';
import { readBatch, type Envelope } from '../../../src/events/log.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { registerNativeContentAccount } from './native-system.ts';
import { createReactionRelayBase } from '../reaction-relay-convergence-fixture.ts';

type Person = Readonly<{ accountId: string; bearer: string }>;
type ThreadTarget = Awaited<ReturnType<Awaited<ReturnType<typeof createReactionRelayBase>>['createThread']>>;
type QueueRecord = Readonly<{
  boardId: string;
  threadId: string;
  reportId: string;
  decisionId: string;
  appealId: string;
}>;
export type AppealHistoryAxis = 'unrelated-pending' | 'retained-history';

const retentionTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

/** A private native HTTP, Access and registered-Content runtime for appeal queue growth acceptance. */
export async function createGrowthAppealBoundariesFixture() {
  const base = await createReactionRelayBase();
  const system = base.system;
  const databaseUrl = system.database.pool.options.connectionString!;
  let db: GrowthDatabase | undefined;
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let closed = false;

  try {
    db = await openGrowthDatabase(databaseUrl);
    const originalAuthenticate = system.access.authenticate;
    system.access.authenticate = (token, boundary) => originalAuthenticate(token, { ...boundary, pool: db!.pool });

    const app = createKernel({
      pool: db.pool,
      access: system.access,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      receiptKeys: testReceiptKeys(),
      writeRate: createWriteRateLimiter({
        secret: randomUUID() + randomUUID(),
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86400 } } }),
      }),
      ratePeer: () => '127.0.0.1',
    });

    const suffix = randomUUID().replaceAll('-', '');
    const registeredReviewer = await registerNativeContentAccount(system, {
      key: `appeal-boundary-${suffix}`,
      handle: `appealboundary${suffix.slice(0, 12)}`,
      email: `appealboundary-${suffix}@content.test`,
      password: 'ordinary native registration password',
    });
    const reviewerCredential = await system.auth.issue({
      accountId: registeredReviewer.accountId,
      clientId: system.auth.ordinaryClient.id,
      scopes: system.auth.ordinaryScopes,
    });

    const people = {
      author: { accountId: base.author.accountId, bearer: base.author.bearer },
      reporter: { accountId: base.other.accountId, bearer: base.other.bearer },
      decider: { accountId: system.actors.moderator.actor.accountId, bearer: system.actors.moderator.bearer },
      reviewer: { accountId: registeredReviewer.accountId, bearer: reviewerCredential.bearer },
    } satisfies Record<string, Person>;

    client = await createWorkClient(databaseUrl, db.pool);
    const registered: Effect[] = [];
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
        pool: db.pool,
        client,
        executorId: `appeal-boundaries-${suffix}`,
        env: workerTestEnv({
          CONTENT_TEST_COLLECTION_PARTITIONS: '0',
          KERNEL_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url'),
        }),
      },
    );
    await work.launch();

    async function call(method: string, path: string, options: { bearer?: string; key?: string; body?: unknown } = {}) {
      const headers = new Headers();
      if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
      if (options.key !== undefined) headers.set('idempotency-key', JSON.stringify(options.key));
      if (options.body !== undefined) headers.set('content-type', 'application/json');
      const response = await app.handle(
        new Request(`https://appeal-boundaries.test${path}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      );
      const text = await response.text();
      let body: Record<string, any> | null = null;
      if (text) {
        try {
          body = JSON.parse(text) as Record<string, any>;
        } catch {
          body = null;
        }
      }
      return { response, body, text };
    }

    async function command<T>(
      method: string,
      path: string,
      body: unknown,
      options: { bearer: string; key?: string; expectedStatus: number },
    ) {
      const key = options.key ?? randomUUID();
      const result = await base.call(method, path, { bearer: options.bearer, key, body });
      if (result.response.status !== options.expectedStatus)
        throw new Error(`${method} ${path}: ${result.response.status} ${result.text}`);
      return { body: result.value as T, key, response: result.response };
    }

    async function completeRegisteredCommand(principalId: string, key: string): Promise<void> {
      const receipt = (
        await db!.admin.query<{ partition_no: number; epoch: number; position: string }>(
          `SELECT partition_no,epoch,position::text AS position
           FROM core.receipt
           WHERE principal_kind='account' AND principal_id=$1 AND idempotency_key=$2`,
          [principalId, key],
        )
      ).rows[0];
      if (!receipt) throw new Error(`Missing committed receipt for registered Content command ${key}`);

      const position = BigInt(receipt.position);
      const consumer = `appeal_boundary_${randomUUID().replaceAll('-', '')}`;
      await db!.pool.query(
        `INSERT INTO core.consumer_checkpoint (partition_no,consumer,epoch,position)
         VALUES ($1,$2,$3,$4)`,
        [receipt.partition_no, consumer, receipt.epoch, (position - 1n).toString()],
      );
      const envelopes: Envelope[] = [];
      const result = await readBatch(db!.pool, {
        consumer,
        partition: receipt.partition_no,
        envelopes: 1,
        apply: async (batch) => {
          envelopes.push(...batch);
        },
      });
      const envelope = envelopes[0];
      if (result.status !== 'read' || !envelope || BigInt(envelope.position) !== position)
        throw new Error(`Could not read the committed Content envelope for receipt ${key}`);

      await work!.effects.enqueue([envelope]);
      let completed = 0;
      for (const [eventSeq, event] of envelope.events.entries()) {
        for (const effect of registered.filter((candidate) => candidate.types.includes(event.type))) {
          await client!.retrieveWorkflow(effectWorkflowId(envelope, eventSeq, effect.name)).getResult({
            pollingIntervalMs: 10,
          });
          completed++;
        }
      }
      if (completed === 0) throw new Error(`No registered Content effect completed for receipt ${key}`);
    }

    function routed(id: string): number {
      const route = routeOf(id);
      if (route === null) throw new TypeError(`Expected a routed resource id: ${id}`);
      return route;
    }

    async function grant(resourceId: string, subjectId: string, actions: readonly string[]): Promise<void> {
      await command(
        'POST',
        '/v1/grants',
        {
          resource: { route: routed(resourceId), id: resourceId },
          subject: { kind: 'account', id: subjectId },
          actions,
          valid: '(,)',
        },
        { bearer: base.governance.bearer, expectedStatus: 201 },
      );
    }

    async function submitAppeal(
      boardId: string,
      target: ThreadTarget,
    ): Promise<{
      record: QueueRecord;
      reportReceipt: Awaited<ReturnType<typeof call>>;
      appeal: Awaited<ReturnType<typeof call>>;
      appealReplay: Awaited<ReturnType<typeof call>>;
      authorDecision: Awaited<ReturnType<typeof call>>;
    }> {
      await grant(target.threadId, people.reporter.accountId, ['report:create']);
      const report = await command<{ reportId: string }>(
        'POST',
        '/v1/reports',
        { target: { kind: 'thread', id: target.threadId }, reason: 'spam' },
        { bearer: people.reporter.bearer, expectedStatus: 201 },
      );
      await completeRegisteredCommand(people.reporter.accountId, report.key);

      await grant(target.threadId, people.decider.accountId, ['moderation:takedown']);
      await grant(target.threadId, people.reviewer.accountId, ['moderation:takedown']);
      const takenDown = await command(
        'POST',
        `/v1/threads/${target.threadId}:takeDown`,
        { reason: 'Policy violation' },
        { bearer: people.decider.bearer, expectedStatus: 200 },
      );
      await completeRegisteredCommand(people.decider.accountId, takenDown.key);

      const decision = (
        await db!.admin.query<{ decision_id: string }>(
          `SELECT decision_id FROM content.moderation_decision
           WHERE route=$1 AND target_id=$2 ORDER BY security_revision DESC LIMIT 1`,
          [routed(target.threadId), target.threadId],
        )
      ).rows[0];
      if (!decision) throw new Error(`Takedown did not create a moderation decision for ${target.threadId}`);

      const appeal = await command<{ id: string }>(
        'POST',
        `/v1/moderation-decisions/${decision.decision_id}:appeal`,
        { statement: 'Please reconsider' },
        { bearer: people.author.bearer, expectedStatus: 201 },
      );
      const appealReplay = await call('POST', `/v1/moderation-decisions/${decision.decision_id}:appeal`, {
        bearer: people.author.bearer,
        key: appeal.key,
        body: { statement: 'Please reconsider' },
      });
      if (appealReplay.response.status !== 201)
        throw new Error(
          `POST /v1/moderation-decisions/${decision.decision_id}:appeal replay: ${appealReplay.response.status}`,
        );
      await completeRegisteredCommand(people.author.accountId, appeal.key);

      const reportReceipt = await call('GET', `/v1/reports/${report.body.reportId}`, {
        bearer: people.reporter.bearer,
      });
      const authorDecision = await call('GET', `/v1/moderation-decisions/${decision.decision_id}`, {
        bearer: people.author.bearer,
      });
      return {
        record: {
          boardId,
          threadId: target.threadId,
          reportId: report.body.reportId,
          decisionId: decision.decision_id,
          appealId: appeal.body.id,
        },
        reportReceipt,
        appeal: { response: appeal.response, body: appeal.body, text: '' },
        appealReplay,
        authorDecision,
      };
    }

    async function resolveAppeal(record: QueueRecord): Promise<void> {
      const result = await command(
        'POST',
        `/v1/moderation-appeals/${record.appealId}:resolve`,
        { outcome: 'uphold', statement: 'Reviewed independently' },
        { bearer: people.reviewer.bearer, expectedStatus: 200 },
      );
      await completeRegisteredCommand(people.reviewer.accountId, result.key);
    }

    async function listAppeals(boardId: string, bearer: string, cursor?: string) {
      const query = new URLSearchParams({ limit: '2' });
      if (cursor) query.set('cursor', cursor);
      return call('GET', `/v1/boards/${boardId}/appeals?${query}`, { bearer });
    }

    async function seedHistory(
      database: GrowthDatabase,
      axis: AppealHistoryAxis,
      tag: string,
      scale: number,
      previous: number,
      pressureBoardId: string,
      pressureThreadId: string,
    ): Promise<void> {
      const targetRoute = routed(pressureThreadId);
      const boardRoute = routed(pressureBoardId);
      const statement = `growth-appeal-boundaries:${tag}`;
      const existing = (
        await database.admin.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM content.moderation_appeal
           WHERE route=$1 AND thread_id=$2 AND statement=$3`,
          [targetRoute, pressureThreadId, statement],
        )
      ).rows[0]!.count;
      if (existing !== previous) throw new Error(`${tag} history is ${existing}; expected prior scale ${previous}`);
      const missing = scale - existing;
      if (missing <= 0) return;

      const decisionIds = Array.from({ length: missing }, () => newId(targetRoute));
      const appealIds = Array.from({ length: missing }, () => newId(targetRoute));
      const maximum = (
        await database.admin.query<{ revision: number }>(
          `SELECT COALESCE(max(security_revision),0)::integer AS revision
           FROM content.moderation_decision WHERE route=$1 AND target_id=$2`,
          [targetRoute, pressureThreadId],
        )
      ).rows[0]!.revision;
      await database.admin.query(
        `INSERT INTO content.moderation_decision
         (route,decision_id,target_kind,target_id,action,statement,decider_account_id,security_revision,decided_at)
         SELECT $1,decision_id,'thread',$3,'takedown','Growth decision',$4,ordinality+$5,$6
         FROM unnest($2::uuid[]) WITH ORDINALITY AS d(decision_id,ordinality)`,
        [targetRoute, decisionIds, pressureThreadId, people.decider.accountId, maximum, retentionTimestamp],
      );
      await database.admin.query(
        `INSERT INTO content.moderation_appeal
         (route,appeal_id,decision_id,appellant_account_id,statement,thread_id,board_id,created_at)
         SELECT $1,appeal_id,decision_id,$4,$5,$6,$7,$8
         FROM unnest($2::uuid[],$3::uuid[]) AS a(appeal_id,decision_id)`,
        [
          targetRoute,
          appealIds,
          decisionIds,
          people.author.accountId,
          statement,
          pressureThreadId,
          pressureBoardId,
          retentionTimestamp,
        ],
      );
      await database.admin.query(
        `INSERT INTO content.moderation_appeal_board (route,board_id,appeal_id,created_at,pending)
         SELECT $1,$2,appeal_id,$3,$4 FROM unnest($5::uuid[]) AS a(appeal_id)`,
        [boardRoute, pressureBoardId, retentionTimestamp, axis === 'unrelated-pending', appealIds],
      );
    }

    async function revokeTargetModeration(resourceId: string, subjectId: string): Promise<void> {
      await db!.admin.query(
        `DELETE FROM access.resource_grant
         WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='moderation:takedown'`,
        [routed(resourceId), resourceId, subjectId],
      );
    }

    return {
      db,
      base,
      people,
      call,
      grant,
      submitAppeal,
      resolveAppeal,
      listAppeals,
      seedHistory,
      revokeTargetModeration,
      completeRegisteredCommand,
      moderationEffect: registered.find((effect) => effect.name === 'content_moderation_decision')!,
      async createBoard(label: string) {
        return (await base.createRealmTarget(label, 'public')).boardId;
      },
      async createThread(boardId: string, label: string) {
        return base.createThread(boardId, label);
      },
      routed,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await work?.shutdown();
        } finally {
          try {
            await client?.close();
          } finally {
            try {
              await db?.close();
            } finally {
              await system.close();
            }
          }
        }
      },
    };
  } catch (error) {
    try {
      await work?.shutdown();
    } finally {
      try {
        await client?.close();
      } finally {
        try {
          await db?.close();
        } finally {
          await system.close();
        }
      }
    }
    throw error;
  }
}
