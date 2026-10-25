import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../src/database/pool.ts';
import { BATCH_ENVELOPES, readBatch, type Envelope, type StopReason } from '../src/events/log.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 4 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const CREATED = 'com.rezics.subject.created.v1';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let nextPartition = 1024 + Math.floor(Math.random() * 2048);
const freshPartition = () => nextPartition++;
const freshConsumer = () => `test_${crypto.randomUUID().replaceAll('-', '')}`;

type Draft = { type: string; subject?: string; data: unknown };
type Created = Draft & { subject: string };
function created(): Created {
  const id = crypto.randomUUID();
  return { type: CREATED, subject: id, data: { id } };
}

/** Appends one envelope as the fence does; `count` and `epoch` let a test write a log the fence never would. */
async function append(
  partition: number,
  events: Draft[] = [created()],
  options: { count?: number; epoch?: number } = {},
): Promise<bigint> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    for (const [seq, event] of events.entries())
      await client.query(
        `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          partition,
          position,
          seq,
          options.count ?? events.length,
          options.epoch ?? epoch,
          Bun.randomUUIDv7(),
          event.type,
          event.subject ?? null,
          JSON.stringify(event.data),
        ],
      );
    await client.query('COMMIT');
    return BigInt(position);
  } finally {
    client.release();
  }
}

const epochOf = async (partition: number): Promise<number> =>
  (await admin.query<{ epoch: number }>('SELECT epoch FROM core.partition WHERE partition_no = $1', [partition]))
    .rows[0]!.epoch;

/** Reads the partition up to its head, so a test sees only the envelopes it appends. */
async function drain(consumer: string, partition: number): Promise<bigint> {
  for (;;) {
    const result = await readBatch(pool, { consumer, partition, apply: async () => {} });
    if (result.status !== 'read') throw new Error(`could not drain partition ${partition}: ${result.status}`);
    if (result.envelopes === 0) return result.position;
  }
}

function recorder(): { seen: Envelope[]; apply: (envelopes: readonly Envelope[]) => Promise<void> } {
  const seen: Envelope[] = [];
  return { seen, apply: async (envelopes) => void seen.push(...envelopes) };
}

test('a batch reads the envelopes after the checkpoint as CloudEvents, then advances it', async () => {
  const partition = freshPartition();
  const consumer = freshConsumer();
  await drain(consumer, partition);
  const [one, two, three] = [created(), created(), created()];
  const first = await append(partition, [one!]);
  const second = await append(partition, [two!, three!]);
  const epoch = await epochOf(partition);

  const { seen, apply } = recorder();
  expect(await readBatch(pool, { consumer, partition, apply })).toEqual({
    status: 'read',
    envelopes: 2,
    position: second,
  });
  expect(
    seen.map((envelope) => [envelope.partition, envelope.epoch, envelope.position, envelope.events.length]),
  ).toEqual([
    [partition, epoch, first, 1],
    [partition, epoch, second, 2],
  ]);
  const sequence = second.toString().padStart(19, '0');
  expect(seen[1]!.events).toEqual(
    [two!, three!].map((draft) => ({
      specversion: '1.0',
      id: expect.stringMatching(UUID_V7),
      source: `urn:rezics:log:${partition}.${epoch}`,
      type: CREATED,
      subject: draft.subject,
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
      datacontenttype: 'application/json',
      sequence,
      data: draft.data,
    })),
  );
  expect(sequence).toHaveLength(19);

  const again = recorder();
  expect(await readBatch(pool, { consumer, partition, apply: again.apply })).toEqual({
    status: 'read',
    envelopes: 0,
    position: second,
  });
  expect(again.seen).toEqual([]);

  const other = recorder();
  await readBatch(pool, { consumer: freshConsumer(), partition, apply: other.apply });
  expect(other.seen.slice(-2).map((envelope) => envelope.position)).toEqual([first, second]);
});

test('a batch reads at most its envelope count, sixty-four by default', async () => {
  expect(BATCH_ENVELOPES).toBe(64);
  const partition = freshPartition();
  const consumer = freshConsumer();
  const start = await drain(consumer, partition);
  for (let n = 0; n < BATCH_ENVELOPES + 1; n++) await append(partition);

  const { seen, apply } = recorder();
  expect(await readBatch(pool, { consumer, partition, apply, envelopes: 2 })).toEqual({
    status: 'read',
    envelopes: 2,
    position: start + 2n,
  });
  expect(await readBatch(pool, { consumer, partition, apply })).toMatchObject({ envelopes: 63 });
  expect(await readBatch(pool, { consumer, partition, apply })).toEqual({
    status: 'read',
    envelopes: 0,
    position: start + 65n,
  });
  expect(seen.map((envelope) => envelope.position)).toEqual(
    Array.from({ length: 65 }, (_, n) => start + BigInt(n + 1)),
  );
  for (const envelopes of [0, BATCH_ENVELOPES + 1, 1.5])
    await expect(readBatch(pool, { consumer, partition, apply, envelopes })).rejects.toThrow(RangeError);
});

test('a failed apply leaves the checkpoint where it was', async () => {
  const partition = freshPartition();
  const consumer = freshConsumer();
  const start = await drain(consumer, partition);
  const position = await append(partition);
  const failure = new Error('effect failed');
  await expect(
    readBatch(pool, {
      consumer,
      partition,
      apply: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  const { seen, apply } = recorder();
  expect(await readBatch(pool, { consumer, partition, apply })).toEqual({ status: 'read', envelopes: 1, position });
  expect(seen.map((envelope) => envelope.position)).toEqual([start + 1n]);
});

test('a second reader of the same consumer and partition is busy instead of waiting', async () => {
  const partition = freshPartition();
  const consumer = freshConsumer();
  await drain(consumer, partition);
  const position = await append(partition);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const applying = new Promise<void>((resolve) => (entered = resolve));
  const first = readBatch(pool, {
    consumer,
    partition,
    apply: async () => {
      entered();
      await held;
    },
  });
  await applying;
  expect(await readBatch(pool, { consumer, partition, apply: async () => {} })).toEqual({ status: 'busy' });
  const other = recorder();
  await readBatch(pool, { consumer: freshConsumer(), partition, apply: other.apply });
  expect(other.seen.at(-1)?.position).toBe(position);
  release();
  expect(await first).toEqual({ status: 'read', envelopes: 1, position });
});

type Poison = {
  reason: StopReason;
  write: (partition: number) => Promise<bigint>;
  repair: (partition: number, position: bigint) => Promise<void>;
};

/** Each poison is repaired afterwards, so later readers of the shared test database see a well-formed log. */
const retype = async (partition: number, position: bigint) => {
  const id = crypto.randomUUID();
  await admin.query(`UPDATE core.outbox SET type = $3, data = $4 WHERE partition_no = $1 AND position = $2`, [
    partition,
    position,
    CREATED,
    JSON.stringify({ id }),
  ]);
};
const fill = async (partition: number, position: bigint, seq: number, count: number) => {
  const id = crypto.randomUUID();
  await admin.query(
    `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
     SELECT $1, $2, $3, $4, epoch, $5, $6, $7, $8 FROM core.partition WHERE partition_no = $1`,
    [partition, position, seq, count, Bun.randomUUIDv7(), CREATED, id, JSON.stringify({ id })],
  );
};
const poisons: Poison[] = [
  {
    reason: 'unknown_type',
    write: (partition) => append(partition, [{ type: 'com.rezics.unknown.v1', data: {} }]),
    repair: retype,
  },
  {
    reason: 'invalid_data',
    write: (partition) => append(partition, [{ type: CREATED, data: { id: 'not-a-uuid' } }]),
    repair: retype,
  },
  {
    reason: 'gap',
    write: (partition) => append(partition, []),
    repair: (partition, position) => fill(partition, position, 0, 1),
  },
  {
    reason: 'gap',
    write: (partition) => append(partition, [created()], { count: 2 }),
    repair: (partition, position) => fill(partition, position, 1, 2),
  },
  {
    reason: 'epoch',
    write: async (partition) => {
      await admin.query('UPDATE core.partition SET epoch = epoch + 1 WHERE partition_no = $1', [partition]);
      return append(partition);
    },
    repair: async (partition) => {
      await admin.query(
        `UPDATE core.outbox SET epoch = epoch - 1
         WHERE partition_no = $1 AND epoch = (SELECT epoch FROM core.partition WHERE partition_no = $1)`,
        [partition],
      );
      await admin.query('UPDATE core.partition SET epoch = epoch - 1 WHERE partition_no = $1', [partition]);
    },
  },
];

test.each(poisons.map((poison) => [poison.reason, poison] as const))(
  'a log with %s stops the reader before it, and only on its partition',
  async (_reason, poison) => {
    const partition = freshPartition();
    const healthy = freshPartition();
    const consumer = freshConsumer();
    await drain(consumer, partition);
    await drain(consumer, healthy);
    const before = await append(partition);
    const bad = await poison.write(partition);
    try {
      await append(partition);
      const { seen, apply } = recorder();
      expect(await readBatch(pool, { consumer, partition, apply })).toEqual({
        status: 'stopped',
        reason: poison.reason,
        envelopes: 1,
        position: before,
      });
      expect(await readBatch(pool, { consumer, partition, apply })).toEqual({
        status: 'stopped',
        reason: poison.reason,
        envelopes: 0,
        position: before,
      });
      expect(seen.map((envelope) => envelope.position)).toEqual([before]);
      const elsewhere = await append(healthy);
      expect(await readBatch(pool, { consumer, partition: healthy, apply })).toEqual({
        status: 'read',
        envelopes: 1,
        position: elsewhere,
      });
    } finally {
      await poison.repair(partition, bad);
    }
    expect(await drain(consumer, partition)).toBe(bad + 1n);
  },
);
