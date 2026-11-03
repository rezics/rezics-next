import { afterAll, beforeAll, expect, test } from 'bun:test';
import reconcile from '../../src/search/reconcile.sql';
import { newId } from '../../src/route/route.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type Cost,
  type GrowthDatabase,
  type Population,
  type ReportSample,
} from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

// Search README Reconcile: one reconcile.sql statement, O(4096) rows, indexed O(4096*L(P)) blocks.
const partitionDomain = 4096;
const scales = [64, 512, 4096] as const;
const idleConsumer = 'growth_search_idle';
const absentConsumer = 'growth_search_idle_none';
const controlConsumer = 'growth_search_idle_ctrl';
const baseOthers = 'growth_search_idle_base_';
const allOthers = 'growth_search_idle_all_';
const anchorOthers = 'growth_search_idle_loc_';
const eventType = 'com.rezics.search.growth.idle_reconcile.v1';
const controlPartitions = Array.from({ length: 16 }, (_, index) => 3500 + index);
const anchorPartition = controlPartitions[0]!;
const historyBase = 50_000_000;

type ReconcileRow = { partition: number; head: string | bigint | number; checkpoint: string | bigint | number };

let db: GrowthDatabase | undefined;

function checkpoint(partition: number, consumer: string, position: number) {
  return { partition_no: partition, consumer, epoch: 1, position };
}

function outbox(partition: number, position: number, ordinal: number) {
  return {
    partition_no: partition,
    position,
    event_seq: 0,
    event_count: 1,
    epoch: 1,
    id: newId(partition * 16 + (ordinal % 16)),
    type: eventType,
    subject: null,
    data: { id: `growth-idle-${ordinal}` },
  };
}

function numeric(value: ReconcileRow['head']): bigint {
  return BigInt(value);
}

function pendingOf(rows: readonly ReconcileRow[]): ReconcileRow[] {
  return rows.filter((row) => numeric(row.head) > numeric(row.checkpoint));
}

function relation(cost: Cost, name: string) {
  return Object.entries(cost.relations).find(([key]) => key === name || key.endsWith(`.${name}`))?.[1];
}

function planNodes(plans: readonly unknown[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    nodes.push(node);
    if (Array.isArray(node.Plans)) for (const child of node.Plans) visit(child);
  };
  for (const plan of plans) {
    for (const entry of Array.isArray(plan) ? plan : [plan]) {
      if (entry && typeof entry === 'object' && 'Plan' in entry) visit((entry as { Plan: unknown }).Plan);
    }
  }
  return nodes;
}

function removedRows(nodes: readonly Record<string, unknown>[]): number {
  return nodes.reduce((sum, node) => {
    const loops = typeof node['Actual Loops'] === 'number' ? node['Actual Loops'] : 1;
    return (
      sum +
      (typeof node['Rows Removed by Filter'] === 'number' ? node['Rows Removed by Filter'] * loops : 0) +
      (typeof node['Rows Removed by Index Recheck'] === 'number' ? node['Rows Removed by Index Recheck'] * loops : 0)
    );
  }, 0);
}

function sampleRemoved(sample: ReportSample): number {
  return removedRows(
    sample.occurrenceRepetitions.flatMap((run) => run.statements.flatMap((item) => planNodes(item.planDocuments))),
  );
}

