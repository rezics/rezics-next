import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { WORK_APPLICATION, createWorkClient } from '../../src/work/client.ts';
import {
  classifyRetentionStatement,
  retentionBatchWork,
  retentionPayloadFanoutInventory,
  retentionSweepWork,
  type WorkflowRetentionSelection,
} from '../../src/work/core/index.ts';
import {
  runWorkflowRetentionBatch,
  runWorkflowRetentionSweep,
  type WorkflowRetentionSelector,
} from '../../src/work/retention.ts';
import {
  WORKFLOW_RETENTION_SELECTOR_INDEX,
  createWorkflowRetentionSelector,
} from '../../src/work/retention-selector.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase, type GrowthReport } from '../support/growth.ts';
import {
  expectedRetentionInventory,
  insertRetentionPayload,
  UNIT_RETENTION_PAYLOAD,
  type RetentionPayloadFanout,
} from './support/retention-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [64, 512, 4096] as const;
const payloadScales = [1, 8, 64] as const;
const historyRowsPerUnit = 16;
const shortBatch = 10;
const fullBatch = 1000;
const sweepRemainder = 10;
const origin = Date.now();
const dayMs = 24 * 60 * 60 * 1000;
const now = new Date(origin);
const prefix = `retention-growth:${crypto.randomUUID()}:`;

let db: GrowthDatabase;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let select: WorkflowRetentionSelector;
const planDocuments: unknown[] = [];
const selectionBinds: WorkflowRetentionSelection[] = [];

type PlanEvidence = { readonly query: string; readonly plan: unknown };
type RunEvidence = { readonly scale: number; readonly repetition: number; readonly plans: readonly PlanEvidence[] };

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  observePlans(db.pool);
  client = await createWorkClient(databaseUrl, db.pool);
  const inner = createWorkflowRetentionSelector(db.pool);
  select = async (input) => {
    selectionBinds.push(input);
    return inner(input);
  };
  await seed(db, 'planner-floor', 32_768, 0, {
    application: 'retention.growth.floor',
    status: 'SUCCESS',
    createdAt: origin - 400 * dayMs,
    completedAt: origin - 400 * dayMs,
  });
  await db.admin.query('ANALYZE dbos.workflow_status');
});

afterAll(async () => {
  await db.admin.query('DELETE FROM dbos.workflow_input WHERE workflow_uuid LIKE $1', [`${prefix}%`]);
  await db.admin.query('DELETE FROM dbos.workflow_output WHERE workflow_uuid LIKE $1', [`${prefix}%`]);
  await db.admin.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [`${prefix}%`]);
  await client.close();
  await db.close();
});

function observePlans(pool: Pool): void {
  pool.on('connect', (connection) => {
    connection.on('notice', ({ message }) => {
      const marker = 'plan:\n';
      if (!message?.startsWith('duration:') || !message.includes(marker)) return;
      try {
        planDocuments.push(JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown);
      } catch {
        // Invalid notices are not plans and do not contribute evidence.
      }
    });
  });
}

function plansFrom(documents: readonly unknown[]): PlanEvidence[] {
  return documents.flatMap((document) => {
    const roots = Array.isArray(document) ? document : [document];
    return roots.flatMap((root) => {
      if (typeof root !== 'object' || root === null) return [];
      const entry = root as { readonly 'Query Text'?: unknown; readonly Plan?: unknown };
      return typeof entry['Query Text'] === 'string' && entry.Plan !== undefined
        ? [{ query: entry['Query Text'], plan: entry.Plan }]
        : [];
    });
  });
}

function indexNamesIn(plan: unknown): string[] {
  if (Array.isArray(plan)) return plan.flatMap(indexNamesIn);
  if (typeof plan !== 'object' || plan === null) return [];
  const entry = plan as { readonly 'Index Name'?: unknown; readonly 'Node Type'?: unknown; readonly Plans?: unknown };
  return [
    ...(typeof entry['Index Name'] === 'string' ? [entry['Index Name']] : []),
    ...(Array.isArray(entry.Plans) ? entry.Plans.flatMap(indexNamesIn) : []),
  ];
}

