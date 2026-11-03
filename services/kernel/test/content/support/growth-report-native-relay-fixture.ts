import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createKernel } from '../../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { registerContent } from '../../../src/content/register.ts';
import { effectsRelay, effectWorkflowId, type Effect } from '../../../src/events/effects.ts';
import { readBatch, type CloudEvent, type Envelope } from '../../../src/events/log.ts';
import { startRelays } from '../../../src/events/relays.ts';
import { normalizeCommandKey, principalCommandIdentity } from '../../../src/command/command.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { seedReportGrowth, type ReportGrowthRow } from './report-growth.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import {
  createReactionRelayBase,
  type CreatedRealmTarget,
  type ReactionTarget,
} from '../reaction-relay-convergence-fixture.ts';

const reportEventType = 'com.rezics.content.report.created.v1';
const projectedEventType = 'com.rezics.content.report-target.projected.v1';
const effectName = 'content_report_target';
const writeRate = createWriteRateLimiter({
  secret: 'growth-report-native-relay-write-rate-secret-at-least-32-bytes',
  overrides: JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } }),
});

export type ReportPlan = Readonly<{ target: ReactionTarget; key: string; route: number }>;
export type ReportSource = Readonly<{
  plan: ReportPlan;
  reportId: string;
  evidence: string;
  envelope: Envelope;
  event: CloudEvent;
  eventSeq: number;
  effectsBefore: { epoch: number | null; position: bigint };
}>;

export type ReportKernel = ReturnType<typeof createKernel>;
export type ReportRelayRuntime = Readonly<{
  drainToHead(): Promise<void>;
  project(source: ReportSource): Promise<void>;
  replay(source: ReportSource): Promise<void>;
  rewind(source: ReportSource): Promise<void>;
  scanEmpty(partition: number): Promise<Readonly<{ status: 'read'; envelopes: number; position: bigint }>>;
  stop(): Promise<void>;
}>;

