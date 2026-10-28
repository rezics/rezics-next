import { afterAll, beforeAll, expect, test } from 'bun:test';
import { projectBatch } from '../src/events/log.ts';
import { newId } from '../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const partition = 3100;
const otherPartition = 3101;
const emptyPartition = 3102;
const emptyOtherPartition = 3103;
const partitions = [partition, otherPartition, emptyPartition, emptyOtherPartition];
const batchSize = 4;
const ordinalsPerScale = 500;
const checkpointPosition = 500_000;
const emptyPosition = 700_000;
const payload = { id: '00000000-0000-7000-8000-000000000001' };
let db: GrowthDatabase | undefined;

function eventRow(partitionNo: number, position: number, ordinal: number) {
  const route = partitionNo * 16 + (ordinal % 16);
  return {
    partition_no: partitionNo,
    position,
    event_seq: 0,
    event_count: 1,
    epoch: 1,
    id: newId(route),
    type: 'com.rezics.subject.created.v1',
    subject: null,
    data: payload,
  };
}

const history: Population = {
  name: 'growth-projection-history',
  hotPartition: partition,
  rows: ({ ordinal }) => {
    const outbox = [
      eventRow(partition, checkpointPosition - 1 - ordinal, ordinal),
      eventRow(partition, checkpointPosition + batchSize + ordinal + 1, ordinal),
      eventRow(otherPartition, checkpointPosition + ordinal + 1, ordinal),
      eventRow(emptyPartition, emptyPosition - 1 - ordinal, ordinal),
      eventRow(emptyOtherPartition, emptyPosition - 1 - ordinal, ordinal),
    ];
    if (ordinal === 0) {
      for (let index = 1; index <= batchSize; index++)
        outbox.push(eventRow(partition, checkpointPosition + index, ordinal + index));
      outbox.push(eventRow(emptyPartition, emptyPosition, ordinal));
      outbox.push(eventRow(emptyOtherPartition, emptyPosition, ordinal));
    }
    return {
      'core.outbox': outbox,
      'core.consumer_checkpoint': [
        { partition_no: partition, consumer: `growth_projection_hist_primary_${ordinal}` },
        { partition_no: otherPartition, consumer: `growth_projection_hist_other_${ordinal}` },
        { partition_no: emptyPartition, consumer: `growth_projection_hist_empty_${ordinal}` },
        { partition_no: emptyOtherPartition, consumer: `growth_projection_hist_empty_other_${ordinal}` },
      ],
    };
  },
  finish: async (admin, range) => {
    if (range.to === 0) return;
    await admin.query(
      `UPDATE core.partition
       SET position = CASE partition_no
         WHEN $1 THEN $5::bigint + $6::bigint + $7::bigint
         WHEN $2 THEN $5::bigint + $7::bigint
         WHEN $3 THEN $8::bigint
         WHEN $4 THEN $8::bigint
       END,
       epoch = 1
       WHERE partition_no = ANY($9::integer[])`,
      [
        partition,
        otherPartition,
        emptyPartition,
        emptyOtherPartition,
        checkpointPosition,
        batchSize,
        range.to,
        emptyPosition,
        partitions,
      ],
    );
  },
};

async function reset(database: GrowthDatabase): Promise<void> {
  await database.admin.query("DELETE FROM core.consumer_checkpoint WHERE consumer LIKE 'growth_projection_%'");
  await database.admin.query('DELETE FROM core.outbox WHERE partition_no = ANY($1)', [partitions]);
  await database.admin.query('UPDATE core.partition SET position = 0, epoch = 1 WHERE partition_no = ANY($1)', [
    partitions,
  ]);
}

function consumer(kind: string, repetition: number): string {
  return `growth_projection_${kind}_${repetition}`;
}

async function createCheckpoint(
  database: GrowthDatabase,
  partitionNo: number,
  name: string,
  epoch: number | null,
  position: number,
): Promise<void> {
  await database.admin.query(
    'INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position) VALUES ($1, $2, $3, $4)',
    [partitionNo, name, epoch, position],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await reset(db);
});

afterAll(async () => {
  if (!db) return;
  try {
    await reset(db);
  } finally {
    await db.close();
  }
});

test('Released projection batch stays within its bound as checkpoint and outbox history grows', async () => {
  const database = db!;
  await checkGrowth(database, {
    name: 'Released projection batch',
    // With b=4, rows are O(1+b), indexed blocks are O(log C + b log H + log 4096), and each outcome has fixed SQL.
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, history, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
    },
    operation: async (growthDb, _scale, repetition) => {
      const applyPage = async (envelopes: readonly { events: readonly unknown[] }[]) => {
        expect(envelopes).toHaveLength(batchSize);
        expect(envelopes.every((envelope) => envelope.events.length === 1)).toBe(true);
      };

      const successConsumer = consumer('success', repetition);
      await createCheckpoint(growthDb, partition, successConsumer, 1, checkpointPosition);
      const succeeded = await projectBatch(growthDb.pool, {
        consumer: successConsumer,
        partition,
        envelopes: batchSize,
        apply: applyPage,
      });
      expect(succeeded).toEqual({
        status: 'read',
        envelopes: batchSize,
        position: BigInt(checkpointPosition + batchSize),
      });

      const emptyConsumer = consumer('empty', repetition);
      await createCheckpoint(growthDb, emptyPartition, emptyConsumer, 1, emptyPosition);
      let emptyApplied = false;
      const empty = await projectBatch(growthDb.pool, {
        consumer: emptyConsumer,
        partition: emptyPartition,
        envelopes: batchSize,
        apply: async () => {
          emptyApplied = true;
        },
      });
      expect(empty).toEqual({ status: 'read', envelopes: 0, position: BigInt(emptyPosition) });
      expect(emptyApplied).toBe(false);

      const busyConsumer = consumer('busy', repetition);
      await createCheckpoint(growthDb, partition, busyConsumer, 1, checkpointPosition);
      const locker = await growthDb.admin.connect();
      try {
        await locker.query('BEGIN');
        await locker.query(
          'SELECT 1 FROM core.consumer_checkpoint WHERE partition_no = $1 AND consumer = $2 FOR UPDATE',
          [partition, busyConsumer],
        );
        let busyApplied = false;
        const busy = await projectBatch(growthDb.pool, {
          consumer: busyConsumer,
          partition,
          envelopes: batchSize,
          apply: async () => {
            busyApplied = true;
          },
        });
        expect(busy).toEqual({ status: 'busy' });
        expect(busyApplied).toBe(false);
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
      }

      const lostConsumer = consumer('lost_cas', repetition);
      await createCheckpoint(growthDb, partition, lostConsumer, 1, checkpointPosition);
      const lost = await projectBatch(growthDb.pool, {
        consumer: lostConsumer,
        partition,
        envelopes: batchSize,
        apply: async (envelopes) => {
          await applyPage(envelopes);
          await growthDb.admin.query(
            'UPDATE core.consumer_checkpoint SET epoch = 1, position = $3 WHERE partition_no = $1 AND consumer = $2',
            [partition, lostConsumer, checkpointPosition + batchSize],
          );
        },
      });
      expect(lost).toEqual({ status: 'busy' });
    },
  });
}, 120_000);
