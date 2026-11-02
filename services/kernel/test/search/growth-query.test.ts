import { afterAll, beforeAll, expect, test } from 'bun:test';
import freshness from '../../src/search/freshness.sql';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const rowsPerScale = 500;
const consumer = 'growth_search_freshness';
const baseConsumerPrefix = 'growth_search_freshness_base_';
const allConsumerPrefix = 'growth_search_freshness_all_';
const anchorConsumerPrefix = 'growth_search_freshness_local_';
const eventType = 'com.rezics.search.growth.freshness.v1';
const partitions = Array.from({ length: 16 }, (_, index) => 3700 + index);
const anchorPartition = partitions[0]!;
const checkpointPosition = 100_000;

let db: GrowthDatabase | undefined;

function checkpoint(partition: number, name: string, position: number) {
  return { partition_no: partition, consumer: name, epoch: 1, position };
}

function event(partition: number, position: number, ordinal: number) {
  return {
    partition_no: partition,
    position,
    event_seq: 0,
    event_count: 1,
    epoch: 1,
    id: newId(partition * 16 + (ordinal % 16)),
    type: eventType,
    subject: null,
    data: { id: `growth-freshness-${ordinal}` },
  };
}

const basePopulation: Population = {
  name: 'search-growth-freshness-base',
  hotPartition: anchorPartition,
  rows: ({ ordinal }) => ({
    'core.outbox': [event(partitions[ordinal]!, checkpointPosition + 1, ordinal)],
    'core.consumer_checkpoint': [checkpoint(partitions[ordinal]!, consumer, checkpointPosition)],
  }),
  finish: async (admin) => {
    await admin.query(
      `UPDATE core.partition p SET position = GREATEST(p.position, x.position)
       FROM (SELECT partition_no, max(position) AS position FROM core.outbox WHERE type = $1 GROUP BY partition_no) x
       WHERE p.partition_no = x.partition_no`,
      [eventType],
    );
  },
};

const checkpointBaseline: Population = {
  name: 'search-growth-freshness-checkpoint-baseline',
  hotPartition: anchorPartition,
  rows: ({ ordinal }) => ({
    'core.consumer_checkpoint': [checkpoint(ordinal % 4096, `${baseConsumerPrefix}${Math.floor(ordinal / 4096)}`, 1)],
  }),
};

const growthPopulation: Population = {
  name: 'search-growth-freshness-history',
  hotPartition: anchorPartition,
  rows: ({ ordinal }) => {
    const other = partitions[1 + (ordinal % (partitions.length - 1))]!;
    const position = checkpointPosition + 2 + ordinal;
    const allConsumer = `${allConsumerPrefix}${Math.floor(ordinal / 4096)}`;
    return {
      'core.outbox': [event(anchorPartition, position, ordinal), event(other, position, ordinal + 1_000_000)],
      'core.consumer_checkpoint': [
        checkpoint(anchorPartition, `${anchorConsumerPrefix}${ordinal}`, 1),
        checkpoint(ordinal % 4096, allConsumer, 1),
      ],
    };
  },
  finish: async (admin) => {
    await admin.query(
      `UPDATE core.partition p SET position = GREATEST(p.position, x.position)
       FROM (SELECT partition_no, max(position) AS position FROM core.outbox WHERE type = $1 GROUP BY partition_no) x
       WHERE p.partition_no = x.partition_no`,
      [eventType],
    );
  },
};

async function reset(database: GrowthDatabase): Promise<void> {
  await database.admin.query(
    'DELETE FROM core.consumer_checkpoint WHERE consumer = $1 OR consumer LIKE $2 OR consumer LIKE $3 OR consumer LIKE $4',
    [consumer, `${baseConsumerPrefix}%`, `${allConsumerPrefix}%`, `${anchorConsumerPrefix}%`],
  );
  await database.admin.query('DELETE FROM core.outbox WHERE type = $1', [eventType]);
  await database.admin.query(
    'UPDATE core.partition p SET position = COALESCE((SELECT max(o.position) FROM core.outbox o WHERE o.partition_no = p.partition_no), 0) WHERE p.partition_no = ANY($1)',
    [partitions],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await reset(db);
  await seed({ pool: db.pool, admin: db.admin }, checkpointBaseline, { from: 0, to: 8 * 4096 });
  await seed({ pool: db.pool, admin: db.admin }, basePopulation, { from: 0, to: partitions.length });
});

afterAll(async () => {
  if (!db) return;
  try {
    await reset(db);
  } finally {
    await db.close();
  }
});

test('Freshness stays within its bound as H grows', async () => {
  const database = db!;
  const report = await checkGrowth(database, {
    name: 'Freshness',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, growthPopulation, {
        from: previous * rowsPerScale,
        to: scale * rowsPerScale,
      });
    },
    operation: async (growthDb) => {
      const row = await freshness.run(growthDb.pool, { consumer });
      expect(row.behind).toBe(partitions.length);
      expect(row.oldest).not.toBeNull();
      return row;
    },
  });
  for (const sample of report.samples) {
    console.info(
      JSON.stringify({
        evidence: 'search-growth-freshness',
        scale: sample.scale,
        population: sample.scale * rowsPerScale,
        rows: sample.cost.rows,
        blocks: sample.cost.blocks,
        statements: sample.cost.statements,
      }),
    );
  }
}, 90_000);
