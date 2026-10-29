import { afterAll, beforeAll, test } from 'bun:test';
import { readConsumerLag } from '../../src/events/consumer-lag.ts';
import upsertConsumerLag from '../../src/events/upsert-consumer-lag.sql';
import { checkGrowth, openGrowthDatabase, settle, type GrowthDatabase } from '../support/growth.ts';

const scales = [64, 512, 4096] as const;
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase();
});

afterAll(async () => {
  await db?.close();
});

async function growConsumerRows(prefix: string, target: string, scale: number, previous: number): Promise<void> {
  await db.admin.query(
    `INSERT INTO core.consumer_lag (consumer, oldest_pending_at, observed_at)
     SELECT $1 || '_' || n::text, NULL, clock_timestamp()
     FROM generate_series($2::integer, $3::integer) AS n`,
    [prefix, previous === 0 ? 0 : previous - 1, scale - 2],
  );
  if (previous === 0) {
    await db.admin.query(
      `INSERT INTO core.consumer_lag (consumer, oldest_pending_at, observed_at)
       VALUES ($1, NULL, clock_timestamp())`,
      [target],
    );
  }
  await settle(db, { relations: ['core.consumer_lag'], analyze: true });
}

test('Consumer lag read stays within its bound as consumer rows grow', async () => {
  const prefix = `lag_read_${crypto.randomUUID().replaceAll('-', '')}`;
  const target = `${prefix}_target`;
  await checkGrowth(db, {
    name: 'Consumer lag read',
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'constant' },
    async grow(_database, scale, previous) {
      await growConsumerRows(prefix, target, scale, previous);
    },
    async operation(database) {
      const client = await database.pool.connect();
      try {
        return await readConsumerLag(client, target);
      } finally {
        client.release();
      }
    },
  });
});

test('Consumer lag record stays within its bound as consumer rows grow', async () => {
  const prefix = `lag_record_${crypto.randomUUID().replaceAll('-', '')}`;
  const target = `${prefix}_target`;
  await checkGrowth(db, {
    name: 'Consumer lag record',
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'constant' },
    async grow(_database, scale, previous) {
      await growConsumerRows(prefix, target, scale, previous);
    },
    async operation(database) {
      const client = await database.pool.connect();
      try {
        await upsertConsumerLag.run(client, {
          consumer: target,
          oldest_pending_at: '',
        });
      } finally {
        client.release();
      }
    },
  });
});
