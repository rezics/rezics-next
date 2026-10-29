import { afterAll, expect, spyOn, test } from 'bun:test';
import pg from 'pg';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { consumerReady, readConsumerLag } from '../../src/events/consumer-lag.ts';
import { startRelays } from '../../src/events/relays.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 4 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const CREATED = 'com.rezics.subject.created.v1';
const freshConsumer = () => `test_${crypto.randomUUID().replaceAll('-', '')}`;

async function consumerAtHead(): Promise<string> {
  const consumer = freshConsumer();
  await admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     SELECT partition_no, $1, CASE WHEN position = 0 THEN NULL ELSE epoch END, position FROM core.partition`,
    [consumer],
  );
  return consumer;
}

async function append(partition: number): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    await client.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       VALUES ($1, $2, 0, 1, $3, $4, $5, $6, $7)`,
      [partition, position, epoch, Bun.randomUUIDv7(), CREATED, crypto.randomUUID(), JSON.stringify({})],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  errors: unknown[][] = [],
  message = 'condition not reached',
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (errors.length > 0) throw new Error(`relay logged an error: ${errors[0]!.map(String).join(': ')}`);
    if (await condition()) {
      if (errors.length > 0) throw new Error(`relay logged an error: ${errors[0]!.map(String).join(': ')}`);
      return;
    }
    if (performance.now() > deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

test('relay ticks record the oldest pending envelope across partitions and a caught-up observation', async () => {
  const errors: unknown[][] = [];
  const consumer = await consumerAtHead();
  const partitions = (
    await admin.query<{ partition_no: number }>('SELECT partition_no FROM core.partition ORDER BY partition_no LIMIT 2')
  ).rows.map((row) => row.partition_no);
  expect(partitions).toHaveLength(2);

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let running = false;
  const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => errors.push(args));
  const relay = startRelays(
    pool,
    [
      {
        consumer,
        async run() {
          running = true;
          await held;
          return { status: 'read' as const, envelopes: 0, position: 0n };
        },
      },
    ],
    { intervalMs: 20, concurrency: 1 },
  );
  try {
    await until(
      async () => (await withConnection(pool, (client) => readConsumerLag(client, consumer))) !== null,
      10_000,
      errors,
      'relay did not record its first lag observation',
    );
    const caughtUp = await withConnection(pool, (client) => readConsumerLag(client, consumer));
    expect(caughtUp?.oldestPendingAt).toBeNull();
    expect(caughtUp?.observedAt).toBeInstanceOf(Date);
    expect(consumerReady(caughtUp, { maxLagMs: 5_000, now: new Date() })).toBe(true);

    await append(partitions[0]!);
    await Bun.sleep(10);
    await append(partitions[1]!);
    const expected = await admin.query<{ oldest: Date }>(
      'SELECT min(recorded_at) AS oldest FROM core.outbox WHERE partition_no = ANY($1::integer[])',
      [partitions],
    );
    await until(() => running, 10_000, errors, 'relay did not start pending work');
    await until(
      async () => {
        const lag = await withConnection(pool, (client) => readConsumerLag(client, consumer));
        return lag?.oldestPendingAt?.getTime() === expected.rows[0]?.oldest.getTime();
      },
      10_000,
      errors,
      'relay did not record the oldest pending envelope',
    );
    const pending = await withConnection(pool, (client) => readConsumerLag(client, consumer));
    expect(pending?.oldestPendingAt).toEqual(expected.rows[0]?.oldest);
    expect(pending?.observedAt).toBeInstanceOf(Date);

    release();
    await admin.query(
      `UPDATE core.consumer_checkpoint AS checkpoint
       SET epoch = CASE WHEN partition.position = 0 THEN NULL ELSE partition.epoch END,
           position = partition.position
       FROM core.partition AS partition
       WHERE checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = $1`,
      [consumer],
    );
    await until(
      async () => (await withConnection(pool, (client) => readConsumerLag(client, consumer)))?.oldestPendingAt === null,
      10_000,
      errors,
      'relay did not record that pending work was caught up',
    );
    await relay.stop();
    expect(errors).toEqual([]);
    const stopped = await withConnection(pool, (client) => readConsumerLag(client, consumer));
    expect(stopped).not.toBeNull();
    const maxLagMs = 5 * 60_000;
    const expiresAt = stopped!.observedAt.getTime() + maxLagMs;
    expect(consumerReady(stopped, { maxLagMs, now: new Date(expiresAt) })).toBe(true);
    expect(consumerReady(stopped, { maxLagMs, now: new Date(expiresAt + 1) })).toBe(false);
  } finally {
    release();
    await relay.stop();
    errorSpy.mockRestore();
  }
}, 50_000);

test('consumer readiness requires a row and fresh observation and pending time', () => {
  const now = new Date('2026-01-01T00:10:00.000Z');
  const maxLagMs = 5 * 60_000;
  expect(consumerReady(null, { maxLagMs, now })).toBe(false);
  expect(
    consumerReady({ oldestPendingAt: null, observedAt: new Date(now.getTime() - maxLagMs + 1) }, { maxLagMs, now }),
  ).toBe(true);
  expect(
    consumerReady({ oldestPendingAt: new Date(now.getTime() - maxLagMs - 1), observedAt: now }, { maxLagMs, now }),
  ).toBe(false);
  expect(
    consumerReady({ oldestPendingAt: null, observedAt: new Date(now.getTime() - maxLagMs - 1) }, { maxLagMs, now }),
  ).toBe(false);
});

test('readConsumerLag returns null for an unseen consumer', async () => {
  const consumer = freshConsumer();
  expect(await withConnection(pool, (client) => readConsumerLag(client, consumer))).toBeNull();
});

test('readConsumerLag returns the selected consumer row from a point read', async () => {
  const consumer = freshConsumer();
  const other = freshConsumer();
  const oldestPendingAt = new Date('2026-01-01T00:00:00.000Z');
  const observedAt = new Date('2026-01-01T00:01:00.000Z');
  await admin.query(
    `INSERT INTO core.consumer_lag (consumer, oldest_pending_at, observed_at)
     VALUES ($1, $3, $4), ($2, NULL, $4)`,
    [consumer, other, oldestPendingAt, observedAt],
  );
  expect(await withConnection(pool, (client) => readConsumerLag(client, consumer))).toEqual({
    oldestPendingAt,
    observedAt,
  });
  expect(await withConnection(pool, (client) => readConsumerLag(client, other))).toEqual({
    oldestPendingAt: null,
    observedAt,
  });
});