function nodeTypesIn(plan: unknown): string[] {
  if (Array.isArray(plan)) return plan.flatMap(nodeTypesIn);
  if (typeof plan !== 'object' || plan === null) return [];
  const entry = plan as { readonly 'Node Type'?: unknown; readonly Plans?: unknown };
  return [
    ...(typeof entry['Node Type'] === 'string' ? [entry['Node Type']] : []),
    ...(Array.isArray(entry.Plans) ? entry.Plans.flatMap(nodeTypesIn) : []),
  ];
}

function selectorPlans(runs: readonly RunEvidence[]): PlanEvidence[] {
  return runs.flatMap((run) =>
    run.plans.filter(
      ({ query }) =>
        query.includes('work:workflow-retention-select') || query.includes('ORDER BY completed_at, workflow_uuid'),
    ),
  );
}

function expectSelectorIndex(runs: readonly RunEvidence[]): void {
  for (const scale of new Set(runs.map((run) => run.scale))) {
    const plans = selectorPlans(runs.filter((run) => run.scale === scale));
    expect(plans.length, `retention selector plan at scale ${scale}`).toBeGreaterThan(0);
    const indexes = new Set(plans.flatMap(({ plan }) => indexNamesIn(plan)));
    expect([...indexes]).toContain(WORKFLOW_RETENTION_SELECTOR_INDEX);
    const nodes = plans.flatMap(({ plan }) => nodeTypesIn(plan));
    expect(nodes.includes('Seq Scan')).toBe(false);
  }
}

function expectDeletionPlans(runs: readonly RunEvidence[], selected: number): void {
  if (selected === 0) return;
  for (const scale of new Set(runs.map((run) => run.scale))) {
    const kinds = new Set(
      runs
        .filter((run) => run.scale === scale)
        .flatMap((run) => run.plans.map(({ query }) => classifyRetentionStatement(query))),
    );
    expect(kinds.has('delete-workflow_input'), `input delete at scale ${scale}`).toBe(true);
    expect(kinds.has('delete-workflow_output'), `output delete at scale ${scale}`).toBe(true);
    expect(kinds.has('delete-operation_outputs'), `operations delete at scale ${scale}`).toBe(true);
    expect(kinds.has('delete-workflow_status'), `status delete at scale ${scale}`).toBe(true);
  }
}

function logEvidence(name: string, report: GrowthReport, runs: readonly RunEvidence[]): void {
  const sampledScales = new Set<number>();
  const plans = runs.flatMap(({ scale, repetition, plans: entries }) => {
    if (sampledScales.has(scale)) return [];
    const matching = entries
      .filter(
        ({ query }) =>
          query.includes('work:workflow-retention-select') ||
          query.includes('ORDER BY completed_at, workflow_uuid') ||
          classifyRetentionStatement(query).startsWith('delete-'),
      )
      .map(({ query, plan }) => ({ scale, repetition, query, plan }));
    if (matching.length > 0) sampledScales.add(scale);
    return matching;
  });
  console.log(
    `${name} ${JSON.stringify({
      scales: report.samples.map((sample) => sample.scale),
      series: report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
        backgroundRows: cost.backgroundRows ?? 0,
        backgroundBlocks: cost.backgroundBlocks ?? 0,
        backgroundStatements: cost.backgroundStatements ?? 0,
        relations: Object.fromEntries(
          Object.entries(cost.relations).map(([relation, value]) => [relation, { rows: value.rows, blocks: value.blocks }]),
        ),
        statementsList: (report.samples.find((sample) => sample.scale === scale)?.statementRepetitions[0] ?? []).map(
          (entry) => ({
            statement: entry.statement,
            rows: entry.rows,
            blocks: entry.blocks,
            count: entry.count,
            kind: classifyRetentionStatement(entry.statement),
          }),
        ),
      })),
      binds: selectionBinds.slice(-report.samples.length),
      plans,
    })}`,
  );
}

