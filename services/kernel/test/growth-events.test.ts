import { afterAll, beforeAll, test } from 'bun:test';
import { withConnection } from '../src/database/pool.ts';
import { runCommand } from '../src/command/command.ts';
import { newId } from '../src/route/route.ts';
import { readBatch } from '../src/events/log.ts';
import ensureCheckpoint from '../src/events/ensure-checkpoint.sql';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const anchorPartition = 3100;
const otherPartition = 3101;
const consumer = 'growth_events_probe';
const batchLogConsumer = 'growth_events_log_probe';
const scaledConsumerPrefix = 'growth_events_scale_';
const ordinalsPerScale = 500;
const checkpointPosition = 50_000;
const batchLogCheckpointPosition = 150_000;
const payload = { id: '00000000-0000-7000-8000-000000000001' };
let db: GrowthDatabase | undefined;

// Outbox rows mirror fence inserts with routed IDs and single-event envelopes; paired anchor rows grow history on both sides of the fixed checkpoint.
function eventPopulation(name: string, historyPosition: number): Population {
  return {
    name,
    hotPartition: anchorPartition,
    rows: ({ ordinal, route: rowRoute }) => {
      const anchorRoute = anchorPartition * 16 + (rowRoute % 16);
      const otherRoute = otherPartition * 16 + (rowRoute % 16);
      const row = (route: number, position: number) => ({
        partition_no: route >>> 4,
        position,
        event_seq: 0,
        event_count: 1,
        epoch: 1,
        id: newId(route),
        type: 'com.rezics.subject.created.v1',
        subject: null,
        data: payload,
      });
      return {
        'core.outbox': [
          row(anchorRoute, historyPosition - 1 - ordinal),
          row(anchorRoute, historyPosition + 1 + ordinal),
          row(otherRoute, historyPosition + ordinal + 1),
        ],
      };
    },
    finish: async (admin, range) => {
      if (range.to === 0) return;
      await admin.query(
        `UPDATE core.partition p SET position = GREATEST(p.position, x.position)
      FROM (SELECT partition_no, max(position) AS position FROM core.outbox
            WHERE partition_no = ANY($1) GROUP BY partition_no) x
      WHERE p.partition_no = x.partition_no`,
        [[anchorPartition, otherPartition]],
      );
    },
  };
}

// Outbox rows mirror fence inserts with routed IDs and single-event envelopes, around a fixed deep checkpoint.
const events = eventPopulation('growth-events-outbox', checkpointPosition);
// A separate history range keeps both tests' seeded outbox keys unique in the shared database.
const batchLogEvents = eventPopulation('growth-events-batch-log-outbox', batchLogCheckpointPosition);

// Checkpoint rows share the production composite key and distribute new consumers across the anchor and other partitions.
const checkpoints: Population = {
  name: 'growth-events-checkpoints',
  hotPartition: anchorPartition,
  rows: ({ ordinal, partition }) => ({
    'core.consumer_checkpoint': [
      {
        partition_no: partition,
        consumer: `${scaledConsumerPrefix}${ordinal}`,
      },
    ],
  }),
};

// These rows use the production checkpoint key shape and separate consumers because both checks share a database.
const batchLogCheckpoints: Population = {
  name: 'growth-events-batch-log-checkpoints',
  hotPartition: anchorPartition,
  rows: ({ ordinal, partition }) => ({
    'core.consumer_checkpoint': [
      {
        partition_no: partition,
        consumer: `growth_events_scale_log_${ordinal}`,
      },
    ],
  }),
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = ANY($1) OR consumer LIKE $2', [
    [consumer, batchLogConsumer],
    `${scaledConsumerPrefix}%`,
  ]);
  await db.admin.query('DELETE FROM core.outbox WHERE partition_no = ANY($1)', [[anchorPartition, otherPartition]]);
  await db.admin.query('UPDATE core.partition SET position = 0, epoch = 1 WHERE partition_no = ANY($1)', [
    [anchorPartition, otherPartition],
  ]);
  // Create the anchor event and consumer through the command and relay production paths before any scale is added.
  await runCommand(db.pool, { partition: anchorPartition }, async () => ({
    value: null,
    events: [{ type: 'com.rezics.subject.created.v1', data: payload }],
  }));
  await readBatch(db.pool, { consumer, partition: anchorPartition, apply: async () => {} });
  await readBatch(db.pool, { consumer: batchLogConsumer, partition: anchorPartition, apply: async () => {} });
  await db.admin.query(
    `UPDATE core.consumer_checkpoint SET epoch = 1, position = $1 WHERE partition_no = $2 AND consumer = $3`,
    [checkpointPosition, anchorPartition, consumer],
  );
  await db.admin.query(
    `UPDATE core.consumer_checkpoint SET epoch = 1, position = $1 WHERE partition_no = $2 AND consumer = $3`,
    [batchLogCheckpointPosition, anchorPartition, batchLogConsumer],
  );
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = ANY($1) OR consumer LIKE $2', [
    [consumer, batchLogConsumer],
    `${scaledConsumerPrefix}%`,
  ]);
  await db.admin.query('DELETE FROM core.outbox WHERE partition_no = ANY($1)', [[anchorPartition, otherPartition]]);
  await db.admin.query('UPDATE core.partition SET position = 0, epoch = 1 WHERE partition_no = ANY($1)', [
    [anchorPartition, otherPartition],
  ]);
  await db.close();
});

test('Batch checkpoints stays within its bound as C grows', async () => {
  const database = db!;
  await checkGrowth(database, {
    name: 'Batch checkpoints',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, events, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, checkpoints, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
    },
    operation: (growthDb) =>
      withConnection(growthDb.pool, (client) =>
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
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, batchLogCheckpoints, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, batchLogEvents, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
    },
    operation: (growthDb) =>
      readBatch(growthDb.pool, {
        consumer: batchLogConsumer,
        partition: anchorPartition,
        envelopes: 1,
        apply: async () => {},
      }),
  });
}, 90_000);
