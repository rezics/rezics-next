import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../src/database/pool.ts';
import { projectBatch } from '../src/events/log.ts';
import { startRelays, type Relay } from '../src/events/relays.ts';

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

/** Appends one envelope as the fence does. */
async function append(partition: number): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       VALUES ($1, $2, 0, 1, $3, $4, $5, $6, $7)`,
      [partition, position, epoch, Bun.randomUUIDv7(), CREATED, id, JSON.stringify({ id })],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

/** A consumer that starts at every partition's head, so only envelopes appended later are ahead of it. */
async function consumerAtHead(): Promise<string> {
  const consumer = freshConsumer();
  await admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     SELECT partition_no, $1, CASE WHEN position = 0 THEN NULL ELSE epoch END, position FROM core.partition`,
    [consumer],
  );
  return consumer;
}

async function until(condition: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error('condition not reached');
    await Bun.sleep(10);
  }
}

/** Records the first run that applies envelopes in each of `watched`. */
function recording(consumer: string, watched: ReadonlySet<number>, order: number[]): Relay {
  return {
    consumer,
    run: (partition) =>
      projectBatch(pool, {
        consumer,
        partition,
        apply: async (envelopes) => {
          if (envelopes.length > 0 && watched.has(partition) && !order.includes(partition)) order.push(partition);
        },
      }),
  };
}

test('a relay starts the partition with the oldest pending envelope first, not the lowest partition number', async () => {
  const consumer = await consumerAtHead();
  const base = 3200 + Math.floor(Math.random() * 800);
  // Appended from the highest partition number down, so number order is the reverse of age order.
  const appended = [base + 30, base + 20, base + 10, base];
  for (const partition of appended) {
    await append(partition);
    await Bun.sleep(5);
  }
  const order: number[] = [];
  const relays = startRelays(pool, [recording(consumer, new Set(appended), order)], { intervalMs: 1, concurrency: 1 });
  try {
    await until(() => order.length === appended.length);
  } finally {
    await relays.stop();
  }
  expect(order).toEqual(appended);
});

test('a newer envelope in a low partition waits behind older pending envelopes when every slot is busy', async () => {
  const consumer = await consumerAtHead();
  const base = 3200 + Math.floor(Math.random() * 800);
  const older = [base + 45, base + 35, base + 25];
  const newer = base + 5;
  for (const partition of older) {
    await append(partition);
    await Bun.sleep(5);
  }
  await append(newer);
  const order: number[] = [];
  const relays = startRelays(pool, [recording(consumer, new Set([...older, newer]), order)], {
    intervalMs: 1,
    concurrency: 1,
  });
  try {
    await until(() => order.length === older.length + 1);
  } finally {
    await relays.stop();
  }
  expect(order.at(-1)).toBe(newer);
  expect(order.slice(0, older.length)).toEqual(older);
});
