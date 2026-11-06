import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../src/database/pool.ts';
import { projectBatch, readBatch, type Envelope } from '../src/events/log.ts';
import { relayConcurrencyForPool, startRelays, type Relay } from '../src/events/relays.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 4 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const CREATED = 'com.rezics.subject.created.v1';
let nextPartition = 1024 + Math.floor(Math.random() * 2048);
const freshPartition = () => nextPartition++;
const freshConsumer = () => `test_${crypto.randomUUID().replaceAll('-', '')}`;

/** Appends one envelope as the fence does, or only advances the head when `type` is null. */
async function append(partition: number, type: string | null = CREATED): Promise<bigint> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    if (type) {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
         VALUES ($1, $2, 0, 1, $3, $4, $5, $6, $7)`,
        [partition, position, epoch, Bun.randomUUIDv7(), type, id, JSON.stringify({ id })],
      );
    }
    await client.query('COMMIT');
    return BigInt(position);
  } finally {
    client.release();
  }
}

async function checkpoint(consumer: string, partition: number): Promise<string | undefined> {
  const { rows } = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = $2',
    [consumer, partition],
  );
  return rows[0]?.position;
}

async function drain(consumer: string, partition: number): Promise<bigint> {
  for (;;) {
    const result = await projectBatch(pool, { consumer, partition, apply: async () => {} });
    if (result.status !== 'read') throw new Error(`could not drain partition ${partition}: ${result.status}`);
    if (result.envelopes === 0) return result.position;
  }
}

async function until(condition: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error('condition not reached');
    await Bun.sleep(10);
  }
}

const projecting = (
  consumer: string,
  apply: (partition: number, envelopes: readonly Envelope[]) => Promise<void>,
): Relay => ({
  consumer,
  run: (partition) => projectBatch(pool, { consumer, partition, apply: (envelopes) => apply(partition, envelopes) }),
});

test('projectBatch applies with no connection held and advances only from the position it read', async () => {
  const partition = freshPartition();
  const consumer = freshConsumer();
  const start = await drain(consumer, partition);
  await append(partition);
  await append(partition);
  const outer: bigint[] = [];
  const inner: bigint[] = [];
  const result = await projectBatch(pool, {
    consumer,
    partition,
    apply: async (envelopes) => {
      outer.push(...envelopes.map((envelope) => envelope.position));
      expect(pool.totalCount - pool.idleCount).toBe(0);
      // Nothing is locked while the batch applies, so a concurrent run of the same consumer reads and advances it.
      expect(
        await projectBatch(pool, {
          consumer,
          partition,
          apply: async (again) => void inner.push(...again.map((envelope) => envelope.position)),
        }),
      ).toEqual({ status: 'read', envelopes: 2, position: start + 2n });
    },
  });
  expect(result).toEqual({ status: 'busy' });
  expect(outer).toEqual([start + 1n, start + 2n]);
  expect(inner).toEqual([start + 1n, start + 2n]);
  expect(await checkpoint(consumer, partition)).toBe(String(start + 2n));
  expect(await projectBatch(pool, { consumer, partition, apply: async () => {} })).toEqual({
    status: 'read',
    envelopes: 0,
    position: start + 2n,
  });
});

test('projectBatch keeps the checkpoint when apply fails and stops where readBatch stops', async () => {
  const partition = freshPartition();
  const consumer = freshConsumer();
  const start = await drain(consumer, partition);
  const position = await append(partition);
  const failure = new Error('projection failed');
  await expect(
    projectBatch(pool, {
      consumer,
      partition,
      apply: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(await checkpoint(consumer, partition)).toBe(String(start));
  expect(await projectBatch(pool, { consumer, partition, apply: async () => {} })).toEqual({
    status: 'read',
    envelopes: 1,
    position,
  });
  await append(partition, null);
  await append(partition);
  const gap = await projectBatch(pool, { consumer, partition, apply: async () => {} });
  expect(gap).toEqual({ status: 'stopped', reason: 'gap', envelopes: 0, position });
  expect(await readBatch(pool, { consumer, partition, apply: async () => {} })).toEqual(gap);
  expect(await checkpoint(consumer, partition)).toBe(String(position));
});

test('relays run every partition past its checkpoint until it is caught up', async () => {
  const consumer = freshConsumer();
  const [long, short] = [freshPartition(), freshPartition()];
  let longHead = 0n;
  for (let n = 0; n < 70; n++) longHead = await append(long);
  const shortHead = await append(short);
  const seen = new Map<number, Set<bigint>>();
  const relays = startRelays(
    pool,
    [
      projecting(consumer, async (partition, envelopes) => {
        const positions = seen.get(partition) ?? new Set<bigint>();
        for (const envelope of envelopes) positions.add(envelope.position);
        seen.set(partition, positions);
      }),
    ],
    { intervalMs: 20 },
  );
  try {
    await until(
      async () =>
        (await checkpoint(consumer, long)) === String(longHead) &&
        (await checkpoint(consumer, short)) === String(shortHead),
    );
  } finally {
    await relays.stop();
  }
  expect(seen.get(long)?.size).toBe(70);
  expect([...(seen.get(short) ?? [])]).toEqual([shortHead]);
});

test('relays run at most their concurrency at once and pause waits for the runs in flight', async () => {
  const partitions = Array.from({ length: 6 }, freshPartition);
  for (const partition of partitions) await append(partition);
  for (const [concurrency, expected] of [
    [2, 2],
    [undefined, 4],
  ] as const) {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const applied = new Set<number>();
    const relays = startRelays(
      pool,
      [
        projecting(freshConsumer(), async (partition) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await gate;
          inFlight--;
          applied.add(partition);
        }),
      ],
      concurrency === undefined ? { intervalMs: 20 } : { intervalMs: 20, concurrency },
    );
    try {
      await until(() => inFlight === expected);
      await Bun.sleep(200);
      expect(peak).toBe(expected);
      let paused = false;
      const pausing = relays.pause().then(() => {
        paused = true;
      });
      await Bun.sleep(100);
      expect(paused).toBe(false);
      release();
      await pausing;
      expect(inFlight).toBe(0);
      const count = applied.size;
      await Bun.sleep(200);
      expect(applied.size).toBe(count);
      relays.resume();
      await until(() => partitions.every((partition) => applied.has(partition)));
    } finally {
      release();
      await relays.stop();
    }
  }
});

test('a stopped partition is retried on later ticks without holding back the others, and stop ends the loop', async () => {
  const consumer = freshConsumer();
  const [broken, healthy] = [freshPartition(), freshPartition()];
  await append(broken, null);
  await append(broken);
  const head = await append(healthy);
  const runs = new Map<number, number>();
  const inner = projecting(consumer, async () => {});
  const relays = startRelays(
    pool,
    [
      {
        consumer,
        run: (partition) => {
          runs.set(partition, (runs.get(partition) ?? 0) + 1);
          return inner.run(partition);
        },
      },
    ],
    { intervalMs: 20 },
  );
  try {
    await until(async () => (runs.get(broken) ?? 0) >= 3 && (await checkpoint(consumer, healthy)) === String(head));
  } finally {
    await relays.stop();
  }
  expect((await checkpoint(consumer, broken)) ?? '0').toBe('0');
  const total = () => [...runs.values()].reduce((sum, count) => sum + count, 0);
  const stopped = total();
  await append(healthy);
  await Bun.sleep(200);
  expect(total()).toBe(stopped);
});

test('a max-one pool shares its only connection and does not queue behind a held command lease', async () => {
  const one = createPool(databaseUrl);
  one.options.max = 1;
  expect(relayConcurrencyForPool(one)).toBe(1);
  const held = await one.connect();
  const relays = startRelays(one, [projecting(freshConsumer(), async () => {})], { intervalMs: 20, concurrency: 1 });
  try {
    await Bun.sleep(50);
    expect(one.waitingCount).toBe(0);
    expect(one.idleCount).toBe(0);
  } finally {
    await relays.stop();
    held.release();
    await one.end();
  }
});
