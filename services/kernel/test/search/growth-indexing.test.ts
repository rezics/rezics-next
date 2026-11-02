import { afterAll, beforeAll, test } from 'bun:test';
import reconcile from '../../src/search/reconcile.sql';
import retire from '../../src/search/retire.sql';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const rowsPerScale = 500;
const reconcileConsumer = 'growth_search_reconcile';
const reconcileBaseOthers = 'growth_search_reconcile_base_';
const reconcileOthers = 'growth_search_reconcile_all_';
const reconcileAnchorOthers = 'growth_search_reconcile_local_';
const reconcileType = 'com.rezics.search.growth.reconcile.v1';
const reconcilePartitions = Array.from({ length: 32 }, (_, index) => 3900 + index);
const reconcileAnchor = reconcilePartitions[0]!;
const retireOthers = 'growth_search_retire_all_';
const retireBaseOthers = 'growth_search_retire_base_';
const retireAnchorOthers = 'growth_search_retire_local_';
const retiredConsumerPrefix = 'growth_search_retired_';
const retireAnchor = 3940;

let db: GrowthDatabase | undefined;

function checkpoint(partition: number, consumer: string, position: number) {
  return { partition_no: partition, consumer, epoch: 1, position };
}

function outbox(partition: number, position: number, ordinal: number, type: string) {
  return {
    partition_no: partition,
    position,
    event_seq: 0,
    event_count: 1,
    epoch: 1,
    id: newId(partition * 16 + (ordinal % 16)),
    type,
    subject: null,
    data: { id: `growth-${ordinal}` },
  };
}

function checkpointGrowth(
  name: string,
  anchorPartition: number,
  allConsumerPrefix: string,
  anchorConsumerPrefix: string,
): Population {
  return {
    name,
    hotPartition: anchorPartition,
    rows: ({ ordinal }) => {
      const globalPartition = ordinal % 4096;
      const allConsumer = `${allConsumerPrefix}${Math.floor(ordinal / 4096)}`;
      return {
        'core.consumer_checkpoint': [
          checkpoint(anchorPartition, `${anchorConsumerPrefix}${ordinal}`, 1),
          checkpoint(globalPartition, allConsumer, 1),
        ],
      };
    },
  };
}

function fullConsumerPopulation(name: string, anchorPartition: number, prefix: string): Population {
  return {
    name,
    hotPartition: anchorPartition,
    rows: ({ ordinal }) => ({
      'core.consumer_checkpoint': [checkpoint(ordinal % 4096, `${prefix}${Math.floor(ordinal / 4096)}`, 1)],
    }),
  };
}

