import { afterAll, beforeAll, expect, test } from 'bun:test';
import retire from '../../src/search/retire.sql';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type GrowthReport,
  type Population,
  type ReportSample,
} from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

// Same-partition and global histories are separate seed populations at 64/512/4096; selected k stays 64.
const scales = [64, 512, 4096] as const;
const selectedCount = 64;
const selectedPartitions = Array.from({ length: selectedCount }, (_, index) => 3400 + index);
const anchorPartition = selectedPartitions[0]!;
const selectedRange = { start: selectedPartitions[0]!, end: selectedPartitions[selectedCount - 1]! };
const unrelatedSpan = 4096 - selectedCount;
const neighborPrefix = 'gsrr_nb_';
const neighbors = [`${neighborPrefix}0`, `${neighborPrefix}1`] as const;

type Path = 'nonempty' | 'replay' | 'absent';

const pathPrefix: Record<Path, string> = {
  nonempty: 'gsrrn_',
  replay: 'gsrrr_',
  absent: 'gsrra_',
};

let db: GrowthDatabase | undefined;
let neighborSnapshot: readonly { partition_no: number; consumer: string; epoch: number; position: string }[] = [];

function checkpoint(partition: number, consumer: string, position: number) {
  return { partition_no: partition, consumer, epoch: 1, position };
}

function unrelatedPartition(ordinal: number): number {
  const slot = ordinal % unrelatedSpan;
  return slot < selectedRange.start ? slot : slot + selectedCount;
}

function localPopulation(path: Path): Population {
  const prefix = `${pathPrefix[path]}loc_`;
  return {
    name: `search-growth-retire-replay-local-${path}`,
    hotPartition: anchorPartition,
    rows: ({ ordinal }) => ({
      'core.consumer_checkpoint': [checkpoint(anchorPartition, `${prefix}${ordinal}`, 1)],
    }),
  };
}

function globalPopulation(path: Path): Population {
  const prefix = `${pathPrefix[path]}all_`;
  return {
    name: `search-growth-retire-replay-global-${path}`,
    hotPartition: anchorPartition,
    rows: ({ ordinal }) => ({
      'core.consumer_checkpoint': [
        checkpoint(unrelatedPartition(ordinal), `${prefix}${Math.floor(ordinal / unrelatedSpan)}`, 1),
      ],
    }),
  };
}

function selectedConsumer(path: Path, repetition: number): string {
  return `${pathPrefix[path]}sel_${repetition}`;
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
    const deleted =
      node['Node Type'] === 'Delete' ||
      (node['Node Type'] === 'ModifyTable' &&
        node.Operation === 'Delete' &&
        node['Relation Name'] === 'consumer_checkpoint');
    return deleted ? sum + Number(node['Actual Rows'] ?? 0) : sum;
  }, 0);
}

