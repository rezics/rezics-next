import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import readReport from '../../src/content/read-report.sql';
import upsertReportTarget from '../../src/content/upsert-report-target.sql';
import readLog from '../../src/events/read-log.sql';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthReport,
} from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  createGrowthReportNativeRelayFixture,
  seedAxis,
  seedOutboxHistory,
  type ReportPlan,
  type ReportRelayRuntime,
  type ReportSource,
} from './support/growth-report-native-relay-fixture.ts';

const scales = [64, 512, 4096] as const;
const repetitions = 3;
const warmups = 1;
const runsPerScale = repetitions + warmups;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const sourceType = 'com.rezics.content.report.created.v1';
const projectedType = 'com.rezics.content.report-target.projected.v1';
const unrelatedSourceRoute = 0x4a11;
const usedTargetPartitions = new Set<number>([partitionOf(unrelatedSourceRoute)]);
const usedBoardPartitions = new Set<number>();
const usedSourcePartitions = new Set<number>();

let fixture: Awaited<ReturnType<typeof createGrowthReportNativeRelayFixture>>;
let db: GrowthDatabase;
let relay: ReportRelayRuntime | undefined;
let kernel: ReturnType<typeof fixture.kernelFor>;

beforeAll(async () => {
  fixture = await createGrowthReportNativeRelayFixture();
  try {
    const databaseUrl = fixture.base.system.database.pool.options.connectionString!;
    db = await openGrowthDatabase(databaseUrl);
    kernel = fixture.kernelFor(db.pool);
    relay = await fixture.startRelay(db.pool, databaseUrl);
    await relay.drainToHead();
  } catch (error) {
    try {
      await relay?.stop();
    } finally {
      await db?.close();
      await fixture.close();
    }
    throw error;
  }
}, 120_000);

afterAll(async () => {
  try {
    await relay?.stop();
  } finally {
    try {
      await db?.close();
    } finally {
      await fixture?.close();
    }
  }
});

type Axis = 'source' | 'target' | 'outbox';
type RunInput = Readonly<{ plan: ReportPlan; evidence: string }>;
type RawObservation = Readonly<{ operation: string; statements: readonly string[] }>;

async function planRuns(
  usedTargetPartitions: Set<number>,
  usedBoardPartitions: Set<number>,
  usedSourcePartitions: Set<number>,
  runOffset: number,
  inputs: Map<number, RunInput>,
  forbiddenSourcePartitions: ReadonlySet<number> = new Set([partitionOf(unrelatedSourceRoute)]),
): Promise<ReportPlan[]> {
  const plans: ReportPlan[] = [];
  for (let index = 0; index < runsPerScale; index++) {
    const target = await fixture.newTarget(usedTargetPartitions, usedBoardPartitions);
    const plan = fixture.planForTarget(target, usedSourcePartitions, forbiddenSourcePartitions);
    plans.push(plan);
    inputs.set(runOffset + index, { plan, evidence: `Private report evidence ${randomUUID()}` });
  }
  return plans;
}

async function createSelectedSource(
  input: RunInput,
  sources: Map<number, ReportSource>,
  repetition: number,
): Promise<ReportSource> {
  await relay!.drainToHead();
  const submitted = await fixture.submit(kernel, input.plan, input.evidence);
  expect(submitted.status).toBe(201);
  expect(Object.keys(submitted.value ?? {}).sort()).toEqual(['reportId']);
  const reportId = submitted.value?.reportId;
  expect(typeof reportId).toBe('string');
  const source = await fixture.captureSource(db.pool, input.plan, reportId as string, input.evidence);
  expect(source.event.type).toBe(sourceType);
  expect(source.event.data).toEqual({
    reportId,
    targetKind: 'post',
    targetId: input.plan.target.postId,
  });
  expect(JSON.stringify(source.event)).not.toContain(input.evidence);
  expect(JSON.stringify(source.event)).not.toContain(fixture.reporter.accountId);
  sources.set(repetition, source);
  return source;
}

