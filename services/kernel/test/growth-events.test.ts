import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../src/database/pool.ts';
import { newId } from '../src/route/route.ts';
import { readBatch } from '../src/events/log.ts';
import readLog from '../src/events/read-log.sql';
import ensureCheckpoint from '../src/events/ensure-checkpoint.sql';
import { checkGrowth, openGrowthDatabase, placement, seed, type GrowthDatabase, type Population } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const anchorPartition = 3100;
const consumer = 'growth_probe';
const ordinalsPerScale = 500;
const payload = { id: '00000000-0000-7000-8000-000000000001' };
let db: GrowthDatabase | undefined;

// Outbox rows use routed UUIDs, one valid subject-created event per position, and heads restored like fence writes.
const events: Population = {
  name: 'growth-events-outbox',
  hotPartition: anchorPartition,
  rows: ({ ordinal, route: rowRoute }) => ({
    'core.outbox': [{
      partition_no: rowRoute >>> 4,
      position: ordinal + 1,
      event_seq: 0,
      event_count: 1,
      epoch: 1,
      id: newId(rowRoute),
      type: 'com.rezics.subject.created.v1',
      subject: null,
      data: payload,
    }],
  }),
  finish: async (admin, range) => {
    if (range.to === 0) return;
    await admin.query(`UPDATE core.partition p SET position = GREATEST(p.position, x.position)
      FROM (SELECT partition_no, max(position) AS position FROM core.outbox GROUP BY partition_no) x
      WHERE p.partition_no = x.partition_no`);
  },
};

// Checkpoints share one fixed consumer in other partitions, matching the production composite primary key.
const checkpoints: Population = {
  name: 'growth-events-checkpoints',
  hotPartition: anchorPartition,
  rows: ({ ordinal, partition }) => ({
    'core.consumer_checkpoint': [{ partition_no: partition, consumer: `consumer_${ordinal}`, epoch: null, position: 0 }],
  }),
};

const anchor = placement(events, 0);

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = $1', [consumer]);
  await db.admin.query('DELETE FROM core.outbox WHERE partition_no = $1', [anchorPartition]);
  await db.admin.query('UPDATE core.partition SET position = 0, epoch = 1 WHERE partition_no = $1', [anchorPartition]);
  // Establish the measured consumer through the production relay path before any scale is added.
  await readBatch(db.pool, { consumer, partition: anchorPartition, apply: async () => {} });
  // Keep a fixed anchor history before the checkpoint so the measured log probe starts deep in it.
  await seed({ pool: db.pool, admin: db.admin }, events, { from: 0, to: ordinalsPerScale * 2 });
  await db.admin.query(
    `UPDATE core.consumer_checkpoint SET epoch = 1, position = 500 WHERE partition_no = $1 AND consumer = $2`,
    [anchorPartition, consumer],
  );
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = $1 OR consumer LIKE $2', [consumer, 'consumer_%']);
  await db.admin.query('DELETE FROM core.outbox WHERE partition_no = $1', [anchorPartition]);
  await db.admin.query('UPDATE core.partition SET position = 0, epoch = 1 WHERE partition_no = $1', [anchorPartition]);
  await db.close();
});

test('Batch checkpoints stays within its bound as C grows', async () => {
  const database = db!;
  await checkGrowth(database, {
    name: 'Batch checkpoints',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, checkpoints, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
    },
    operation: (growthDb) => withConnection(growthDb.pool, (client) =>
      ensureCheckpoint.run(client, { partition_no: anchorPartition, consumer }),
    ),
  });
}, 90_000);

test('Batch log stays within its bound as H grows', async () => {
  const database = db!;
  await checkGrowth(database, {
    name: 'Batch log',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, events, {
        from: ordinalsPerScale * 2 + previous * ordinalsPerScale,
        to: ordinalsPerScale * 2 + scale * ordinalsPerScale,
      });
    },
    operation: (growthDb) => withConnection(growthDb.pool, (client) =>
      readLog.run(client, { partition_no: anchorPartition, position: 500n, envelopes: 1 }),
    ),
  });
}, 90_000);