export async function createGrowthReportNativeRelayFixture() {
  const base = await createReactionRelayBase();
  try {
    const sourcePool = base.system.database.pool;
    const reporterResult = await base.system.access.authenticate(base.other.bearer, {
      pool: sourcePool,
      deadline: Date.now() + 600_000,
    });
    if (reporterResult.kind !== 'account') throw new Error('Native report fixture requires an account reporter');
    const reporter = reporterResult;

    function kernelFor(pool: Pool): ReportKernel {
      return createKernel({
        pool,
        access: base.system.access,
        routeKey: base.system.routeKey,
        tokens: base.system.tokenKeys,
        writeRate,
      });
    }

    async function newTarget(usedTargetPartitions: Set<number>, usedBoardPartitions: Set<number>) {
      for (let attempt = 0; attempt < 4096; attempt++) {
        const target = await base.createRealmTarget(`Growth report target ${randomUUID()}`, 'public');
        const targetPartition = partitionOf(target.postRoute);
        const boardPartition = partitionOf(target.boardRoute);
        if (
          targetPartition === boardPartition ||
          partitionOf(target.threadRoute) === boardPartition ||
          usedTargetPartitions.has(targetPartition) ||
          usedBoardPartitions.has(boardPartition)
        )
          continue;
        usedTargetPartitions.add(targetPartition);
        usedBoardPartitions.add(boardPartition);
        await base.command(
          'POST',
          '/v1/grants',
          {
            resource: { route: target.postRoute, id: target.postId },
            subject: { kind: 'account', id: reporter.accountId },
            actions: ['report:create'],
            valid: '(,)',
          },
          { bearer: base.governance.bearer },
        );
        return target;
      }
      throw new Error('Could not provision a distinct report target partition');
    }

    function routeForKey(key: string): number {
      const { principal } = principalCommandIdentity(reporter);
      return anchorRoute(
        base.system.routeKey,
        JSON.stringify([principal.kind, principal.id, 'content.report.create', normalizeCommandKey(principal, key)]),
      );
    }

    function planForTarget(
      target: ReactionTarget,
      usedSourcePartitions: Set<number>,
      forbiddenSourcePartitions: ReadonlySet<number> = new Set(),
      requiredRoute?: number,
    ): ReportPlan {
      for (let attempt = 0; attempt < 1_000_000; attempt++) {
        const key = randomUUID();
        const route = routeForKey(key);
        const partition = partitionOf(route);
        if (
          (requiredRoute !== undefined && route !== requiredRoute) ||
          partition === partitionOf(target.postRoute) ||
          partition === partitionOf(target.boardRoute) ||
          usedSourcePartitions.has(partition) ||
          forbiddenSourcePartitions.has(partition)
        )
          continue;
        usedSourcePartitions.add(partition);
        return { target, key, route };
      }
      throw new Error('Could not find a distinct native report source partition');
    }

    async function submit(
      kernel: ReportKernel,
      plan: ReportPlan,
      evidence = `Private report evidence ${randomUUID()}`,
    ) {
      const response = await kernel.handle(
        new Request('https://content.test/v1/reports', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${base.other.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(plan.key),
          },
          body: JSON.stringify({
            target: { kind: 'post', id: plan.target.postId },
            reason: 'other',
            evidence,
          }),
        }),
      );
      const text = await response.text();
      let value: Record<string, unknown> | null = null;
      if (text) {
        try {
          value = JSON.parse(text) as Record<string, unknown>;
        } catch {
          value = null;
        }
      }
      return { status: response.status, text, value, evidence };
    }

    async function captureSource(
      pool: Pool,
      plan: ReportPlan,
      reportId: string,
      evidence: string,
    ): Promise<ReportSource> {
      const partition = partitionOf(plan.route);
      const checkpoint = (
        await pool.query<{ epoch: number | null; position: string }>(
          "SELECT epoch,position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer='effects'",
          [partition],
        )
      ).rows[0];
      const effectsBefore = checkpoint
        ? { epoch: checkpoint.epoch, position: BigInt(checkpoint.position) }
        : { epoch: null, position: 0n };
      const consumer = `report_capture_${randomUUID().replaceAll('-', '')}`;
      await pool.query(
        'INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position) VALUES ($1,$2,$3,$4)',
        [partition, consumer, effectsBefore.epoch, effectsBefore.position.toString()],
      );
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
        throw new Error('Native report API did not append one source envelope');
      const envelope = envelopes[0]!;
      const eventSeq = envelope.events.findIndex(
        (event) => event.type === reportEventType && event.subject === reportId,
      );
      if (eventSeq < 0) throw new Error(`Native report source event was not found for ${reportId}`);
      const event = envelope.events[eventSeq]!;
      if (routeOf(reportId) !== plan.route || envelope.partition !== partition)
        throw new Error('Native report source route did not match its selected route');
      return { plan, reportId, evidence, envelope, event, eventSeq, effectsBefore };
    }

    return {
      base,
      reporter,
      reportEffectName: effectName,
      kernelFor,
      newTarget,
      planForTarget,
      submit,
      captureSource,
      async startRelay(pool: Pool, databaseUrl: string) {
        const client = await createWorkClient(databaseUrl, pool);
        const registered: Effect[] = [];
        let work: Awaited<ReturnType<typeof composeWork>> | undefined;
        let relays: ReturnType<typeof startRelays> | undefined;
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
              executorId: `growth-report-native-relay-${randomUUID()}`,
              env: workerTestEnv({
                KERNEL_ROUTE_KEY: Buffer.from(base.system.routeKey).toString('base64url'),
                CONTENT_TEST_COLLECTION_PARTITIONS: '0',
              }),
            },
          );
          await work.launch();
          const effect = registered.find((candidate) => candidate.name === effectName);
          if (!effect || !effect.types.includes(reportEventType))
            throw new Error('Content work did not register the native report-target effect');
          const handler = effectsRelay(pool, work.effects);
          relays = startRelays(pool, [handler], { intervalMs: 5, concurrency: 1, paused: true });

          async function waitFor(predicate: () => Promise<boolean>, detail: string): Promise<void> {
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
              if (await predicate()) return;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error(`Timed out waiting for ${detail}`);
          }

          async function waitForCheckpoint(partition: number, position: bigint): Promise<void> {
            await waitFor(async () => {
              const row = (
                await pool.query<{ position: string }>(
                  "SELECT position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer='effects'",
                  [partition],
                )
              ).rows[0];
              return row !== undefined && BigInt(row.position) >= position;
            }, `effects relay checkpoint ${partition}:${position}`);
          }

          async function waitForDrain(): Promise<void> {
            await waitFor(async () => {
              const pending = await pool.query<{ pending: boolean }>(
                `SELECT EXISTS (
                   SELECT 1 FROM core.outbox AS outbox
                   LEFT JOIN core.consumer_checkpoint AS checkpoint
                     ON checkpoint.partition_no=outbox.partition_no AND checkpoint.consumer='effects'
                   WHERE checkpoint.position IS NULL OR checkpoint.position < outbox.position
                 ) AS pending`,
              );
              if (pending.rows[0]!.pending) return false;
              const open = await pool.query<{ open: boolean }>(
                `SELECT EXISTS (
                   SELECT 1 FROM core.history_event_consumer
                   WHERE consumer=ANY($1::text[]) AND state='open'
                 ) AS open`,
                [registered.map(({ name }) => name)],
              );
              return !open.rows[0]!.open;
            }, 'registered effects relay to drain existing work');
          }

          async function runSelected(source: ReportSource): Promise<void> {
            const workflowId = effectWorkflowId(source.envelope, source.eventSeq, effectName);
            relays!.resume();
            try {
              await waitForCheckpoint(source.envelope.partition, source.envelope.position);
              await client.retrieveWorkflow(workflowId).getResult({ pollingIntervalMs: 10 });
            } finally {
              await relays!.pause();
            }
          }

          return {
            async drainToHead() {
              relays!.resume();
              try {
                await waitForDrain();
              } finally {
                await relays!.pause();
              }
            },
            async project(source: ReportSource) {
              await runSelected(source);
            },
            async replay(source: ReportSource) {
              await runSelected(source);
            },
            async rewind(source: ReportSource) {
              const partition = source.envelope.partition;
              await pool.query(
                `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
                 VALUES ($1,'effects',$2,$3)
                 ON CONFLICT (partition_no,consumer) DO UPDATE SET epoch=EXCLUDED.epoch,position=EXCLUDED.position`,
                [partition, source.effectsBefore.epoch, source.effectsBefore.position.toString()],
              );
            },
            async scanEmpty(partition: number) {
              const result = await handler.run(partition);
              if (result.status !== 'read' || result.envelopes !== 0)
                throw new Error('Expected the registered report relay to read an empty batch');
              return result;
            },
            async stop() {
              try {
                await relays?.stop();
              } finally {
                try {
                  await work?.shutdown();
                } finally {
                  await client.close();
                }
              }
            },
          };
        } catch (error) {
          try {
            await relays?.stop();
          } finally {
            try {
              await work?.shutdown();
            } finally {
              await client.close();
            }
          }
          throw error;
        }
      },
      async close() {
        await base.system.close();
      },
    };
  } catch (error) {
    await base.system.close();
    throw error;
  }
}