function recordGrowth(name: string, report: GrowthReport): void {
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    expect(sample.repetitions).toHaveLength(repetitions);
    for (const cost of sample.repetitions) {
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.rows).toBeGreaterThan(0);
      expect(cost.blocks).toBeGreaterThan(0);
      expect(cost.plans).toBeGreaterThan(0);
      expect(cost.sharedHit + cost.sharedRead).toBeGreaterThan(0);
    }
  }
  console.log(
    JSON.stringify({
      name,
      observations: report.samples.map(({ scale, seeding, repetitions: runs }) => ({
        scale,
        seeding,
        repetitions: runs.map(({ rows, blocks, statements, sharedHit, sharedRead }) => ({
          rows,
          blocks,
          statements,
          sharedHit,
          sharedRead,
        })),
      })),
    }),
  );
}

async function verifyProjected(sources: readonly ReportSource[]): Promise<void> {
  for (const source of sources) {
    const { plan, reportId, evidence, envelope, eventSeq, event } = source;
    const sourceRow = await db.admin.query<{ evidence: string; reporter_account_id: string; created_at: string }>(
      'SELECT evidence,reporter_account_id::text,created_at::text FROM content.report WHERE route=$1 AND report_id=$2',
      [routeOf(reportId), reportId],
    );
    expect(sourceRow.rows).toHaveLength(1);
    expect(sourceRow.rows[0]).toMatchObject({ evidence, reporter_account_id: fixture.reporter.accountId });

    const targetRows = await db.admin.query<{
      target_kind: string;
      target_id: string;
      report_route: number;
      report_id: string;
      created_at: string;
    }>(
      `SELECT target_kind,target_id,report_route,report_id,created_at::text
       FROM content.report_target
       WHERE route=$1 AND target_kind='post' AND target_id=$2 AND report_route=$3 AND report_id=$4`,
      [routeOf(plan.target.postId), plan.target.postId, routeOf(reportId), reportId],
    );
    expect(targetRows.rows).toHaveLength(1);
    expect(targetRows.rows[0]).toMatchObject({
      target_kind: 'post',
      target_id: plan.target.postId,
      report_id: reportId,
    });
    expect(targetRows.rows[0]!.created_at).toBe(sourceRow.rows[0]!.created_at);

    const queue = await db.admin.query<{ workflow_id: string; state: string }>(
      `SELECT workflow_id,state FROM core.history_event_consumer
       WHERE partition_no=$1 AND position=$2 AND event_seq=$3 AND consumer=$4`,
      [envelope.partition, envelope.position.toString(), eventSeq, fixture.reportEffectName],
    );
    expect(queue.rows).toEqual([
      {
        workflow_id: `fx:${envelope.epoch}:${envelope.partition}:${envelope.position}:${eventSeq}:${fixture.reportEffectName}`,
        state: 'completed',
      },
    ]);

    const projections = await db.admin.query<{ partition_no: number; subject: string; data: unknown }>(
      `SELECT partition_no,subject,data FROM core.outbox
       WHERE type=$1 AND data->>'reportId'=$2 ORDER BY partition_no,position,event_seq`,
      [projectedType, reportId],
    );
    expect(projections.rows).toEqual(
      [
        { partition_no: partitionOf(plan.target.postRoute), subject: plan.target.postId, data: event.data },
        { partition_no: partitionOf(plan.target.boardRoute), subject: plan.target.boardId, data: event.data },
      ].sort((left, right) => left.partition_no - right.partition_no),
    );
    expect(JSON.stringify(projections.rows)).not.toContain(evidence);
    expect(JSON.stringify(projections.rows)).not.toContain(fixture.reporter.accountId);

    const visible = await kernel.handle(
      new Request(`https://content.test/v1/posts/${plan.target.postId}`, {
        headers: { authorization: `Bearer ${fixture.base.other.bearer}` },
      }),
    );
    expect(visible.status).toBe(200);
    const visibleBody = await visible.text();
    expect(visibleBody).not.toContain(evidence);
    expect(visibleBody).not.toContain(fixture.reporter.accountId);
  }
}

