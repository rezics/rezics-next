import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createFreshness, readFreshness } from '../../src/search/freshness.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const freshConsumer = () => `search_test_${crypto.randomUUID().replaceAll('-', '')}`;

/** Appends one envelope as the fence does, recorded at `recordedAt`. */
async function append(partition: number, recordedAt: string): Promise<string> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    await client.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data, recorded_at)
       VALUES ($1, $2, 0, 1, $3, $4, 'com.rezics.subject.created.v1', $5, jsonb_build_object('id', $5::text), $6)`,
      [partition, position, epoch, crypto.randomUUID(), crypto.randomUUID(), recordedAt],
    );
    await client.query('COMMIT');
    return position;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checkpoint(consumer: string, partition: number, position: string): Promise<void> {
  await admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position) VALUES ($1, $2, 1, $3)
     ON CONFLICT (partition_no, consumer) DO UPDATE SET epoch = 1, position = EXCLUDED.position`,
    [partition, consumer, position],
  );
}

async function databaseNow(): Promise<number> {
  const { rows } = await admin.query<{ now: Date }>('SELECT statement_timestamp() AS now');
  return rows[0]!.now.getTime();
}

test('as_of is the database time when no partition is behind the consumer', async () => {
  const before = await databaseNow();
  const result = await readFreshness(pool, freshConsumer());
  expect(result.behind).toBe(0);
  expect(result.catchingUp).toBe(false);
  expect(result.asOf.getTime()).toBeGreaterThanOrEqual(before);
  expect(result.asOf.getTime()).toBeLessThanOrEqual(await databaseNow());
});

test('as_of is the oldest unapplied envelope over every partition behind the consumer', async () => {
  const consumer = freshConsumer();
  const first = await append(100, '2026-01-01T00:00:01.000Z');
  const second = await append(200, '2026-01-01T00:00:05.000Z');
  const earlier = await append(300, '2026-01-01T00:00:02.000Z');
  const later = await append(300, '2026-01-01T00:00:09.000Z');
  expect(await readFreshness(pool, consumer)).toMatchObject({ behind: 3, catchingUp: true });
  expect((await readFreshness(pool, consumer)).asOf.toISOString()).toBe('2026-01-01T00:00:01.000Z');
  await checkpoint(consumer, 100, first);
  await checkpoint(consumer, 300, earlier);
  const partial = await readFreshness(pool, consumer);
  expect(partial).toMatchObject({ behind: 2, catchingUp: true });
  expect(partial.asOf.toISOString()).toBe('2026-01-01T00:00:05.000Z');
  await checkpoint(consumer, 200, second);
  expect((await readFreshness(pool, consumer)).asOf.toISOString()).toBe('2026-01-01T00:00:09.000Z');
  await checkpoint(consumer, 300, later);
  const caughtUp = await readFreshness(pool, consumer);
  expect(caughtUp).toMatchObject({ behind: 0, catchingUp: false });
  expect(caughtUp.asOf.getTime()).toBeGreaterThan(Date.parse('2026-01-02T00:00:00.000Z'));
});

test('a partition without a checkpoint row counts from position zero', async () => {
  const consumer = freshConsumer();
  for (const partition of [100, 200, 300]) {
    const { rows } = await admin.query<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no = $1',
      [partition],
    );
    await checkpoint(consumer, partition, rows[0]!.position);
  }
  expect((await readFreshness(pool, consumer)).behind).toBe(0);
  const recent = new Date(Date.now() - 1000).toISOString();
  await append(400, recent);
  const result = await readFreshness(pool, consumer);
  expect(result).toMatchObject({ behind: 1, catchingUp: false });
  expect(result.asOf.toISOString()).toBe(recent);
});

test('the cached reader answers from one statement per interval', async () => {
  const consumer = freshConsumer();
  const cached = createFreshness(pool, consumer, { ttlMs: 60_000 });
  const [a, b] = await Promise.all([cached.current(), cached.current()]);
  expect(a).toEqual(b);
  await append(500, '2026-01-01T00:00:03.000Z');
  expect(await cached.current()).toEqual(a);
  const uncached = createFreshness(pool, consumer, { ttlMs: 0 });
  expect((await uncached.current()).asOf.toISOString()).toBe('2026-01-01T00:00:01.000Z');
});