async function catchUp(admin: GrowthDatabase['admin'], consumer: string): Promise<void> {
  await admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     SELECT partition_no, $1, 1, position FROM core.partition WHERE position > 0
     ON CONFLICT (partition_no, consumer) DO UPDATE
     SET epoch = 1, position = EXCLUDED.position`,
    [consumer],
  );
}

const unrelatedCheckpoints: Population = {
  name: 'search-growth-idle-checkpoints',
  hotPartition: anchorPartition,
  rows: ({ ordinal }) => ({
    'core.consumer_checkpoint': [
      checkpoint(ordinal % partitionDomain, `${allOthers}${Math.floor(ordinal / partitionDomain)}`, 1),
      checkpoint(anchorPartition, `${anchorOthers}${ordinal}`, 1),
    ],
  }),
};

const outboxHistory: Population = {
  name: 'search-growth-idle-history',
  hotPartition: anchorPartition,
  rows: ({ ordinal }) => {
    const other = controlPartitions[1 + (ordinal % (controlPartitions.length - 1))]!;
    const position = historyBase + 1 + ordinal;
    return { 'core.outbox': [outbox(anchorPartition, position, ordinal), outbox(other, position, ordinal + 1_000_000)] };
  },
  finish: async (admin) => {
    await admin.query(
      `UPDATE core.partition p SET position = GREATEST(p.position, x.position)
       FROM (SELECT partition_no, max(position) AS position FROM core.outbox WHERE type = $1 GROUP BY partition_no) x
       WHERE p.partition_no = x.partition_no`,
      [eventType],
    );
    await catchUp(admin, idleConsumer);
  },
};

const checkpointBaseline: Population = {
  name: 'search-growth-idle-baseline',
  hotPartition: anchorPartition,
  rows: ({ ordinal }) => ({
    'core.consumer_checkpoint': [
      checkpoint(ordinal % partitionDomain, `${baseOthers}${Math.floor(ordinal / partitionDomain)}`, 1),
    ],
  }),
};

async function reset(database: GrowthDatabase): Promise<void> {
  await database.admin.query(
    'DELETE FROM core.consumer_checkpoint WHERE consumer = ANY($1) OR consumer LIKE $2 OR consumer LIKE $3 OR consumer LIKE $4',
    [[idleConsumer, absentConsumer, controlConsumer], `${baseOthers}%`, `${allOthers}%`, `${anchorOthers}%`],
  );
  await database.admin.query('DELETE FROM core.outbox WHERE type = $1', [eventType]);
  await database.admin.query(
    'UPDATE core.partition p SET position = COALESCE((SELECT max(o.position) FROM core.outbox o WHERE o.partition_no = p.partition_no), 0) WHERE p.partition_no = ANY($1)',
    [controlPartitions],
  );
}

async function assertControlPending(growthDb: GrowthDatabase): Promise<void> {
  const control = (await reconcile.run(growthDb.pool, { consumer: controlConsumer })) as ReconcileRow[];
  const hits = controlPartitions.filter((partition) => {
    const row = control.find((entry) => Number(entry.partition) === partition);
    return row !== undefined && numeric(row.head) > numeric(row.checkpoint);
  }).length;
  if (hits !== controlPartitions.length) {
    throw new Error('Control consumer was not pending on the fixed nonempty partition set');
  }
}

async function measureIdle(growthDb: GrowthDatabase) {
  const idle = (await reconcile.run(growthDb.pool, { consumer: idleConsumer })) as ReconcileRow[];
  const absent = (await reconcile.run(growthDb.pool, { consumer: absentConsumer })) as ReconcileRow[];
  if (pendingOf(idle).length !== 0) {
    throw new Error(`Idle reconcile returned ${pendingOf(idle).length} pending partitions for a caught-up consumer`);
  }
  if (idle.length < controlPartitions.length) {
    throw new Error('Caught-up reconcile hid the nonempty partition domain behind zero returned rows');
  }
  if (absent.some((row) => numeric(row.checkpoint) !== 0n) || absent.length !== idle.length) {
    throw new Error(
      'Absent-consumer reconcile did not COALESCE missing checkpoints to 0 over the same nonempty domain',
    );
  }
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await reset(db);
  await seed({ pool: db.pool, admin: db.admin }, checkpointBaseline, { from: 0, to: 8 * partitionDomain });
  for (const partition of controlPartitions) {
    await db.admin.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       VALUES ($1, $2, 0, 1, 1, $3, $4, NULL, $5)`,
      [partition, historyBase, newId(partition * 16), eventType, { id: 'idle-control' }],
    );
  }
  await db.admin.query(`UPDATE core.partition p SET position = GREATEST(p.position, $2) WHERE p.partition_no = ANY($1)`, [
    controlPartitions,
    historyBase,
  ]);
  await db.admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     SELECT partition_no, $1, 1, 1 FROM unnest($2::integer[]) AS partition_no`,
    [controlConsumer, controlPartitions],
  );
  await catchUp(db.admin, idleConsumer);
}, 90_000);

afterAll(async () => {
  if (!db) return;
  try {
    await reset(db);
  } finally {
    await db.close();
  }
});

test('Idle Search reconcile stays within its finite-domain bound as unrelated checkpoints and outbox history grow', async () => {
  const database = db!;
  const report = await checkGrowth(database, {
    name: 'Idle Search reconcile',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, unrelatedCheckpoints, { from: previous, to: scale });
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, outboxHistory, { from: previous, to: scale });
    },
    prepare: assertControlPending,
    operation: measureIdle,
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    const removed = sampleRemoved(sample);
    expect(sample.cost.statements).toBe(2);
    expect(sample.cost.rows, `examined rows at scale ${sample.scale}`).toBeGreaterThanOrEqual(partitionDomain);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    expect(sample.cost.sharedHit + sample.cost.sharedRead).toBe(sample.cost.blocks);
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(relation(sample.cost, 'partition')?.rows).toBeGreaterThanOrEqual(partitionDomain);
    expect(Object.keys(sample.cost.relations).some((name) => name.includes('outbox'))).toBe(false);
    for (const [index, cost] of sample.repetitions.entries()) {
      expect(cost.rows).toBeGreaterThanOrEqual(partitionDomain);
      expect(cost.statements).toBe(2);
      const run = sample.occurrenceRepetitions[index];
      expect(run?.statements).toHaveLength(2);
      expect(run?.statements.every((item) => item.error === null)).toBe(true);
    }
    console.info(
      JSON.stringify({
        evidence: 'search-growth-idle-reconcile',
        scale: sample.scale,
        statements: sample.cost.statements,
        rows: sample.cost.rows,
        removed,
        blocks: sample.cost.blocks,
        sharedHit: sample.cost.sharedHit,
        sharedRead: sample.cost.sharedRead,
        backgroundStatements: sample.cost.backgroundStatements ?? 0,
        backgroundRows: sample.cost.backgroundRows ?? 0,
      }),
    );
  }
}, 180_000);
