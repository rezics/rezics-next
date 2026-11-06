import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { createWorkClient } from '../../src/work/client.ts';
import {
  classifyRetentionStatement,
  emptyWorkflowRetentionInventory,
  inventoriesMatch,
  isRetentionCascadeDelete,
  retentionAdmittedByteScale,
  retentionBatchWork,
  retentionCompleteBatchWork,
  retentionFamilyCountScale,
  retentionIndexProbes,
  retentionObservedWork,
  retentionPayloadFanoutInventory,
  retentionSelectorPlanProof,
  retentionSweepWork,
  WORKFLOW_RETENTION_COUNT_SCALES,
  WORKFLOW_RETENTION_FAMILY_LIMITS,
  WORKFLOW_RETENTION_VARIABLE_FAMILIES,
  type WorkflowRetentionPayloadFamily,
  type WorkflowRetentionSelection,
} from '../../src/work/core/index.ts';
import {
  runWorkflowRetentionBatch,
  runWorkflowRetentionSweep,
  type WorkflowRetentionSelector,
} from '../../src/work/retention.ts';
import {
  WORKFLOW_RETENTION_SELECTOR_INDEX,
  WORKFLOW_RETENTION_SELECT_TAG,
  createWorkflowRetentionSelector,
  emptyWorkflowRetentionOwned,
  ownedSnapshotsMatch,
  readWorkflowRetentionOwned,
} from '../../src/work/retention-selector.ts';
import { affineEnvelope, classifyEngineWork } from '../support/growth-bound.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase, type GrowthReport } from '../support/growth.ts';
import {
  deleteOwnedRetentionRows,
  expectedRetentionInventory,
  familyFanout,
  insertRetentionPayload,
  MIXED_MAX_RETENTION_PAYLOAD,
  SINGLE_COPY_BYTE_FAMILIES,
  UNIT_RETENTION_PAYLOAD,
  type RetentionPayloadFanout,
} from './support/retention-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [64, 512, 4096] as const;
const payloadScales = WORKFLOW_RETENTION_COUNT_SCALES;
const historyRowsPerUnit = 16;
const shortBatch = 10;
const fullBatch = 1000;
const sweepRemainder = 10;
const origin = Date.now();
const dayMs = 24 * 60 * 60 * 1000;
const now = new Date(origin);
const prefix = `retention-growth:${crypto.randomUUID()}:`;
const planMarker = 'plan:\n';

let db: GrowthDatabase;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let select: WorkflowRetentionSelector;
let samplingSelectorPlans = false;
const selectorPlanDocuments: unknown[] = [];
const selectionBinds: WorkflowRetentionSelection[] = [];

type PlanEvidence = { readonly query: string; readonly plan: unknown };
type RunEvidence = { readonly scale: number; readonly repetition: number; readonly plans: readonly PlanEvidence[] };

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  observeSelectorPlans(db.pool);
  client = await createWorkClient(databaseUrl, db.pool);
  const inner = createWorkflowRetentionSelector(db.pool);
  select = async (input) => {
    selectionBinds.push(input);
    return inner(input);
  };
  const floorIds = await seed(db, 'planner-floor', 32_768, 0, {
    application: 'retention.growth.floor',
    status: 'SUCCESS',
    createdAt: origin - 400 * dayMs,
    completedAt: origin - 400 * dayMs,
  });
  await insertRetentionPayload(db.pool, floorIds);
  await db.admin.query(
    `ANALYZE dbos.workflow_status, dbos.workflow_input, dbos.workflow_output, dbos.operation_outputs,
            dbos.workflow_events, dbos.workflow_events_history, dbos.notifications, dbos.streams`,
  );
}, 180_000);

afterAll(async () => {
  await deleteOwnedRetentionRows(db.admin, `${prefix}%`);
  await client.close();
  await db.close();
}, 300_000);

function isSelectorNotice(message: string): boolean {
  return message.includes(WORKFLOW_RETENTION_SELECT_TAG) || message.includes('ORDER BY completed_at, workflow_uuid');
}

function observeSelectorPlans(pool: Pool): void {
  const observed = new WeakSet<PoolClient>();
  const attach = (connection: PoolClient) => {
    if (observed.has(connection)) return;
    observed.add(connection);
    connection.on('notice', ({ message }) => {
      if (!samplingSelectorPlans || !message?.startsWith('duration:') || !message.includes(planMarker)) return;
      if (!isSelectorNotice(message)) return;
      try {
        selectorPlanDocuments.push(JSON.parse(message.slice(message.indexOf(planMarker) + planMarker.length)));
      } catch {
        // Invalid notices are not plans and do not contribute evidence.
      }
    });
  };
  pool.on('connect', attach);
  pool.on('acquire', attach);
  for (const connection of (pool as Pool & { _clients?: PoolClient[] })._clients ?? []) attach(connection);
}