async function seed(
  growth: GrowthDatabase,
  kind: string,
  amount: number,
  offset: number,
  fields: {
    readonly application: string;
    readonly status: string;
    readonly createdAt: number;
    readonly completedAt: number | null;
  },
): Promise<string[]> {
  if (amount === 0) return [];
  await growth.pool.query(
    `INSERT INTO dbos.workflow_status (
       workflow_uuid, status, name, authenticated_roles, recovery_attempts,
       created_at, updated_at, completed_at, application_name
     )
     SELECT $1 || $2 || ':' || lpad(item::text, 8, '0'),
            $3, 'retention.growth.fixture', '[]', 0,
            $4::bigint + item, $5::bigint + item, $6, $7
       FROM generate_series($8 + 1, $8 + $9) AS item`,
    [
      prefix,
      kind,
      fields.status,
      fields.createdAt,
      fields.completedAt ?? fields.createdAt,
      fields.completedAt,
      fields.application,
      offset,
      amount,
    ],
  );
  return idsFor(kind, amount, offset);
}

function idsFor(kind: string, amount: number, offset: number): string[] {
  return Array.from(
    { length: amount },
    (_, index) => `${prefix}${kind}:${String(offset + index + 1).padStart(8, '0')}`,
  );
}

function historyCount(scale: number): number {
  return scale * historyRowsPerUnit;
}

async function growUnrelated(growth: GrowthDatabase, scale: number, previous: number): Promise<void> {
  const added = historyCount(scale) - historyCount(previous);
  const offset = historyCount(previous);
  await seed(growth, 'foreign', added, offset, {
    application: 'retention.growth.foreign',
    status: 'SUCCESS',
    createdAt: origin - 400 * dayMs,
    completedAt: origin - 400 * dayMs,
  });
  await seed(growth, 'nonterminal', added, offset, {
    application: WORK_APPLICATION,
    status: 'PENDING',
    createdAt: origin - 400 * dayMs,
    completedAt: null,
  });
  await seed(growth, 'recent', added, offset, {
    application: WORK_APPLICATION,
    status: 'SUCCESS',
    createdAt: origin - dayMs,
    completedAt: origin - dayMs,
  });
  await seed(growth, 'long-lived', added, offset, {
    application: WORK_APPLICATION,
    status: 'SUCCESS',
    createdAt: origin - 400 * dayMs,
    completedAt: origin - dayMs,
  });
}

async function seedEligible(
  growth: GrowthDatabase,
  kind: string,
  amount: number,
  offset: number,
  fanout: RetentionPayloadFanout = UNIT_RETENTION_PAYLOAD,
): Promise<string[]> {
  const ids = await seed(growth, kind, amount, offset, {
    application: WORK_APPLICATION,
    status: 'SUCCESS',
    createdAt: origin - 401 * dayMs,
    completedAt: origin - 400 * dayMs,
  });
  await insertRetentionPayload(growth.pool, ids, fanout);
  return ids;
}

async function runBatch(expected: number): Promise<number> {
  const removed = await runWorkflowRetentionBatch(30, client, now, select);
  expect(removed).toBe(expected);
  return removed;
}

function expectBackgroundIndependent(report: GrowthReport): void {
  for (const sample of report.samples) {
    expect(sample.cost.backgroundStatements ?? 0).toBe(report.samples[0]!.cost.backgroundStatements ?? 0);
  }
}

test('an empty retention batch stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'empty workflow retention batch',
    rule: 'series',
    scales,
    repetitions: 1,
    includeBackends: true,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, scale, previous);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select)).toBe(0);
    },
    async operation(_growth, scale, repetition) {
      const before = planDocuments.length;
      const removed = await runBatch(0);
      runs.push({ scale, repetition, plans: plansFrom(planDocuments.slice(before)) });
      return removed;
    },
  });
  expectSelectorIndex(runs);
  expect(retentionBatchWork(0, expectedRetentionInventory(0)).statements).toBe(1);
  expectBackgroundIndependent(report);
  logEvidence('empty workflow retention batch', report, runs);
  expect(report.samples[0]!.cost.rows).toBe(0);
  expect(report.samples[1]!.cost.rows).toBe(0);
  expect(report.samples[2]!.cost.rows).toBe(0);
}, 180_000);