async function insertSelected(database: GrowthDatabase, consumer: string): Promise<void> {
  await database.admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     SELECT partition_no, $1, 1, 1 FROM unnest($2::integer[]) AS partition_no`,
    [consumer, selectedPartitions],
  );
}

async function setupPath(database: GrowthDatabase, path: Path, consumer: string): Promise<void> {
  if (path === 'absent') return;
  await insertSelected(database, consumer);
  if (path === 'replay') await retire.run(database.pool, { consumer });
}

async function neighborRows(database: GrowthDatabase) {
  const { rows } = await database.admin.query<{
    partition_no: number;
    consumer: string;
    epoch: number;
    position: string;
  }>(
    `SELECT partition_no, consumer, epoch, position::text AS position
     FROM core.consumer_checkpoint WHERE consumer = ANY($1) ORDER BY partition_no, consumer`,
    [neighbors],
  );
  return rows;
}

async function countLike(database: GrowthDatabase, pattern: string): Promise<number> {
  const { rows } = await database.admin.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM core.consumer_checkpoint WHERE consumer LIKE $1',
    [pattern],
  );
  return rows[0]!.count;
}

function reportEvidence(path: Path, report: GrowthReport): void {
  for (const sample of report.samples) {
    const nodes = planNodes(
      sample.occurrenceRepetitions.flatMap((run) => run.statements.flatMap((item) => item.planDocuments)),
    );
    console.info(
      JSON.stringify({
        evidence: `search-growth-retire-${path}`,
        scale: sample.scale,
        statements: sample.cost.statements,
        rows: sample.cost.rows,
        blocks: sample.cost.blocks,
        sharedHit: sample.cost.sharedHit,
        sharedRead: sample.cost.sharedRead,
        removed: removedRows(nodes),
        statement: sample.statementRepetitions[0]?.[0]?.statement,
        node: sample.statementRepetitions[0]?.[0]?.node,
      }),
    );
  }
}

function assertRetirementSample(path: Path, sample: ReportSample): void {
  expect(sample.cost.statements).toBe(1);
  expect(sample.cost.catalogStatements).toBe(0);
  expect(sample.cost.blocks).toBeGreaterThan(0);
  expect(sample.cost.sharedHit + sample.cost.sharedRead).toBeGreaterThan(0);
  const empty = path !== 'nonempty';
  if (empty) expect(sample.cost.rows).toBeGreaterThanOrEqual(0);
  else expect(sample.cost.rows).toBeGreaterThanOrEqual(selectedCount);
  for (const [index, run] of sample.occurrenceRepetitions.entries()) {
    expect(run.statements).toHaveLength(1);
    const occurrence = run.statements[0]!;
    expect(occurrence.error).toBeNull();
    expect(occurrence.statement).toMatch(/DELETE\s+FROM\s+core\.consumer_checkpoint/i);
    expect(occurrence.blocks).toBeGreaterThan(0);
    const nodes = planNodes(occurrence.planDocuments);
    const consumerIndex = nodes.find(
      (node) =>
        node['Index Name'] === 'consumer_checkpoint_consumer_idx' && Number(node['Actual Loops'] ?? 0) > 0,
    );
    expect(consumerIndex).toBeDefined();
    expect(
      nodes.some((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'consumer_checkpoint'),
    ).toBe(false);
    const removed = removedRows(nodes);
    if (empty) {
      expect(removed).toBe(0);
      expect(occurrence.rows).toBeGreaterThanOrEqual(0);
    } else {
      expect(removed).toBe(selectedCount);
      expect(occurrence.rows).toBeGreaterThanOrEqual(selectedCount);
    }
    expect(sample.statementRepetitions[index]?.[0]?.statement).toBe(occurrence.statement);
  }
}

async function assertPreserved(database: GrowthDatabase, path: Path): Promise<void> {
  expect(await neighborRows(database)).toEqual(neighborSnapshot);
  expect(await countLike(database, `${pathPrefix[path]}sel_%`)).toBe(0);
  expect(await countLike(database, `${pathPrefix[path]}loc_%`)).toBe(scales[2]);
  expect(await countLike(database, `${pathPrefix[path]}all_%`)).toBe(scales[2]);
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1', ['gsrr%']);
  await db.admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     SELECT partition_no, consumer, 1, 1
     FROM unnest($1::integer[]) AS partition_no
     CROSS JOIN unnest($2::text[]) AS consumer`,
    [selectedPartitions, neighbors],
  );
  neighborSnapshot = await neighborRows(db);
});

afterAll(async () => {
  if (!db) return;
  try {
    await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1', ['gsrr%']);
  } finally {
    await db.close();
  }
});

for (const path of ['nonempty', 'replay', 'absent'] as const) {
  test(`Retire ${path} stays within its selected-consumer bound as same-partition and global history grow`, async () => {
    const database = db!;
    const report = await checkGrowth(database, {
      name: `Search retire ${path}`,
      scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (growthDb, scale, previous) => {
        await seed({ pool: growthDb.pool, admin: growthDb.admin }, localPopulation(path), {
          from: previous,
          to: scale,
        });
        await seed({ pool: growthDb.pool, admin: growthDb.admin }, globalPopulation(path), {
          from: previous,
          to: scale,
        });
      },
      warmup: async (growthDb, _scale, repetition) => {
        const consumer = selectedConsumer(path, repetition);
        await setupPath(growthDb, path, consumer);
        await retire.run(growthDb.pool, { consumer });
      },
      prepare: async (growthDb, _scale, repetition) => {
        await setupPath(growthDb, path, selectedConsumer(path, repetition));
      },
      operation: async (growthDb, _scale, repetition) => {
        await retire.run(growthDb.pool, { consumer: selectedConsumer(path, repetition) });
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    for (const sample of report.samples) assertRetirementSample(path, sample);
    assertGrowthAccessPaths(report.name, report.samples, ['core.consumer_checkpoint']);
    await assertPreserved(database, path);
    reportEvidence(path, report);
  }, 180_000);
}