function plansFrom(documents: readonly unknown[]): PlanEvidence[] {
  return documents.flatMap((document) => {
    const roots = Array.isArray(document) ? document : [document];
    return roots.flatMap((root) => {
      if (typeof root !== 'object' || root === null) return [];
      const entry = root as { readonly 'Query Text'?: unknown; readonly Plan?: unknown };
      if (entry.Plan === undefined) return [];
      return [
        {
          query: typeof entry['Query Text'] === 'string' ? entry['Query Text'] : '',
          plan: entry.Plan,
        },
      ];
    });
  });
}

function indexNamesIn(plan: unknown): string[] {
  if (Array.isArray(plan)) return plan.flatMap(indexNamesIn);
  if (typeof plan !== 'object' || plan === null) return [];
  const entry = plan as { readonly 'Index Name'?: unknown; readonly Plans?: unknown };
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

async function measureBatch(
  expected: number,
  series: string,
  scale: number,
  repetition: number,
  runs: RunEvidence[],
): Promise<number> {
  const before = selectorPlanDocuments.length;
  samplingSelectorPlans = true;
  try {
    const removed = await runBatch(expected, series);
    runs.push({ scale, repetition, plans: plansFrom(selectorPlanDocuments.slice(before)) });
    return removed;
  } finally {
    samplingSelectorPlans = false;
  }
}

async function measureSweep(
  expected: number,
  series: string,
  scale: number,
  repetition: number,
  runs: RunEvidence[],
): Promise<number> {
  const before = selectorPlanDocuments.length;
  samplingSelectorPlans = true;
  try {
    const removed = await runSweep(expected, series);
    runs.push({ scale, repetition, plans: plansFrom(selectorPlanDocuments.slice(before)) });
    return removed;
  } finally {
    samplingSelectorPlans = false;
  }
}

function expectSelectorIndex(runs: readonly RunEvidence[]): void {
  for (const scale of new Set(runs.map((run) => run.scale))) {
    const plans = runs.filter((run) => run.scale === scale).flatMap((run) => run.plans);
    expect(plans.length, `retention selector plan at scale ${scale}`).toBeGreaterThan(0);
    const documents = plans.map(({ query, plan }) => ({ 'Query Text': query, Plan: plan }));
    const proof = retentionSelectorPlanProof(documents);
    expect(proof.indexed, `retention selector index at scale ${scale}`).toBe(true);
    expect(proof.sequential, `retention selector sequential scan at scale ${scale}`).toBe(false);
    const indexes = new Set(plans.flatMap(({ plan }) => indexNamesIn(plan)));
    expect([...indexes]).toContain(WORKFLOW_RETENTION_SELECTOR_INDEX);
    expect(plans.flatMap(({ plan }) => nodeTypesIn(plan)).includes('Seq Scan')).toBe(false);
  }
}

function expectDeletionStatements(report: GrowthReport, selected: number): void {
  if (selected === 0) return;
  for (const sample of report.samples) {
    const kinds = new Set(
      (sample.statementRepetitions[0] ?? []).map((entry) => classifyRetentionStatement(entry.statement)),
    );
    expect(kinds.has('delete-workflow_input'), `input delete at scale ${sample.scale}`).toBe(true);
    expect(kinds.has('delete-workflow_output'), `output delete at scale ${sample.scale}`).toBe(true);
    expect(kinds.has('delete-operation_outputs'), `operations delete at scale ${sample.scale}`).toBe(true);
    expect(kinds.has('delete-workflow_status'), `status delete at scale ${sample.scale}`).toBe(true);
  }
}

function expectStatusIndexOnly(report: GrowthReport): void {
  for (const sample of report.samples) {
    for (const [name, relation] of Object.entries(sample.cost.relations)) {
      if (!name.includes('workflow_status')) continue;
      expect(relation.sequentialScans, `${name} sequential scans at scale ${sample.scale}`).toBe(0);
    }
  }
}

function logEvidence(name: string, report: GrowthReport, runs: readonly RunEvidence[]): void {
  const sampledScales = new Set<number>();
  const plans = runs.flatMap(({ scale, plans: entries }) => {
    if (sampledScales.has(scale) || entries.length === 0) return [];
    sampledScales.add(scale);
    return entries.map(({ query, plan }) => ({
      scale,
      query,
      indexes: [...new Set(indexNamesIn(plan))],
      nodes: [...new Set(nodeTypesIn(plan))],
    }));
  });
  console.log(
    `${name} ${JSON.stringify({
      captureMode: 'cost-folded',
      scales: report.samples.map((sample) => sample.scale),
      series: report.samples.map(({ scale, cost, statementRepetitions }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
        controlStatements: cost.controlStatements,
        backgroundRows: cost.backgroundRows ?? 0,
        backgroundBlocks: cost.backgroundBlocks ?? 0,
        backgroundStatements: cost.backgroundStatements ?? 0,
        sequentialScans: Object.fromEntries(
          Object.entries(cost.relations).map(([relation, value]) => [relation, value.sequentialScans]),
        ),
        relations: Object.fromEntries(
          Object.entries(cost.relations).map(([relation, value]) => [
            relation,
            { rows: value.rows, blocks: value.blocks },
          ]),
        ),
        statementsList: (statementRepetitions[0] ?? []).map((entry) => ({
          statement: entry.statement,
          rows: entry.rows,
          blocks: entry.blocks,
          count: entry.count,
          kind: classifyRetentionStatement(entry.statement),
        })),
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

function applicationFor(series: string): string {
  return `${prefix}${series}`;
}

async function growUnrelated(growth: GrowthDatabase, series: string, scale: number, previous: number): Promise<void> {
  const added = historyCount(scale) - historyCount(previous);
  const offset = historyCount(previous);
  const application = applicationFor(series);
  await seed(growth, `${series}-foreign`, added, offset, {
    application: `${application}.foreign`,
    status: 'SUCCESS',
    createdAt: origin - 400 * dayMs,
    completedAt: origin - 400 * dayMs,
  });
  await seed(growth, `${series}-nonterminal`, added, offset, {
    application,
    status: 'PENDING',
    createdAt: origin - 400 * dayMs,
    completedAt: null,
  });
  await seed(growth, `${series}-recent`, added, offset, {
    application,
    status: 'SUCCESS',
    createdAt: origin - dayMs,
    completedAt: origin - dayMs,
  });
  await seed(growth, `${series}-long-lived`, added, offset, {
    application,
    status: 'SUCCESS',
    createdAt: origin - 400 * dayMs,
    completedAt: origin - dayMs,
  });
}

async function seedEligible(
  growth: GrowthDatabase,
  series: string,
  kind: string,
  amount: number,
  offset: number,
  fanout: RetentionPayloadFanout = UNIT_RETENTION_PAYLOAD,
  bytesPerCopy = 0,
  byteFamilies?: readonly WorkflowRetentionPayloadFamily[],
): Promise<string[]> {
  const ids = await seed(growth, `${series}-${kind}`, amount, offset, {
    application: applicationFor(series),
    status: 'SUCCESS',
    createdAt: origin - 401 * dayMs,
    completedAt: origin - 400 * dayMs,
  });
  await insertRetentionPayload(growth.pool, ids, fanout, bytesPerCopy, byteFamilies);
  return ids;
}

async function runBatch(expected: number, series: string): Promise<number> {
  const removed = await runWorkflowRetentionBatch(30, client, now, select, applicationFor(series));
  expect(removed).toBe(expected);
  return removed;
}

async function runSweep(expected: number, series: string): Promise<number> {
  const removed = await runWorkflowRetentionSweep(30, client, now, (batch) => batch(), select, applicationFor(series));
  expect(removed).toBe(expected);
  return removed;
}

function expectBackgroundIndependent(report: GrowthReport): void {
  for (const sample of report.samples) {
    expect(sample.cost.backgroundStatements ?? 0).toBe(report.samples[0]!.cost.backgroundStatements ?? 0);
  }
}

function expectDerivedStatements(
  report: GrowthReport,
  derived: { readonly statements: number; readonly applicationStatements: number; readonly controlStatements: number },
): void {
  for (const sample of report.samples) {
    expect(sample.cost.statements, `application statements at scale ${sample.scale}`).toBe(
      derived.applicationStatements,
    );
    expect(sample.cost.controlStatements, `control statements at scale ${sample.scale}`).toBe(
      derived.controlStatements,
    );
    expect(
      sample.cost.statements + sample.cost.controlStatements,
      `application plus control statements at scale ${sample.scale}`,
    ).toBe(derived.statements);
    const observed = retentionObservedWork(
      (sample.statementRepetitions[0] ?? []).flatMap((entry) =>
        Array.from({ length: Math.max(1, entry.count) }, () => entry.statement),
      ),
    );
    expect(observed.applicationStatements, `observed application statements at scale ${sample.scale}`).toBe(
      derived.applicationStatements,
    );
    if (derived.applicationStatements > 1) expect(observed.exactIdDeletes).toBe(4);
    expect(observed.backgroundStatements).toBe(0);
  }
}

function expectEngineEnvelope(report: GrowthReport, copiesGrew: boolean): void {
  const classified = classifyEngineWork(
    report.samples.map((sample) => ({
      scale: sample.scale,
      cost: sample.cost,
      relationSizes: sample.relationSizes,
    })),
  );
  expect(classified.backgroundGrew).toBe(false);
  expect(classified.class).not.toBe('background');
  if (copiesGrew) expect(classified.envelope.slope).toBeGreaterThanOrEqual(0);
}

const foldedCapture = { captureMode: 'cost-folded' as const, includeBackends: true, rule: 'series' as const };
const prepared = new Map<string, string[]>();

function expectOwnedInventory(
  actual: { readonly rows: ReturnType<typeof expectedRetentionInventory> },
  expected: ReturnType<typeof expectedRetentionInventory>,
): void {
  expect(inventoriesMatch(actual.rows, expected), JSON.stringify({ actual: actual.rows, expected })).toBe(true);
}

async function verifyEmptyOwned(growth: GrowthDatabase, seriesName: string): Promise<void> {
  const actual = await readWorkflowRetentionOwned(growth.admin, prepared.get(seriesName) ?? []);
  expectOwnedInventory(actual, emptyWorkflowRetentionInventory());
  expect(ownedSnapshotsMatch(actual, emptyWorkflowRetentionOwned())).toBe(true);
}

function relationTableName(name: string): string {
  return name.replaceAll('"', '').split('.').at(-1) ?? name;
}

function expectCascadeRelations(report: GrowthReport, family: string, selected: number): void {
  if (selected === 0) return;
  for (const sample of report.samples) {
    const match = Object.entries(sample.cost.relations).find(([name]) => relationTableName(name) === family);
    expect(match, `${family} relation at scale ${sample.scale}`).toBeDefined();
    expect(match![1]!.rows, `${family} rows at scale ${sample.scale}`).toBeGreaterThan(0);
  }
}

function logCompleteEvidence(
  name: string,
  report: GrowthReport,
  runs: readonly RunEvidence[],
  derived: { readonly deletionRows: number; readonly nestedFkStatements: number; readonly indexProbes: number },
): void {
  logEvidence(name, report, runs);
  const blocks = report.samples.map((sample) => sample.cost.blocks);
  const scales = report.samples.map((sample) => sample.scale);
  console.log(
    `${name} complete ${JSON.stringify({
      derived,
      affine: affineEnvelope(scales, blocks),
      nested: report.samples.map(({ scale, cost, statementRepetitions }) => ({
        scale,
        requestBytes: cost.requestBytes ?? 0,
        responseBytes: cost.responseBytes ?? 0,
        cascadeKinds: (statementRepetitions[0] ?? [])
          .map((entry) => classifyRetentionStatement(entry.statement))
          .filter((kind) => isRetentionCascadeDelete(kind) || kind.startsWith('delete-')),
        relations: Object.fromEntries(
          Object.entries(cost.relations).map(([relation, value]) => [
            relation,
            { rows: value.rows, blocks: value.blocks, sequentialScans: value.sequentialScans },
          ]),
        ),
      })),
    })}`,
  );
}

async function growUnrelatedPayload(
  growth: GrowthDatabase,
  series: string,
  scale: number,
  previous: number,
): Promise<void> {
  const added = historyCount(scale) - historyCount(previous);
  const offset = historyCount(previous);
  const ids = await seed(growth, `${series}-payload`, added, offset, {
    application: `${applicationFor(series)}.payload`,
    status: 'SUCCESS',
    createdAt: origin - 400 * dayMs,
    completedAt: origin - 400 * dayMs,
  });
  await insertRetentionPayload(growth.pool, ids);
}

async function seedSparseEligible(
  growth: GrowthDatabase,
  series: string,
  kind: string,
  amount: number,
  offset: number,
  fanout: RetentionPayloadFanout = UNIT_RETENTION_PAYLOAD,
): Promise<string[]> {
  const ids = idsFor(`${series}-${kind}`, amount, offset);
  for (let index = 0; index < amount; index += 1) {
    await seed(growth, `${series}-${kind}`, 1, offset + index, {
      application: applicationFor(series),
      status: 'SUCCESS',
      createdAt: origin - 401 * dayMs - index * 86_400_000,
      completedAt: origin - 400 * dayMs - index * 86_400_000,
    });
  }
  await insertRetentionPayload(growth.pool, ids, fanout);
  return ids;
}

test('an empty retention batch stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'empty workflow retention batch',
    ...foldedCapture,
    scales,
    repetitions: 1,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, 'empty', scale, previous);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor('empty'))).toBe(0);
    },
    async operation(_growth, scale, repetition) {
      return measureBatch(0, 'empty', scale, repetition, runs);
    },
  });
  expectSelectorIndex(runs);
  expectStatusIndexOnly(report);
  const derived = retentionBatchWork(0, expectedRetentionInventory(0));
  expect(derived.statements).toBe(1);
  expectDerivedStatements(report, derived);
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
    ...foldedCapture,
    scales,
    repetitions: 1,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, 'short', scale, previous);
      await seedEligible(growth, 'short', 'warmup', shortBatch, scale * shortBatch);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor('short'))).toBe(shortBatch);
    },
    async prepare(growth, scale) {
      const ids = await seedEligible(growth, 'short', 'eligible', shortBatch, scale * shortBatch);
      prepared.set('short', ids);
      expectOwnedInventory(await readWorkflowRetentionOwned(growth.admin, ids), expectedRetentionInventory(shortBatch));
    },
    async operation(_growth, scale, repetition) {
      return measureBatch(shortBatch, 'short', scale, repetition, runs);
    },
    async verify(growth) {
      await verifyEmptyOwned(growth, 'short');
    },
  });
  expectSelectorIndex(runs);
  expectDeletionStatements(report, shortBatch);
  expectStatusIndexOnly(report);
  expectBackgroundIndependent(report);
  logEvidence('short workflow retention batch', report, runs);
  const derived = retentionBatchWork(shortBatch, expectedRetentionInventory(shortBatch));
  expectDerivedStatements(report, derived);
  expectEngineEnvelope(report, false);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[0]!.cost.rows).toBeGreaterThan(shortBatch);
}, 180_000);

test('a full retention batch stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'workflow retention batch',
    ...foldedCapture,
    scales,
    repetitions: 1,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, 'full', scale, previous);
      await seedEligible(growth, 'full', 'warmup', fullBatch, scale * fullBatch);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor('full'))).toBe(fullBatch);
    },
    async prepare(growth, scale) {
      const ids = await seedEligible(growth, 'full', 'eligible', fullBatch, scale * fullBatch);
      prepared.set('full', ids);
      expectOwnedInventory(await readWorkflowRetentionOwned(growth.admin, ids), expectedRetentionInventory(fullBatch));
    },
    async operation(_growth, scale, repetition) {
      return measureBatch(fullBatch, 'full', scale, repetition, runs);
    },
    async verify(growth) {
      await verifyEmptyOwned(growth, 'full');
    },
  });
  expectSelectorIndex(runs);
  expectDeletionStatements(report, fullBatch);
  expectStatusIndexOnly(report);
  expectBackgroundIndependent(report);
  logEvidence('workflow retention batch', report, runs);
  const derived = retentionBatchWork(fullBatch, expectedRetentionInventory(fullBatch));
  expectDerivedStatements(report, derived);
  expectEngineEnvelope(report, false);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[0]!.cost.rows).toBeGreaterThan(fullBatch);
}, 180_000);

test('a full retention batch stays bounded as selected-application eligible backlog grows', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'eligible backlog workflow retention batch',
    ...foldedCapture,
    scales,
    repetitions: 1,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      const added = historyCount(scale) - historyCount(previous);
      await seed(growth, 'backlog-later', added, historyCount(previous), {
        application: applicationFor('backlog'),
        status: 'SUCCESS',
        createdAt: origin - 32 * dayMs,
        completedAt: origin - 31 * dayMs,
      });
      await seedEligible(growth, 'backlog', 'warmup', fullBatch, scale * fullBatch);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor('backlog'))).toBe(fullBatch);
    },
    async prepare(growth, scale) {
      await seedEligible(growth, 'backlog', 'eligible', fullBatch, scale * fullBatch);
    },
    async operation(_growth, scale, repetition) {
      return measureBatch(fullBatch, 'backlog', scale, repetition, runs);
    },
  });
  expectSelectorIndex(runs);
  expectDeletionStatements(report, fullBatch);
  expectStatusIndexOnly(report);
  expectBackgroundIndependent(report);
  logEvidence('eligible backlog workflow retention batch', report, runs);
  expectDerivedStatements(report, retentionBatchWork(fullBatch, expectedRetentionInventory(fullBatch)));
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
}, 180_000);

test('a short retention batch grows linearly with owned payload fanout', async () => {
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'payload fanout workflow retention batch',
    ...foldedCapture,
    scales: payloadScales,
    repetitions: 1,
    bounds: { statements: 'constant', rows: 'linear', blocks: 'linear' },
    counted: {
      read: (value, scale) => ({ selected: Number(value), payload: scale }),
      bounds: { selected: 'constant', payload: 'linear' },
    },
    async grow(growth, scale) {
      await deleteOwnedRetentionRows(growth.pool, `${prefix}fanout-%`);
      await seedEligible(growth, 'fanout', 'warmup', shortBatch, 0, { ...UNIT_RETENTION_PAYLOAD, operations: scale });
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor('fanout'))).toBe(shortBatch);
    },
    async prepare(growth, scale) {
      await seedEligible(growth, 'fanout', 'eligible', shortBatch, 0, { ...UNIT_RETENTION_PAYLOAD, operations: scale });
    },
    async operation(_growth, scale, repetition) {
      return measureBatch(shortBatch, 'fanout', scale, repetition, runs);
    },
  });
  expectSelectorIndex(runs);
  expectDeletionStatements(report, shortBatch);
  expectStatusIndexOnly(report);
  expectBackgroundIndependent(report);
  logEvidence('payload fanout workflow retention batch', report, runs);
  const first = retentionBatchWork(shortBatch, retentionPayloadFanoutInventory(shortBatch, { operations: 1 }));
  const last = retentionBatchWork(shortBatch, retentionPayloadFanoutInventory(shortBatch, { operations: 64 }));
  expect(last.selected).toBe(first.selected);
  expect(last.deletionRows).toBeGreaterThan(first.deletionRows);
  expectDerivedStatements(report, first);
  expect(report.samples[2]!.cost.rows).toBeGreaterThan(report.samples[0]!.cost.rows);
}, 180_000);

test('a two-batch retention sweep stays bounded as unrelated workflow history grows', async () => {
  const runs: RunEvidence[] = [];
  const selected = fullBatch + sweepRemainder;
  const report = await checkGrowth(db, {
    name: 'workflow retention sweep',
    ...foldedCapture,
    scales,
    repetitions: 1,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, 'sweep', scale, previous);
      await seedEligible(growth, 'sweep', 'warmup', selected, scale * selected);
    },
    async warmup() {
      expect(await runSweep(selected, 'sweep')).toBe(selected);
    },
    async prepare(growth, scale) {
      await seedEligible(growth, 'sweep', 'eligible', selected, scale * selected);
    },
    async operation(_growth, scale, repetition) {
      return measureSweep(selected, 'sweep', scale, repetition, runs);
    },
  });
  expectSelectorIndex(runs);
  expectDeletionStatements(report, selected);
  expectStatusIndexOnly(report);
  expectBackgroundIndependent(report);
  logEvidence('workflow retention sweep', report, runs);
  const derived = retentionSweepWork(
    [fullBatch, sweepRemainder],
    [expectedRetentionInventory(fullBatch), expectedRetentionInventory(sweepRemainder)],
  );
  expectDerivedStatements(report, derived);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
}, 180_000);

for (const family of WORKFLOW_RETENTION_VARIABLE_FAMILIES) {
  test(`a short retention batch grows linearly with owned ${family} copies`, async () => {
    const seriesName = `family-${family}`;
    const runs: RunEvidence[] = [];
    const report = await checkGrowth(db, {
      name: `${family} cascade workflow retention batch`,
      ...foldedCapture,
      scales: payloadScales,
      repetitions: 1,
      indexProbes: retentionIndexProbes(shortBatch),
      bounds: { statements: 'constant', rows: 'linear', blocks: 'linear' },
      counted: {
        read: (value, scale) => ({
          selected: Number(value),
          copies: retentionFamilyCountScale(family, scale),
        }),
        bounds: { selected: 'constant', copies: 'linear' },
      },
      async grow(growth, scale) {
        await deleteOwnedRetentionRows(growth.pool, `${prefix}${seriesName}-%`);
        await seedEligible(
          growth,
          seriesName,
          'warmup',
          shortBatch,
          0,
          familyFanout(family, retentionFamilyCountScale(family, scale)),
        );
      },
      async warmup() {
        expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor(seriesName))).toBe(shortBatch);
      },
      async prepare(growth, scale) {
        const ids = await seedEligible(
          growth,
          seriesName,
          'eligible',
          shortBatch,
          0,
          familyFanout(family, retentionFamilyCountScale(family, scale)),
        );
        prepared.set(seriesName, ids);
        expectOwnedInventory(
          await readWorkflowRetentionOwned(growth.admin, ids),
          expectedRetentionInventory(shortBatch, familyFanout(family, retentionFamilyCountScale(family, scale))),
        );
      },
      async operation(_growth, scale, repetition) {
        return measureBatch(shortBatch, seriesName, scale, repetition, runs);
      },
      async verify(growth) {
        await verifyEmptyOwned(growth, seriesName);
      },
    });
    expectSelectorIndex(runs);
    expectDeletionStatements(report, shortBatch);
    expectStatusIndexOnly(report);
    expectBackgroundIndependent(report);
    expectCascadeRelations(report, family, shortBatch);
    const first = retentionCompleteBatchWork(
      shortBatch,
      retentionPayloadFanoutInventory(shortBatch, familyFanout(family, 1)),
    );
    const last = retentionCompleteBatchWork(
      shortBatch,
      retentionPayloadFanoutInventory(shortBatch, familyFanout(family, retentionFamilyCountScale(family, 64))),
    );
    expect(last.selected).toBe(first.selected);
    expect(last.nestedFkStatements).toBe(first.nestedFkStatements);
    expect(last.nestedFkStatements).toBe(4);
    expectDerivedStatements(report, first);
    expectEngineEnvelope(report, WORKFLOW_RETENTION_FAMILY_LIMITS[family] >= 64);
    logCompleteEvidence(`${family} cascade workflow retention batch`, report, runs, last);
    if (WORKFLOW_RETENTION_FAMILY_LIMITS[family] >= 64)
      expect(report.samples[2]!.cost.rows).toBeGreaterThan(report.samples[0]!.cost.rows);
  }, 180_000);
}

test('a short retention batch stays bounded as admitted payload bytes grow', async () => {
  const seriesName = 'bytes';
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'payload byte workflow retention batch',
    ...foldedCapture,
    scales: payloadScales,
    repetitions: 1,
    indexProbes: retentionIndexProbes(shortBatch),
    bounds: { statements: 'constant', rows: 'constant', blocks: 'linear' },
    byteBounds: { requestBytes: 'constant' },
    counted: {
      read: (value, scale) => ({ selected: Number(value), payloadBytes: retentionAdmittedByteScale(scale) }),
      bounds: { selected: 'constant', payloadBytes: 'linear' },
    },
    async grow(growth, scale) {
      await deleteOwnedRetentionRows(growth.pool, `${prefix}${seriesName}-%`);
      await seedEligible(
        growth,
        seriesName,
        'warmup',
        shortBatch,
        0,
        UNIT_RETENTION_PAYLOAD,
        retentionAdmittedByteScale(scale),
        SINGLE_COPY_BYTE_FAMILIES,
      );
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor(seriesName))).toBe(shortBatch);
    },
    async prepare(growth, scale) {
      const ids = await seedEligible(
        growth,
        seriesName,
        'eligible',
        shortBatch,
        0,
        UNIT_RETENTION_PAYLOAD,
        retentionAdmittedByteScale(scale),
        SINGLE_COPY_BYTE_FAMILIES,
      );
      prepared.set(seriesName, ids);
      const owned = await readWorkflowRetentionOwned(growth.admin, ids);
      expectOwnedInventory(owned, expectedRetentionInventory(shortBatch));
      expect(owned.bytes.workflow_input).toBeGreaterThan(0);
    },
    async operation(_growth, scale, repetition) {
      return measureBatch(shortBatch, seriesName, scale, repetition, runs);
    },
    async verify(growth) {
      await verifyEmptyOwned(growth, seriesName);
    },
  });
  expectSelectorIndex(runs);
  expectDeletionStatements(report, shortBatch);
  expectStatusIndexOnly(report);
  expectBackgroundIndependent(report);
  const derived = retentionCompleteBatchWork(shortBatch, expectedRetentionInventory(shortBatch));
  expectDerivedStatements(report, derived);
  expectEngineEnvelope(report, false);
  logCompleteEvidence('payload byte workflow retention batch', report, runs, derived);
  expect(report.samples[0]!.cost.rows).toBe(report.samples[2]!.cost.rows);
}, 180_000);

test('a mixed-maximum neighbourhood stays bounded as unrelated workflow and payload history grow', async () => {
  const seriesName = 'mixed';
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'mixed maximum workflow retention batch',
    ...foldedCapture,
    scales,
    repetitions: 1,
    indexProbes: retentionIndexProbes(shortBatch),
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, seriesName, scale, previous);
      await growUnrelatedPayload(growth, seriesName, scale, previous);
      await seedEligible(growth, seriesName, 'warmup', shortBatch, scale * shortBatch, MIXED_MAX_RETENTION_PAYLOAD);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor(seriesName))).toBe(shortBatch);
    },
    async prepare(growth, scale) {
      const ids = await seedEligible(
        growth,
        seriesName,
        'eligible',
        shortBatch,
        scale * shortBatch,
        MIXED_MAX_RETENTION_PAYLOAD,
      );
      prepared.set(seriesName, ids);
      expectOwnedInventory(
        await readWorkflowRetentionOwned(growth.admin, ids),
        expectedRetentionInventory(shortBatch, MIXED_MAX_RETENTION_PAYLOAD),
      );
    },
    async operation(_growth, scale, repetition) {
      return measureBatch(shortBatch, seriesName, scale, repetition, runs);
    },
    async verify(growth) {
      await verifyEmptyOwned(growth, seriesName);
    },
  });
  expectSelectorIndex(runs);
  expectDeletionStatements(report, shortBatch);
  expectStatusIndexOnly(report);
  expectBackgroundIndependent(report);
  const derived = retentionCompleteBatchWork(
    shortBatch,
    expectedRetentionInventory(shortBatch, MIXED_MAX_RETENTION_PAYLOAD),
  );
  expect(derived.cascadeRows).toBeGreaterThan(shortBatch);
  expect(derived.nestedFkStatements).toBe(4);
  expectDerivedStatements(report, derived);
  expectEngineEnvelope(report, false);
  logCompleteEvidence('mixed maximum workflow retention batch', report, runs, derived);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
}, 180_000);

test('a short retention batch stays bounded as unrelated payload history grows', async () => {
  const seriesName = 'unrelated-payload';
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'unrelated payload workflow retention batch',
    ...foldedCapture,
    scales,
    repetitions: 1,
    indexProbes: retentionIndexProbes(shortBatch),
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelatedPayload(growth, seriesName, scale, previous);
      await seedEligible(growth, seriesName, 'warmup', shortBatch, scale * shortBatch);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor(seriesName))).toBe(shortBatch);
    },
    async prepare(growth, scale) {
      const ids = await seedEligible(growth, seriesName, 'eligible', shortBatch, scale * shortBatch);
      prepared.set(seriesName, ids);
      expectOwnedInventory(await readWorkflowRetentionOwned(growth.admin, ids), expectedRetentionInventory(shortBatch));
    },
    async operation(_growth, scale, repetition) {
      return measureBatch(shortBatch, seriesName, scale, repetition, runs);
    },
    async verify(growth) {
      await verifyEmptyOwned(growth, seriesName);
    },
  });
  expectSelectorIndex(runs);
  expectDeletionStatements(report, shortBatch);
  expectStatusIndexOnly(report);
  expectBackgroundIndependent(report);
  const derived = retentionCompleteBatchWork(shortBatch, expectedRetentionInventory(shortBatch));
  expectDerivedStatements(report, derived);
  expectEngineEnvelope(report, false);
  logCompleteEvidence('unrelated payload workflow retention batch', report, runs, derived);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
}, 180_000);

test('sparse and deep selected identities stay bounded as unrelated workflow history grows', async () => {
  const seriesName = 'sparse';
  const runs: RunEvidence[] = [];
  const report = await checkGrowth(db, {
    name: 'sparse deep workflow retention batch',
    ...foldedCapture,
    scales,
    repetitions: 1,
    indexProbes: retentionIndexProbes(shortBatch),
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => ({ selected: Number(value) }),
      bounds: { selected: 'constant' },
    },
    async grow(growth, scale, previous) {
      await growUnrelated(growth, seriesName, scale, previous);
      await growUnrelatedPayload(growth, seriesName, scale, previous);
      await seedSparseEligible(growth, seriesName, 'warmup', shortBatch, scale * shortBatch);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now, select, applicationFor(seriesName))).toBe(shortBatch);
    },
    async prepare(growth, scale) {
      const ids = await seedSparseEligible(growth, seriesName, 'eligible', shortBatch, scale * shortBatch);
      prepared.set(seriesName, ids);
      expectOwnedInventory(await readWorkflowRetentionOwned(growth.admin, ids), expectedRetentionInventory(shortBatch));
    },
    async operation(_growth, scale, repetition) {
      return measureBatch(shortBatch, seriesName, scale, repetition, runs);
    },
    async verify(growth) {
      await verifyEmptyOwned(growth, seriesName);
    },
  });
  expectSelectorIndex(runs);
  expectDeletionStatements(report, shortBatch);
  expectStatusIndexOnly(report);
  expectBackgroundIndependent(report);
  const derived = retentionCompleteBatchWork(shortBatch, expectedRetentionInventory(shortBatch));
  expectDerivedStatements(report, derived);
  expectEngineEnvelope(report, false);
  logCompleteEvidence('sparse deep workflow retention batch', report, runs, derived);
  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
}, 180_000);