test('a short retention batch stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'short workflow retention batch',
    rule: 'series',
    scales,
    repetitions: 1,
    includeBackends: true,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, scale, previous);
      await seedEligible(growth, 'short-warmup', shortBatch, scale * shortBatch);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select)).toBe(shortBatch);
    },
    async prepare(growth, scale) {
      await seedEligible(growth, 'short-eligible', shortBatch, scale * shortBatch);
    },
    async operation(_growth, scale, repetition) {
      const before = planDocuments.length;
      const removed = await runBatch(shortBatch);
      runs.push({ scale, repetition, plans: plansFrom(planDocuments.slice(before)) });
      return removed;
    },
  });
  expectSelectorIndex(runs);
  expectDeletionPlans(runs, shortBatch);
  expectBackgroundIndependent(report);
  logEvidence('short workflow retention batch', report, runs);
  const derived = retentionBatchWork(shortBatch, expectedRetentionInventory(shortBatch));
  expect(report.samples[0]!.cost.statements).toBeGreaterThanOrEqual(derived.statements);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[0]!.cost.rows).toBeGreaterThan(shortBatch);
}, 180_000);

test('a full retention batch stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'workflow retention batch',
    rule: 'series',
    scales,
    repetitions: 1,
    includeBackends: true,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, scale, previous);
      await seedEligible(growth, 'full-warmup', fullBatch, scale * fullBatch);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select)).toBe(fullBatch);
    },
    async prepare(growth, scale) {
      await seedEligible(growth, 'full-eligible', fullBatch, scale * fullBatch);
    },
    async operation(_growth, scale, repetition) {
      const before = planDocuments.length;
      const removed = await runBatch(fullBatch);
      runs.push({ scale, repetition, plans: plansFrom(planDocuments.slice(before)) });
      return removed;
    },
  });
  expectSelectorIndex(runs);
  expectDeletionPlans(runs, fullBatch);
  expectBackgroundIndependent(report);
  logEvidence('workflow retention batch', report, runs);
  const derived = retentionBatchWork(fullBatch, expectedRetentionInventory(fullBatch));
  expect(report.samples[0]!.cost.statements).toBeGreaterThanOrEqual(derived.statements);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[0]!.cost.rows).toBeGreaterThan(fullBatch);
}, 180_000);

test('a full retention batch stays bounded as selected-application eligible backlog grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'eligible backlog workflow retention batch',
    rule: 'series',
    scales,
    repetitions: 1,
    includeBackends: true,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      const added = historyCount(scale) - historyCount(previous);
      await seed(growth, 'backlog', added, historyCount(previous), {
        application: WORK_APPLICATION,
        status: 'SUCCESS',
        createdAt: origin - 32 * dayMs,
        completedAt: origin - 31 * dayMs,
      });
      await seedEligible(growth, 'backlog-warmup', fullBatch, scale * fullBatch);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select)).toBe(fullBatch);
    },
    async prepare(growth, scale) {
      await seedEligible(growth, 'backlog-eligible', fullBatch, scale * fullBatch);
    },
    async operation(_growth, scale, repetition) {
      const before = planDocuments.length;
      const removed = await runBatch(fullBatch);
      runs.push({ scale, repetition, plans: plansFrom(planDocuments.slice(before)) });
      return removed;
    },
  });
  expectSelectorIndex(runs);
  expectDeletionPlans(runs, fullBatch);
  expectBackgroundIndependent(report);
  logEvidence('eligible backlog workflow retention batch', report, runs);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
}, 180_000);

