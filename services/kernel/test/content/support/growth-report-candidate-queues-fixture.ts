import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { registerContent } from '../../../src/content/register.ts';
import { effectWorkflowId, type Effect } from '../../../src/events/effects.ts';
import { readBatch, type Envelope } from '../../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { composeWork, type WorkModule } from '../../../src/work/registry.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { configureTestReceiptKeys } from '../../support/receipt-keys.ts';
import { seedReportGrowth, type ReportGrowthRow } from './report-growth.ts';
import { createReactionRelayBase, type CallResult, type ReactionRelayBase } from '../reaction-relay-convergence-fixture.ts';

export type QueueTargetKind = 'board' | 'thread' | 'post';

export type QueueReport = Readonly<{
  id: string;
  targetKind: QueueTargetKind;
  targetId: string;
  evidence: string;
  boardId: string;
  createdAt: string;
}>;

export type QueueTrace = {
  candidatePageQueries: number;
  rawCandidateReferences: number;
  reportSourceRows: number;
  finalAuthorityRevoked: boolean;
};

export type RunnerCapture = Readonly<{
  reportId: string;
  phase: 'projection' | 'replay';
  rows: number;
  blocks: number;
  statements: number;
}>;

const reportCreated = 'com.rezics.content.report.created.v1';
const pageLimit = 2;