async function runSubmissionGrowth(): Promise<void> {
  const inputs = new Map<number, RunInput>();
  const reportIds = new Map<number, string>();
  const operationSql: RawObservation[] = [];
  let runOffset = 0;
  const observer = observeSql(db.pool);
  let report: GrowthReport;
  try {
    report = await checkGrowth(db, {
      name: 'Native report submission via POST /v1/reports',
      scales,
      repetitions,
      warmups,
      bounds,
      async grow(database, scale, _previous) {
        const plans = await planRuns(
          usedTargetPartitions,
          usedBoardPartitions,
          usedSourcePartitions,
          runOffset,
          inputs,
        );
        runOffset += plans.length;
        await seedAxis(database.admin, 'source', plans, scale, unrelatedSourceRoute);
        await relay!.drainToHead();
      },
      async warmup(_database, _scale, repetition) {
        const input = inputs.get(repetition);
        if (!input) throw new Error(`Missing report submission fixture ${repetition}`);
        const submitted = await fixture.submit(kernel, input.plan, input.evidence);
        expect(submitted.status).toBe(201);
        expect(Object.keys(submitted.value ?? {}).sort()).toEqual(['reportId']);
        reportIds.set(repetition, String(submitted.value!.reportId));
      },
      async operation(_database, _scale, repetition) {
        const input = inputs.get(repetition);
        if (!input) throw new Error(`Missing report submission fixture ${repetition}`);
        const offset = observer.records.length;
        const submitted = await fixture.submit(kernel, input.plan, input.evidence);
        expect(submitted.status).toBe(201);
        expect(Object.keys(submitted.value ?? {}).sort()).toEqual(['reportId']);
        const reportId = String(submitted.value!.reportId);
        reportIds.set(repetition, reportId);
        operationSql.push({
          operation: 'submission',
          statements: observer.records.slice(offset).map(({ statement }) => statement),
        });
      },
    });
  } finally {
    await observer.close();
  }
  recordGrowth('Native report submission via POST /v1/reports', report);
  assertGrowthAccessPaths(report.name, report.samples, ['content.report', 'core.receipt', 'core.outbox']);
  for (const run of operationSql) {
    expect(run.statements.some((statement) => statement.includes('INSERT INTO content.report'))).toBe(true);
    expect(run.statements).not.toContain(readReport.sql);
    expect(run.statements).not.toContain(upsertReportTarget.sql);
    expect(run.statements).not.toContain(readLog.sql);
  }
  for (const [repetition, reportId] of reportIds) {
    const input = inputs.get(repetition)!;
    expect(routeOf(reportId)).toBe(input.plan.route);
    const row = await db.admin.query<{ evidence: string; reporter_account_id: string }>(
      'SELECT evidence,reporter_account_id::text FROM content.report WHERE route=$1 AND report_id=$2',
      [routeOf(reportId), reportId],
    );
    expect(row.rows).toEqual([{ evidence: input.evidence, reporter_account_id: fixture.reporter.accountId }]);
    const sourceEvent = await db.admin.query<{ data: unknown }>(
      'SELECT data FROM core.outbox WHERE partition_no=$1 AND type=$2 AND subject=$3',
      [partitionOf(routeOf(reportId)!), sourceType, reportId],
    );
    expect(sourceEvent.rows).toHaveLength(1);
    expect(sourceEvent.rows[0]!.data).toEqual({ reportId, targetKind: 'post', targetId: input.plan.target.postId });
    const projection = await db.admin.query(
      'SELECT 1 FROM content.report_target WHERE route=$1 AND target_kind=$2 AND target_id=$3 AND report_route=$4 AND report_id=$5',
      [routeOf(input.plan.target.postId), 'post', input.plan.target.postId, routeOf(reportId), reportId],
    );
    expect(projection.rows).toHaveLength(0);
  }
}