test('a short retention batch grows linearly with owned payload fanout', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'payload fanout workflow retention batch',
    rule: 'series',
    scales: payloadScales,
    repetitions: 1,
    includeBackends: true,
    bounds: { statements: 'constant', rows: 'linear', blocks: 'linear' },
    counted: {
      read: (value, scale) => ({ selected: Number(value), payload: scale }),
      bounds: { selected: 'constant', payload: 'linear' },
    },
    async grow(growth, scale) {
      await growth.pool.query('DELETE FROM dbos.workflow_input WHERE workflow_uuid LIKE $1', [`${prefix}fanout%`]);
      await growth.pool.query('DELETE FROM dbos.workflow_output WHERE workflow_uuid LIKE $1', [`${prefix}fanout%`]);
      await growth.pool.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [`${prefix}fanout%`]);
      const fanout = { ...UNIT_RETENTION_PAYLOAD, operations: scale, events: scale, history: scale, streams: scale };
      await seedEligible(growth, 'fanout-warmup', shortBatch, 0, fanout);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select)).toBe(shortBatch);
    },
    async prepare(growth, scale) {
      const fanout = { ...UNIT_RETENTION_PAYLOAD, operations: scale, events: scale, history: scale, streams: scale };
      await seedEligible(growth, 'fanout-eligible', shortBatch, 0, fanout);
    },
    async operation(_growth, scale, repetition) {
      const before = planDocuments.length;
      const removed = await runBatch(shortBatch);
      runs.push({ scale, repetition, plans: plansFrom(planDocuments.slice(before)) });
      return removed;
    },
  });
  expectSelectorIndex(runs);
  expectDeletionPlans(runs, shortBatch);
  expectBackgroundIndependent(report);
  logEvidence('payload fanout workflow retention batch', report, runs);
  const first = retentionBatchWork(
    shortBatch,
    retentionPayloadFanoutInventory(shortBatch, { operations: 1, events: 1, history: 1, streams: 1 }),
  );
  const last = retentionBatchWork(
    shortBatch,
    retentionPayloadFanoutInventory(shortBatch, { operations: 64, events: 64, history: 64, streams: 64 }),
  );
  expect(last.selected).toBe(first.selected);
  expect(last.deletionRows).toBeGreaterThan(first.deletionRows);
  expect(report.samples[0]!.cost.statements).toBeGreaterThanOrEqual(first.statements);
  expect(report.samples[2]!.cost.rows).toBeGreaterThan(report.samples[0]!.cost.rows);
}, 180_000);

test('a two-batch retention sweep stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const selected = fullBatch + sweepRemainder;
  const report = await checkGrowth(db, {
    name: 'workflow retention sweep',
    rule: 'series',
    scales,
    repetitions: 1,
    includeBackends: true,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, scale, previous);
      await seedEligible(growth, 'sweep-warmup', selected, scale * selected);
    },
    async warmup() {
      expect(await runWorkflowRetentionSweep(30, client, now, (batch) => batch(), select)).toBe(selected);
    },
    async prepare(growth, scale) {
      await seedEligible(growth, 'sweep-eligible', selected, scale * selected);
    },
    async operation(_growth, scale, repetition) {
      const before = planDocuments.length;
      const removed = await runWorkflowRetentionSweep(30, client, now, (batch) => batch(), select);
      expect(removed).toBe(selected);
      runs.push({ scale, repetition, plans: plansFrom(planDocuments.slice(before)) });
      return removed;
    },
  });
  expectSelectorIndex(runs);
  expectDeletionPlans(runs, selected);
  expectBackgroundIndependent(report);
  logEvidence('workflow retention sweep', report, runs);
  const derived = retentionSweepWork(
    [fullBatch, sweepRemainder],
    [expectedRetentionInventory(fullBatch), expectedRetentionInventory(sweepRemainder)],
  );
  expect(report.samples[0]!.cost.statements).toBeGreaterThanOrEqual(derived.statements);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
}, 180_000);
