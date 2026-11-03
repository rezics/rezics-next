import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { WORK_APPLICATION, createWorkClient } from '../../src/work/client.ts';
import { runWorkflowRetentionBatch } from '../../src/work/retention.ts';
import {
  WORKFLOW_RETENTION_SELECTOR_INDEX,
  createWorkflowRetentionSelector,
} from '../../src/work/retention-selector.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase, type GrowthReport } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [64, 512, 4096] as const;
const historyRowsPerUnit = 16;
const shortBatch = 10;
const fullBatch = 1000;
const origin = Date.now();
const dayMs = 24 * 60 * 60 * 1000;
const now = new Date(origin);
const prefix = `retention-growth:${crypto.randomUUID()}:`;

let db: GrowthDatabase;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let select: ReturnType<typeof createWorkflowRetentionSelector>;
const planDocuments: unknown[] = [];

type PlanEvidence = { readonly query: string; readonly plan: unknown };
type RunEvidence = { readonly scale: number; readonly repetition: number; readonly plans: readonly PlanEvidence[] };

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  observePlans(db.pool);
  client = await createWorkClient(databaseUrl, db.pool);
  select = createWorkflowRetentionSelector(db.pool);
  await seed(db, 'planner-floor', 32_768, 0, {
    application: 'retention.growth.floor',
    status: 'SUCCESS',
    createdAt: origin - 400 * dayMs,
    completedAt: origin - 400 * dayMs,
  });
  await db.admin.query('ANALYZE dbos.workflow_status');
});

afterAll(async () => {
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

function expectSelectorIndex(runs: readonly RunEvidence[]): void {
  for (const scale of scales) {
    const plans = runs
      .filter((run) => run.scale === scale)
      .flatMap((run) => run.plans)
      .filter(
        ({ query }) =>
          query.includes('work:workflow-retention-select') || query.includes('ORDER BY completed_at, workflow_uuid'),
      );
    expect(plans.length, `retention selector plan at scale ${scale}`).toBeGreaterThan(0);
    const indexes = new Set(plans.flatMap(({ plan }) => indexNamesIn(plan)));
    expect([...indexes]).toContain(WORKFLOW_RETENTION_SELECTOR_INDEX);
    const nodes = plans.flatMap(({ plan }) => nodeTypesIn(plan));
    expect(nodes.includes('Seq Scan')).toBe(false);
  }
}

function logEvidence(name: string, report: GrowthReport, runs: readonly RunEvidence[]): void {
  const sampledScales = new Set<number>();
  const plans = runs.flatMap(({ scale, repetition, plans: entries }) => {
    if (sampledScales.has(scale)) return [];
    const matching = entries
      .filter(
        ({ query }) =>
          query.includes('work:workflow-retention-select') || query.includes('ORDER BY completed_at, workflow_uuid'),
      )
      .map(({ query, plan }) => ({ scale, repetition, query, plan }));
    if (matching.length > 0) sampledScales.add(scale);
    return matching;
  });
  console.log(
    `${name} ${JSON.stringify({
      scales: [...scales],
      series: report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
        backgroundRows: cost.backgroundRows ?? 0,
        backgroundBlocks: cost.backgroundBlocks ?? 0,
      })),
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
): Promise<void> {
  if (amount === 0) return;
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

async function seedEligible(growth: GrowthDatabase, kind: string, amount: number, offset: number): Promise<void> {
  await seed(growth, kind, amount, offset, {
    application: WORK_APPLICATION,
    status: 'SUCCESS',
    createdAt: origin - 401 * dayMs,
    completedAt: origin - 400 * dayMs,
  });
}

async function runBatch(expected: number): Promise<number> {
  const removed = await runWorkflowRetentionBatch(30, client, now, select);
  expect(removed).toBe(expected);
  return removed;
}

test('an empty retention batch stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'empty workflow retention batch',
    rule: 'series',
    scales,
    repetitions: 1,
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
  logEvidence('short workflow retention batch', report, runs);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[0]!.cost.rows).toBeGreaterThan(0);
}, 180_000);

test('a full retention batch stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'workflow retention batch',
    rule: 'series',
    scales,
    repetitions: 1,
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
  logEvidence('workflow retention batch', report, runs);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[0]!.cost.rows).toBeGreaterThan(0);
}, 180_000);

test('a full retention batch stays bounded as selected-application eligible backlog grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'eligible backlog workflow retention batch',
    rule: 'series',
    scales,
    repetitions: 1,
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
  logEvidence('eligible backlog workflow retention batch', report, runs);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
}, 180_000);