export function sourceRows(count: number, route: number, targetRoute: number): ReportGrowthRow[] {
  return Array.from({ length: count }, () => ({
    reportId: newId(route),
    reportRoute: route,
    targetKind: 'post',
    targetId: newId(targetRoute),
    targetRoute,
    createdAt: '2026-10-27T00:00:00.000Z',
    transactionId: randomUUID(),
    idempotencyKey: `native-report-growth-${randomUUID()}`,
  }));
}

export async function seedOutboxHistory(
  pool: Pool,
  partition: number,
  reportRoute: number,
  targetRoute: number,
  count: number,
): Promise<void> {
  if (count === 0) return;
  const state = (
    await pool.query<{ position: string; epoch: number }>(
      'SELECT position::text,epoch FROM core.partition WHERE partition_no=$1',
      [partition],
    )
  ).rows[0];
  if (!state) throw new Error(`Missing outbox partition ${partition}`);
  const start = BigInt(state.position);
  const positions = Array.from({ length: count }, (_, index) => (start + BigInt(index + 1)).toString());
  const eventIds = positions.map(() => randomUUID());
  const reportIds = positions.map(() => newId(reportRoute));
  const targetIds = positions.map(() => newId(targetRoute));
  await pool.query(
    `INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
     SELECT $1,position::bigint,0,1,$2,event_id,'${projectedEventType}',report_id::text,
            jsonb_build_object('reportId',report_id,'targetKind','post','targetId',target_id)
     FROM unnest($3::bigint[],$4::uuid[],$5::uuid[],$6::uuid[])
       AS row(position,event_id,report_id,target_id)`,
    [partition, state.epoch, positions, eventIds, reportIds, targetIds],
  );
  await pool.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
    partition,
    (start + BigInt(count)).toString(),
  ]);
}

export async function seedAxis(
  pool: Pool,
  axis: 'source' | 'target',
  plans: readonly ReportPlan[],
  count: number,
  unrelatedSourceRoute: number,
): Promise<void> {
  const rows: ReportGrowthRow[] = [];
  for (const plan of plans) {
    const targetRoute = routeOf(plan.target.postId)!;
    const reportRoute = axis === 'source' ? plan.route : unrelatedSourceRoute;
    rows.push(...sourceRows(count, reportRoute, targetRoute));
  }
  await seedReportGrowth(pool, rows, [], { projectTargets: axis === 'target' });
}