export async function createGrowthReportCandidateQueuesFixture() {
  const base = await createReactionRelayBase();
  let growth: GrowthDatabase | undefined;
  let runner: Awaited<ReturnType<typeof startRegisteredContentRunner>> | undefined;
  const nativePool = base.system.database.pool;
  const originalConnect = nativePool.connect.bind(nativePool);
  let routedConnect: typeof nativePool.connect | undefined;
  let activeTrace: QueueTrace | undefined;
  let finalRevocation: (() => Promise<void>) | undefined;
  let boardPermission: Awaited<ReturnType<typeof grant>> | undefined;
  let boardPermissionActive = false;
  const reports = new Map<string, QueueReport>();
  const envelopes = new Map<string, Envelope>();
  const runnerCaptures: RunnerCapture[] = [];

  function traceClient(client: PoolClient): void {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      const sql = queryText(args[0]);
      const isCandidatePage = /\bFROM\s+content\.board_report_candidate\b/i.test(sql);
      const result = query(...args);
      if (!isPromiseLike(result)) return result;
      return Promise.resolve(result).then(async (value) => {
        const rows = queryRows(value);
        if (isCandidatePage && activeTrace) {
          activeTrace.candidatePageQueries++;
          activeTrace.rawCandidateReferences += rows;
        }
        if (/\bFROM\s+content\.report\b/i.test(sql) && activeTrace) activeTrace.reportSourceRows += rows;
        if (isCandidatePage && finalRevocation) {
          const revoke = finalRevocation;
          finalRevocation = undefined;
          await revoke();
          if (activeTrace) activeTrace.finalAuthorityRevoked = true;
        }
        return value;
      });
    }) as typeof client.query;
  }

  try {
    const databaseUrl = nativePool.options.connectionString;
    if (!databaseUrl) throw new Error('Native content system has no application database URL');
    growth = await openGrowthDatabase(databaseUrl);
    configureTestReceiptKeys(growth.pool);

    const observedConnect = growth.pool.connect.bind(growth.pool) as (...args: unknown[]) => unknown;
    routedConnect = ((callback?: unknown) => {
      if (typeof callback === 'function') {
        return observedConnect((error: unknown, client: PoolClient | undefined, release: (error?: Error) => void) => {
          if (!error && client) traceClient(client);
          callback(error, client, release);
        });
      }
      return (observedConnect() as Promise<PoolClient>).then((client) => {
        traceClient(client);
        return client;
      });
    }) as typeof nativePool.connect;
    nativePool.connect = routedConnect;

    runner = await startRegisteredContentRunner(base, growth.pool, databaseUrl);

    async function grant(resourceId: string, action: string, accountId = base.other.accountId) {
      const input = {
        resource: { route: routeOf(resourceId)!, id: resourceId },
        subject: { kind: 'account' as const, id: accountId },
        actions: [action],
        valid: '(,)',
      };
      const response = await base.command<{ grant: { valid: string } }>('POST', '/v1/grants', input, {
        bearer: base.governance.bearer,
      });
      return { ...input, valid: response.grant.valid };
    }

    async function revokeBoardPermission(): Promise<void> {
      if (!boardPermission || !boardPermissionActive) return;
      const currentConnect = nativePool.connect;
      nativePool.connect = originalConnect;
      try {
        await base.command('POST', '/v1/grants:revoke', boardPermission, {
          bearer: base.governance.bearer,
        });
        boardPermissionActive = false;
      } finally {
        nativePool.connect = currentConnect;
      }
    }

    async function ensureBoardPermission(): Promise<void> {
      if (boardPermissionActive) return;
      boardPermission = await grant(base.mainBoardId, 'moderation:read_reports');
      boardPermissionActive = true;
    }

    async function readCommittedReportEnvelope(reportId: string): Promise<Envelope> {
      const reportRoute = routeOf(reportId);
      if (reportRoute === null) throw new Error(`Report ${reportId} has no native route`);
      const partition = partitionOf(reportRoute);
      const source = (
        await growth!.admin.query<{ epoch: number; position: string }>(
          `SELECT epoch, position::text AS position FROM core.outbox
           WHERE partition_no=$1 AND subject=$2 AND type=$3 ORDER BY position DESC LIMIT 1`,
          [partition, reportId, reportCreated],
        )
      ).rows[0];
      if (!source) throw new Error(`Report ${reportId} did not commit its report.created event`);
      const consumer = `report_queue_${randomUUID().replaceAll('-', '')}`;
      await growth!.admin.query(
        `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
         VALUES($1,$2,$3,$4)`,
        [partition, consumer, source.epoch, (BigInt(source.position) - 1n).toString()],
      );
      const found: Envelope[] = [];
      const read = await readBatch(growth!.pool, {
        consumer,
        partition,
        envelopes: 1,
        apply: async (batch) => found.push(...batch),
      });
      if (read.status !== 'read' || found.length !== 1 || !found[0]!.events.some((event) => event.subject === reportId))
        throw new Error(`The committed report.created event for ${reportId} was not readable`);
      return found[0]!;
    }

    async function dispatch(reportId: string, boardId: string, phase: 'projection' | 'replay'): Promise<void> {
      const envelope = envelopes.get(reportId);
      if (!envelope) throw new Error(`Report ${reportId} has no committed envelope`);
      const measured = await capture(growth!, () => runner!.dispatch(envelope));
      const { rows, blocks, statements } = costOfCapture(measured.capture);
      runnerCaptures.push({ reportId, phase, rows, blocks, statements });
      const projected = await growth!.admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM content.board_report_candidate
         WHERE route=$1 AND board_id=$2 AND report_id=$3`,
        [routeOf(boardId), boardId, reportId],
      );
      if (phase === 'projection' && projected.rows[0]?.count !== 1)
        throw new Error(`Registered report projection did not place ${reportId} on board ${boardId}`);
      if (phase === 'replay' && projected.rows[0]?.count !== 1)
        throw new Error(`Registered report replay duplicated or lost ${reportId}`);
    }

    const boardRoute = routeOf(base.mainBoardId);
    if (boardRoute === null) throw new Error('Selected board has no native route');
    const initialBoardPermission = await grant(base.mainBoardId, 'moderation:read_reports');
    boardPermission = initialBoardPermission;
    boardPermissionActive = true;
    await grant(base.mainTarget.threadId, 'moderation:read_reports');
    await grant(base.mainTarget.postId, 'moderation:read_reports');
    await grant(base.mainTarget.postId, 'moderation:takedown');
    const foreign = await base.createRealmTarget(`Queue isolation ${randomUUID()}`, 'public');
    await grant(foreign.boardId, 'moderation:read_reports');
    await grant(foreign.threadId, 'moderation:read_reports');
    await grant(foreign.postId, 'moderation:read_reports');

    async function createReport(
      targetKind: QueueTargetKind,
      targetId: string,
      evidence: string,
      at?: string,
      expectedBoardId = base.mainBoardId,
    ): Promise<QueueReport> {
      const createdAt = new Date(at ?? new Date().toISOString()).toISOString();
      await base.system.clock.setCommandTime(createdAt);
      const body: Record<string, unknown> = {
        target: { kind: targetKind, id: targetId },
        reason: 'other',
        evidence,
      };
      if (targetKind === 'post') {
        const current = await base.call('GET', `/v1/posts/${targetId}`, { bearer: base.author.bearer });
        if (current.response.status !== 200 || typeof current.value?.post?.revisionId !== 'string')
          throw new Error(`Reported post ${targetId} had no current native revision`);
        body.revisionId = current.value.post.revisionId;
      }
      const result = await base.command<{ reportId: string }>('POST', '/v1/reports', body, {
        bearer: base.author.bearer,
      });
      const report: QueueReport = {
        id: result.reportId,
        targetKind,
        targetId,
        evidence,
        boardId: expectedBoardId,
        createdAt,
      };
      envelopes.set(report.id, await readCommittedReportEnvelope(report.id));
      await dispatch(report.id, expectedBoardId, 'projection');
      reports.set(report.id, report);
      return report;
    }

    const foreignReport = await createReport(
      'post',
      foreign.postId,
      `Foreign board evidence ${randomUUID()}`,
      undefined,
      foreign.boardId,
    );
    function selectedReportRoute(): number {
      const selected = [...reports.values()].find((report) => report.boardId === base.mainBoardId);
      const route = routeOf(selected?.id ?? foreignReport.id);
      if (route === null) throw new Error('Selected report has no native route');
      return route;
    }

    return {
      base,
      growth: growth!,
      runnerCaptures,
      reports,
      foreign,
      foreignReport,
      boardId: base.mainBoardId,
      threadId: base.mainTarget.threadId,
      postId: base.mainTarget.postId,
      pageLimit,
      async createReport(targetKind: QueueTargetKind, targetId: string, evidence: string, at?: string) {
        return createReport(targetKind, targetId, evidence, at);
      },
      async dismiss(reportId: string) {
        const result = await base.command<{ reportId: string; outcome: string }>(
          'POST',
          `/v1/reports/${reportId}:dismiss`,
          undefined,
          { bearer: base.other.bearer, expectedStatus: 200 },
        );
        if (result.outcome !== 'dismissed') throw new Error(`Report ${reportId} was not dismissed`);
      },
      async replay(reportId: string) {
        await dispatch(reportId, reports.get(reportId)?.boardId ?? base.mainBoardId, 'replay');
      },
      async callQueue(path: string, bearer = base.other.bearer): Promise<CallResult> {
        return base.call('GET', path, { bearer });
      },
      beginTrace(): QueueTrace {
        if (activeTrace) throw new Error('A board report queue trace is already active');
        activeTrace = { candidatePageQueries: 0, rawCandidateReferences: 0, reportSourceRows: 0, finalAuthorityRevoked: false };
        return activeTrace;
      },
      endTrace(): QueueTrace {
        const trace = activeTrace;
        activeTrace = undefined;
        if (!trace) throw new Error('No board report queue trace is active');
        return trace;
      },
      async ensureBoardPermission() {
        await ensureBoardPermission();
      },
      async revokeBoardPermission() {
        await revokeBoardPermission();
      },
      armFinalAuthorityLoss(): void {
        if (!boardPermissionActive) throw new Error('Final authority loss needs a live board grant');
        if (finalRevocation) throw new Error('Final authority loss is already armed');
        finalRevocation = revokeBoardPermission;
      },
      async growCandidates(admin: Pool, scale: number, previous: number) {
        await seedUnrelatedCandidates(admin, {
          boardRoute,
          selectedReportRoute: selectedReportRoute(),
          targetRoute: routeOf(base.mainTarget.postId)!,
          scale,
          previous,
        });
      },
      async growHistories(admin: Pool, scale: number, previous: number) {
        await seedUnrelatedHistory(admin, {
          selectedReportRoute: selectedReportRoute(),
          targetRoute: routeOf(base.mainTarget.postId)!,
          reporterAccountId: base.author.accountId,
          clientId: base.system.actors.author.actor.clientId,
          scale,
          previous,
        });
      },
      async close() {
        if (routedConnect) nativePool.connect = originalConnect;
        try {
          await runner?.close();
        } finally {
          try {
            await base.system.close();
          } finally {
            await growth?.close();
          }
        }
      },
    };
  } catch (error) {
    if (routedConnect) nativePool.connect = originalConnect;
    try {
      await runner?.close();
    } finally {
      try {
        await base.system.close();
      } finally {
        await growth?.close();
      }
    }
    throw error;
  }
}

async function startRegisteredContentRunner(
  base: ReactionRelayBase,
  pool: Pool,
  databaseUrl: string,
) {
  const client = await createWorkClient(databaseUrl, pool);
  const registered: Effect[] = [];
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    await DBOS.shutdown({ deregister: true });
    const module: WorkModule = {
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
    };
    work = await composeWork([module], {
      databaseUrl,
      pool,
      client,
      executorId: `report-queue-growth-${randomUUID()}`,
      env: workerTestEnv({
        KERNEL_ROUTE_KEY: Buffer.from(base.system.routeKey).toString('base64url'),
        CONTENT_TEST_COLLECTION_PARTITIONS: '0',
      }),
    });
    if (!registered.some((effect) => effect.name === 'content_report_target' && effect.types.includes(reportCreated)))
      throw new Error('Registered Content runtime omitted content_report_target');
    await work.launch();
    return {
      async dispatch(envelope: Envelope): Promise<void> {
        await work!.effects.enqueue([envelope]);
        for (const [index, event] of envelope.events.entries()) {
          for (const effect of registered.filter((candidate) => candidate.types.includes(event.type)))
            await client
              .retrieveWorkflow(effectWorkflowId(envelope, index, effect.name))
              .getResult({ pollingIntervalMs: 10 });
        }
      },
      async close(): Promise<void> {
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

function queryText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string') return value.text;
  return '';
}

function queryRows(value: unknown): number {
  return typeof value === 'object' && value !== null && 'rows' in value && Array.isArray(value.rows)
    ? value.rows.length
    : 0;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function costOfCapture(captureResult: Awaited<ReturnType<typeof capture>>['capture']) {
  const cost = costOf(captureResult);
  return {
    rows: cost.rows,
    blocks: cost.blocks,
    statements: captureResult.statements.length,
  };
}

async function seedUnrelatedCandidates(
  admin: Pool,
  input: {
    boardRoute: number;
    selectedReportRoute: number;
    targetRoute: number;
    scale: number;
    previous: number;
  },
): Promise<void> {
  const rows = Array.from({ length: input.scale - input.previous }, (_, offset) => {
    const ordinal = input.previous + offset;
    const route = ordinal % 2 === 0 ? input.boardRoute : input.boardRoute ^ 0x10;
    const reportRoute = ordinal % 2 === 0 ? input.selectedReportRoute : input.selectedReportRoute ^ 0x10;
    return {
      route,
      boardId: newId(route),
      reportRoute,
      reportId: newId(reportRoute),
      targetKind: (['board', 'thread', 'post'] as const)[ordinal % 3]!,
      targetId: newId(input.targetRoute),
      createdAt: new Date(Date.UTC(2025, 0, 1) + ordinal).toISOString(),
    };
  });
  if (!rows.length) return;
  await admin.query(
    `INSERT INTO content.board_report_candidate
       (route,board_id,report_route,report_id,target_kind,target_id,created_at)
     SELECT route,board_id,report_route,report_id,target_kind,target_id,created_at
     FROM unnest($1::integer[],$2::uuid[],$3::integer[],$4::uuid[],$5::text[],$6::uuid[],$7::timestamptz[])
       AS row(route,board_id,report_route,report_id,target_kind,target_id,created_at)`,
    [
      rows.map((row) => row.route),
      rows.map((row) => row.boardId),
      rows.map((row) => row.reportRoute),
      rows.map((row) => row.reportId),
      rows.map((row) => row.targetKind),
      rows.map((row) => row.targetId),
      rows.map((row) => row.createdAt),
    ],
  );
}

async function seedUnrelatedHistory(
  admin: Pool,
  input: {
    selectedReportRoute: number;
    targetRoute: number;
    reporterAccountId: string;
    clientId: string;
    scale: number;
    previous: number;
  },
): Promise<void> {
  const rows: ReportGrowthRow[] = Array.from({ length: input.scale - input.previous }, (_, offset) => {
    const ordinal = input.previous + offset;
    const reportRoute = ordinal % 2 === 0 ? input.selectedReportRoute : input.selectedReportRoute ^ 0x10;
    const targetRoute = ordinal % 2 === 0 ? input.targetRoute : input.targetRoute ^ 0x10;
    return {
      reportId: newId(reportRoute),
      reportRoute,
      targetKind: 'post',
      targetId: newId(targetRoute),
      targetRoute,
      createdAt: new Date(Date.UTC(2025, 0, 1) + ordinal).toISOString(),
      transactionId: randomUUID(),
      idempotencyKey: `queue-growth-${randomUUID()}`,
      reporterAccountId: input.reporterAccountId,
    };
  });
  if (!rows.length) return;
  await seedReportGrowth(admin, rows, [], {
    projectTargets: false,
    commandEvents: {
      principalId: input.reporterAccountId,
      principalKind: 'account',
      clientId: input.clientId,
    },
  });
}