async function runRelayGrowth(axis: Axis, replayOnly = false): Promise<ReportSource[]> {
  const inputs = new Map<number, RunInput>();
  const sources = new Map<number, ReportSource>();
  const operationSql: RawObservation[] = [];
  let runOffset = 0;
  const observer = observeSql(db.pool);
  let report: GrowthReport;
  try {
    report = await checkGrowth(db, {
      name: replayOnly
        ? 'Exact native report source replay through the registered effects relay'
        : `Native report projection through the registered effects relay with unrelated ${axis} history`,
      scales,
      repetitions,
      warmups,
      bounds,
      async grow(database, scale, _previous) {
        const plans = await planRuns(
          usedTargetPartitions,
          usedBoardPartitions,
          usedSourcePartitions,
          runOffset,
          inputs,
        );
        runOffset += plans.length;
        if (axis === 'outbox') {
          for (const plan of plans)
            await seedOutboxHistory(
              database.admin,
              partitionOf(plan.route),
              plan.route,
              routeOf(plan.target.postId)!,
              scale,
            );
        } else {
          await seedAxis(database.admin, axis, plans, scale, unrelatedSourceRoute);
        }
        await relay!.drainToHead();
      },
      async warmup(_database, _scale, repetition) {
        const input = inputs.get(repetition);
        if (!input) throw new Error(`Missing native report fixture ${repetition}`);
        const source = await createSelectedSource(input, sources, repetition);
        await relay!.project(source);
        if (replayOnly) {
          await relay!.rewind(source);
          await relay!.replay(source);
        }
      },
      async prepare(_database, _scale, repetition) {
        const input = inputs.get(repetition);
        if (!input) throw new Error(`Missing native report fixture ${repetition}`);
        const source = await createSelectedSource(input, sources, repetition);
        if (replayOnly) {
          await relay!.project(source);
          await relay!.rewind(source);
        }
      },
      async operation(_database, _scale, repetition) {
        const source = sources.get(repetition);
        if (!source) throw new Error(`Missing selected report source ${repetition}`);
        const offset = observer.records.length;
        const exactSource = structuredClone(source.event);
        if (replayOnly) await relay!.replay(source);
        else await relay!.project(source);
        expect(source.event).toEqual(exactSource);
        operationSql.push({
          operation: replayOnly ? 'exact source replay' : 'registered relay projection',
          statements: observer.records.slice(offset).map(({ statement }) => statement),
        });
      },
    });
  } finally {
    await observer.close();
  }

  recordGrowth(report.name, report);
  const relations = [
    'content.report',
    'content.report_target',
    'content.board_report_candidate',
    'core.outbox',
    'core.consumer_checkpoint',
    'core.history_event_consumer',
  ];
  assertGrowthAccessPaths(report.name, report.samples, relations);
  for (const run of operationSql) {
    expect(run.statements).toContain(readLog.sql);
    expect(run.statements.some((statement) => statement.includes('core.history_event_consumer'))).toBe(true);
    if (replayOnly) {
      expect(run.statements).not.toContain(readReport.sql);
      expect(run.statements).not.toContain(upsertReportTarget.sql);
    } else {
      expect(run.statements).toContain(readReport.sql);
      expect(run.statements).toContain(upsertReportTarget.sql);
    }
  }
  const observed = [...sources.values()];
  await verifyProjected(observed);
  return observed;
}

async function runDeniedAndEmptyGrowth(): Promise<void> {
  const plan = fixture.planForTarget(
    fixture.base.mainTarget,
    usedSourcePartitions,
    new Set([partitionOf(unrelatedSourceRoute)]),
  );
  const partition = partitionOf(plan.route);
  const operationSql: RawObservation[] = [];
  const observer = observeSql(db.pool);
  let report: GrowthReport;
  try {
    report = await checkGrowth(db, {
      name: 'Denied native report submission and empty registered relay with retained outbox history',
      scales,
      repetitions,
      warmups,
      bounds,
      async grow(database, scale, previous) {
        await seedOutboxHistory(
          database.admin,
          partition,
          plan.route,
          routeOf(fixture.base.mainTarget.postId)!,
          scale - previous,
        );
        await relay!.drainToHead();
      },
      async operation(_database, _scale, repetition) {
        const offset = observer.records.length;
        const denied = await fixture.submit(kernel, plan, `Denied private evidence ${repetition}`);
        expect(denied.status).toBe(403);
        await relay!.scanEmpty(partition);
        operationSql.push({
          operation: 'denied request plus empty relay batch',
          statements: observer.records.slice(offset).map(({ statement }) => statement),
        });
      },
    });
  } finally {
    await observer.close();
  }
  recordGrowth('Denied native report submission and empty registered relay', report);
  assertGrowthAccessPaths(report.name, report.samples, ['core.outbox', 'core.consumer_checkpoint']);
  for (const run of operationSql) expect(run.statements).toContain(readLog.sql);
  const reportRows = await db.admin.query('SELECT 1 FROM content.report WHERE route=$1 AND reporter_account_id=$2', [
    plan.route,
    fixture.reporter.accountId,
  ]);
  expect(reportRows.rows).toHaveLength(0);
}

test('Native reports submit separately and project through registered effects under independent history growth', async () => {
  await runSubmissionGrowth();
  await runRelayGrowth('source');
  await runRelayGrowth('target');
  await runRelayGrowth('outbox');
  await runRelayGrowth('outbox', true);
  await runDeniedAndEmptyGrowth();
}, 600_000);