const reconcilePopulation: Population = {
  name: 'search-growth-reconcile',
  hotPartition: reconcileAnchor,
  rows: ({ ordinal }) => {
    const other = reconcilePartitions[1 + (ordinal % (reconcilePartitions.length - 1))]!;
    const position = 100_000 + ordinal + 1;
    const allConsumer = `${reconcileOthers}${Math.floor(ordinal / 4096)}`;
    return {
      'core.outbox': [
        outbox(reconcileAnchor, position, ordinal, reconcileType),
        outbox(other, position, ordinal + 1_000_000, reconcileType),
      ],
      'core.consumer_checkpoint': [
        checkpoint(reconcileAnchor, `${reconcileAnchorOthers}${ordinal}`, 1),
        checkpoint(ordinal % 4096, allConsumer, 1),
      ],
    };
  },
  finish: async (admin) => {
    await admin.query(
      `UPDATE core.partition p SET position = GREATEST(p.position, x.position)
       FROM (SELECT partition_no, max(position) AS position FROM core.outbox WHERE type = $1 GROUP BY partition_no) x
       WHERE p.partition_no = x.partition_no`,
      [reconcileType],
    );
  },
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1 OR consumer LIKE $2', [
    `${reconcileOthers}%`,
    `${reconcileAnchorOthers}%`,
  ]);
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1', [`${reconcileBaseOthers}%`]);
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1 OR consumer LIKE $2', [
    `${retireOthers}%`,
    `${retireAnchorOthers}%`,
  ]);
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1', [`${retireBaseOthers}%`]);
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1', [`${retiredConsumerPrefix}%`]);
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = $1', [reconcileConsumer]);
  await db.admin.query('DELETE FROM core.outbox WHERE type = ANY($1)', [[reconcileType]]);
  await db.admin.query(
    'UPDATE core.partition p SET position = COALESCE((SELECT max(o.position) FROM core.outbox o WHERE o.partition_no = p.partition_no), 0) WHERE p.partition_no = ANY($1)',
    [reconcilePartitions],
  );
  await db.admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     SELECT partition_no, $1, 1, 1 FROM unnest($2::integer[]) AS partition_no`,
    [reconcileConsumer, reconcilePartitions],
  );
  await seed(
    { pool: db.pool, admin: db.admin },
    fullConsumerPopulation('search-growth-reconcile-baseline', reconcileAnchor, reconcileBaseOthers),
    { from: 0, to: 8 * 4096 },
  );
  await seed(
    { pool: db.pool, admin: db.admin },
    fullConsumerPopulation('search-growth-retire-baseline', retireAnchor, retireBaseOthers),
    { from: 0, to: 8 * 4096 },
  );
});

afterAll(async () => {
  if (!db) return;
  try {
    await db.admin.query(
      'DELETE FROM core.consumer_checkpoint WHERE consumer = $1 OR consumer LIKE $2 OR consumer LIKE $3 OR consumer LIKE $4 OR consumer LIKE $5 OR consumer LIKE $6 OR consumer LIKE $7',
      [
        reconcileConsumer,
        `${reconcileOthers}%`,
        `${reconcileAnchorOthers}%`,
        `${reconcileBaseOthers}%`,
        `${retireOthers}%`,
        `${retireAnchorOthers}%`,
        `${retireBaseOthers}%`,
      ],
    );
    await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1', [`${retiredConsumerPrefix}%`]);
    await db.admin.query('DELETE FROM core.outbox WHERE type = $1', [reconcileType]);
    await db.admin.query(
      'UPDATE core.partition p SET position = COALESCE((SELECT max(o.position) FROM core.outbox o WHERE o.partition_no = p.partition_no), 0) WHERE p.partition_no = ANY($1)',
      [reconcilePartitions],
    );
  } finally {
    await db.close();
  }
});

test('Reconcile stays within its bound as P grows', async () => {
  const database = db!;
  const population = reconcilePopulation;
  const report = await checkGrowth(database, {
    name: 'Reconcile',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
        from: previous * rowsPerScale,
        to: scale * rowsPerScale,
      });
    },
    operation: async (growthDb) => {
      const rows = await reconcile.run(growthDb.pool, { consumer: reconcileConsumer });
      const found = new Set(rows.map((row) => Number(row.partition)));
      if (reconcilePartitions.some((partition) => !found.has(partition)))
        throw new Error('Reconcile did not return the fixed nonempty partition set');
      return rows;
    },
  });
  for (const sample of report.samples) {
    console.info(
      JSON.stringify({
        evidence: 'search-growth-reconcile',
        scale: sample.scale,
        population: sample.scale * rowsPerScale,
        rows: sample.cost.rows,
        blocks: sample.cost.blocks,
        statements: sample.cost.statements,
      }),
    );
  }
}, 90_000);

test('Retire stays within its bound as P grows', async () => {
  const database = db!;
  const population = checkpointGrowth('search-growth-retire', retireAnchor, retireOthers, retireAnchorOthers);
  const report = await checkGrowth(database, {
    name: 'Retire',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
        from: previous * rowsPerScale,
        to: scale * rowsPerScale,
      });
    },
    operation: async (growthDb, _scale, repetition) => {
      const consumer = `${retiredConsumerPrefix}${repetition}`;
      const partitions = Array.from({ length: 64 }, (_, index) => 3800 + index);
      await growthDb.admin.query(
        `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
         SELECT partition_no, $1, 1, 1 FROM unnest($2::integer[]) AS partition_no`,
        [consumer, partitions],
      );
      await retire.run(growthDb.pool, { consumer });
      const result = await growthDb.admin.query(
        'SELECT count(*)::integer AS count FROM core.consumer_checkpoint WHERE consumer = $1',
        [consumer],
      );
      if (result.rows[0]?.count !== 0) throw new Error('Retire left checkpoints for the retired consumer');
    },
  });
  for (const sample of report.samples) {
    console.info(
      JSON.stringify({
        evidence: 'search-growth-retire',
        scale: sample.scale,
        population: sample.scale * rowsPerScale,
        rows: sample.cost.rows,
        blocks: sample.cost.blocks,
        statements: sample.cost.statements,
      }),
    );
  }
}, 90_000);
