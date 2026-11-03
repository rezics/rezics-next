import { afterAll, beforeAll, expect, test } from 'bun:test';
import reconcile from '../../src/search/reconcile.sql';
import { newId } from '../../src/route/route.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type Cost,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

// Owner anchors (Search README Reconcile): one reconcile.sql statement reads the finite
// 4096-partition map and one consumer's checkpoints; rows O(4096), blocks O(4096*L(P)).
const partitionDomain = 4096;
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

function removedRows(plans: readonly unknown[]): number {
  let removed = 0;
  const visit = (node: Record<string, unknown>) => {
    const loops = typeof node['Actual Loops'] === 'number' ? node['Actual Loops'] : 1;
    for (const field of ['Rows Removed by Filter', 'Rows Removed by Index Recheck'] as const) {
      const value = node[field];
      if (typeof value === 'number') removed += value * loops;
    }
    if (Array.isArray(node.Plans)) for (const child of node.Plans) visit(child as Record<string, unknown>);
  };
  for (const document of plans) {
    const entries = Array.isArray(document) ? document : [document];
    for (const entry of entries) {
      if (typeof entry === 'object' && entry !== null && 'Plan' in entry)
        visit((entry as { Plan: Record<string, unknown> }).Plan);
    }
  }
  return removed;
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

async function measureIdle(growthDb: GrowthDatabase) {
  const idle = (await reconcile.run(growthDb.pool, { consumer: idleConsumer })) as ReconcileRow[];
  const absent = (await reconcile.run(growthDb.pool, { consumer: absentConsumer })) as ReconcileRow[];
  const control = (await reconcile.run(growthDb.pool, { consumer: controlConsumer })) as ReconcileRow[];
  const pending = pendingOf(idle);
  if (pending.length !== 0) {
    throw new Error(`Idle reconcile returned ${pending.length} pending partitions for a caught-up consumer`);
  }
  const absentZero = absent.filter((row) => numeric(row.checkpoint) === 0n).length;
  if (absentZero !== absent.length) {
    throw new Error('Absent-consumer reconcile did not COALESCE missing checkpoints to 0');
  }
  const controlHits = controlPartitions.filter((partition) => {
    const row = control.find((entry) => Number(entry.partition) === partition);
    return row !== undefined && numeric(row.head) > numeric(row.checkpoint);
  }).length;
  if (controlHits !== controlPartitions.length) {
    throw new Error('Control consumer was not pending on the fixed nonempty partition set');
  }
  return {
    pending: pending.length,
    returned: idle.length,
    controlHits,
    absentZero,
    absentReturned: absent.length,
  };
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
  await db.admin.query(
    `UPDATE core.partition p SET position = GREATEST(p.position, $2) WHERE p.partition_no = ANY($1)`,
    [controlPartitions, historyBase],
  );
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
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    counted: {
      read: (value) => value as Awaited<ReturnType<typeof measureIdle>>,
      limits: { pending: 0, controlHits: controlPartitions.length },
      bounds: {
        pending: 'constant',
        returned: 'constant',
        controlHits: 'constant',
        absentZero: 'constant',
        absentReturned: 'constant',
      },
    },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, unrelatedCheckpoints, { from: previous, to: scale });
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, outboxHistory, { from: previous, to: scale });
    },
    operation: measureIdle,
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  for (const sample of report.samples) {
    expect(sample.counted?.pending?.value).toBe(0);
    expect(sample.counted?.controlHits?.value).toBe(controlPartitions.length);
    expect(sample.counted?.absentZero?.value).toBe(sample.counted?.absentReturned?.value);
    expect(sample.cost.rows, `examined rows at scale ${sample.scale}`).toBeGreaterThanOrEqual(partitionDomain);
    expect(sample.cost.rows).toBeGreaterThan(sample.counted!.pending.value);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    expect(sample.cost.sharedHit + sample.cost.sharedRead).toBe(sample.cost.blocks);
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.failedStatements).toBeUndefined();
    const partitions = relation(sample.cost, 'partition');
    expect(partitions?.rows, `partition-domain rows at scale ${sample.scale}`).toBeGreaterThanOrEqual(partitionDomain);
    expect(partitions?.sequentialScans).toBeGreaterThan(0);
    expect(
      Object.keys(sample.cost.relations).some((name) => name.includes('outbox')),
      'idle reconcile must not scan outbox history',
    ).toBe(false);
    for (const [index, cost] of sample.repetitions.entries()) {
      expect(cost.rows).toBeGreaterThanOrEqual(partitionDomain);
      expect(sample.counted!.pending.repetitions[index]).toBe(0);
      expect(sample.counted!.controlHits.repetitions[index]).toBe(controlPartitions.length);
    }
    console.info(
      JSON.stringify({
        evidence: 'search-growth-idle-reconcile',
        scale: sample.scale,
        statements: sample.cost.statements,
        rows: sample.cost.rows,
        blocks: sample.cost.blocks,
        sharedHit: sample.cost.sharedHit,
        sharedRead: sample.cost.sharedRead,
        backgroundStatements: sample.cost.backgroundStatements ?? 0,
        backgroundRows: sample.cost.backgroundRows ?? 0,
        pending: sample.counted?.pending?.value,
        returned: sample.counted?.returned?.value,
        controlHits: sample.counted?.controlHits?.value,
        absentZero: sample.counted?.absentZero?.value,
      }),
    );
  }
  const measured = await capture(database, () => measureIdle(database));
  const removed = removedRows(measured.capture.plans);
  const cost = costOf(measured.capture);
  console.info(
    JSON.stringify({
      evidence: 'search-growth-idle-reconcile-plan',
      statements: cost.statements,
      rows: cost.rows,
      removed,
      blocks: cost.blocks,
      sharedHit: cost.sharedHit,
      sharedRead: cost.sharedRead,
      backgroundStatements: cost.backgroundStatements ?? 0,
      backgroundRows: cost.backgroundRows ?? 0,
    }),
  );
  expect(cost.rows).toBeGreaterThanOrEqual(partitionDomain);
  expect(removed).toBeGreaterThanOrEqual(0);
  expect(cost.sharedHit + cost.sharedRead).toBe(cost.blocks);
}, 120_000);
