import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { createPool } from '../src/database/pool.ts';
import {
  EFFECTS_CONSUMER,
  effectWorkflowId,
  effectsRelay,
  registerEffects,
  type Effect,
} from '../src/events/effects.ts';
import type { CloudEvent } from '../src/events/log.ts';
import scanPartitions from '../src/events/scan-partitions.sql';
import { readWorkerConfig, startWorker } from '../src/worker.ts';
import type { WorkContext } from '../src/work/registry.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const CREATED = 'com.rezics.subject.created.v1';
let nextPartition = 3072 + Math.floor(Math.random() * 512);
const freshPartition = () => nextPartition++;
const recorded: CloudEvent[] = [];
const effect: Effect = {
  name: 'relay_record',
  types: [CREATED],
  run: async (event) => void recorded.push(event),
};

async function append(partition: number): Promise<{ epoch: number; position: bigint; subject: string }> {
  const subject = crypto.randomUUID();
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
      [partition, position, epoch, Bun.randomUUIDv7(), CREATED, subject, JSON.stringify({ id: subject })],
    );
    await client.query('COMMIT');
    return { epoch, position: BigInt(position), subject };
  } finally {
    client.release();
  }
}

async function checkpoint(partition: number): Promise<string | undefined> {
  const { rows } = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = $2',
    [EFFECTS_CONSUMER, partition],
  );
  return rows[0]?.position;
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error('condition not reached');
    await Bun.sleep(10);
  }
}

beforeAll(async () => {
  recorded.length = 0;
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

test('the worker relays a committed event to its effect without a caller naming the partition', async () => {
  const partition = freshPartition();
  const emptyPartition = freshPartition();
  const module = {
    name: 'relay_test',
    register(context: WorkContext) {
      context.addEffects([effect]);
    },
  };
  const env = { DATABASE_URL: databaseUrl, KERNEL_EXECUTOR_ID: `relay-test-${crypto.randomUUID()}` };
  const worker = await startWorker(readWorkerConfig(env), [module], env);
  try {
    const { epoch, position, subject } = await append(partition);
    await until(async () => (await checkpoint(partition)) === String(position));
    await until(() => recorded.some((event) => event.subject === subject));
    await DBOS.retrieveWorkflow(
      effectWorkflowId({ partition, epoch, position, events: [] }, 0, 'relay_record'),
    ).getResult();
    expect(recorded.filter((event) => event.subject === subject)).toHaveLength(1);
    expect(await checkpoint(emptyPartition)).toBeUndefined();
  } finally {
    await worker.stop();
  }
}, 30_000);

test('effects relay discovery stays within its bound as outbox history grows', async () => {
  const growth = await openGrowthDatabase(databaseUrl);
  const start = 4096 - 96 - Math.floor(Math.random() * 64);
  const hot = start;
  const consumer = { enqueue: async () => {} } as ReturnType<typeof registerEffects>;
  const relay = effectsRelay(growth.pool, consumer);
  const basePositions = new Map<number, string>();
  const initialPositions = new Map<number, string>();
  const insertedIds: string[] = [];
  // Settled history outside the measured partitions, so the outbox is large enough at every scale for the planner
  // to probe outbox_pkey; discovery does not see it as pending because the consumer's checkpoints sit at its heads.
  const historyFirst = 1000;
  const historyLast = historyFirst + 39;
  const historyPerPartition = 125;
  const historyInitial = new Map<number, string>();

  try {
    const history = await growth.admin.query<{ partition_no: number; previous: string }>(
      `UPDATE core.partition SET position = position + $3
       WHERE partition_no BETWEEN $1 AND $2
       RETURNING partition_no, (position - $3)::text AS previous`,
      [historyFirst, historyLast, historyPerPartition],
    );
    for (const row of history.rows) historyInitial.set(row.partition_no, row.previous);
    const seeded = await growth.admin.query<{ id: string }>(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       SELECT partition.partition_no, partition.position - $4::int + step, 0, 1, 1, gen_random_uuid(), $3,
              gen_random_uuid()::text, '{}'::jsonb
       FROM core.partition AS partition
       CROSS JOIN generate_series(1, $4::int) AS step
       WHERE partition.partition_no BETWEEN $1 AND $2
       RETURNING id`,
      [historyFirst, historyLast, CREATED, historyPerPartition],
    );
    for (const row of seeded.rows) insertedIds.push(row.id);
    await growth.admin.query(
      `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
       SELECT partition_no, $3, 1, position FROM core.partition WHERE partition_no BETWEEN $1 AND $2
       ON CONFLICT (consumer, partition_no) DO UPDATE SET epoch = 1, position = EXCLUDED.position`,
      [historyFirst, historyLast, EFFECTS_CONSUMER],
    );
    await growth.admin.query(
      'DELETE FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no BETWEEN $2 AND $3',
      [EFFECTS_CONSUMER, start, start + 63],
    );
    await checkGrowth(growth, {
      name: 'effects relay discovery',
      rule: 'series',
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (db, scale, previous) => {
        for (let offset = previous; offset < scale; offset++) {
          const partition = start + offset;
          const { rows } = await db.admin.query<{ position: string; previous: string }>(
            'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING position::text, (position - 1)::text AS previous',
            [partition],
          );
          const position = BigInt(rows[0]!.position);
          initialPositions.set(partition, rows[0]!.previous);
          const id = Bun.randomUUIDv7();
          insertedIds.push(id);
          basePositions.set(partition, String(position));
          await db.admin.query(
            `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
             VALUES ($1, $2, 0, 1, 1, $3, $4, $5, $6)`,
            [partition, position.toString(), id, CREATED, crypto.randomUUID(), { id: crypto.randomUUID() }],
          );
          await db.admin.query(
            `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
             VALUES ($1, $2, 1, $3)
             ON CONFLICT (consumer, partition_no) DO UPDATE SET epoch = 1, position = EXCLUDED.position`,
            [partition, EFFECTS_CONSUMER, position.toString()],
          );
        }

        const hotHead = Number(basePositions.get(hot) ?? '0');
        const extra = scale - previous;
        if (extra > 0 && previous > 0) {
          await db.admin.query('UPDATE core.partition SET position = position + $2 WHERE partition_no = $1', [
            hot,
            extra,
          ]);
          for (let position = hotHead + 1; position <= hotHead + extra; position++) {
            const id = Bun.randomUUIDv7();
            insertedIds.push(id);
            await db.admin.query(
              `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
               VALUES ($1, $2, 0, 1, 1, $3, $4, $5, $6)`,
              [hot, position, id, CREATED, crypto.randomUUID(), { id: crypto.randomUUID() }],
            );
          }
          const newHead = hotHead + extra;
          basePositions.set(hot, String(newHead));
          await db.admin.query(
            'UPDATE core.consumer_checkpoint SET position = $3 WHERE consumer = $1 AND partition_no = $2',
            [EFFECTS_CONSUMER, hot, String(newHead)],
          );
        }
      },
      operation: async (db) => {
        const { rows } = await db.admin.query<{ position: string }>(
          'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING position::text',
          [hot],
        );
        const position = rows[0]!.position;
        basePositions.set(hot, position);
        const id = Bun.randomUUIDv7();
        insertedIds.push(id);
        await db.admin.query(
          `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
           VALUES ($1, $2, 0, 1, 1, $3, $4, $5, $6)`,
          [hot, position, id, CREATED, crypto.randomUUID(), { id: crypto.randomUUID() }],
        );
        await withGrowthConnection(db, async (client) => {
          const discovered = await scanPartitions.run(client, { consumer: EFFECTS_CONSUMER });
          if (discovered.length !== 1 || discovered[0]!.partition_no !== hot)
            throw new Error(`expected only hot partition ${hot}, found ${discovered.map((row) => row.partition_no)}`);
          const result = await relay.run(hot);
          if (result.status !== 'read' || result.envelopes !== 1)
            throw new Error(`expected one effects batch, received ${JSON.stringify(result)}`);
          return result;
        });
      },
      repetitions: 1,
    });
  } finally {
    await growth.admin.query(
      `DELETE FROM core.consumer_checkpoint
       WHERE consumer = $1 AND (partition_no BETWEEN $2 AND $3 OR partition_no BETWEEN $4 AND $5)`,
      [EFFECTS_CONSUMER, start, start + 63, historyFirst, historyLast],
    );
    if (insertedIds.length > 0) {
      await growth.admin.query('DELETE FROM core.outbox WHERE id = ANY($1::uuid[])', [insertedIds]);
    }
    for (const [partition, position] of [...initialPositions, ...historyInitial]) {
      await growth.admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = $1', [
        partition,
        position,
      ]);
    }
    await growth.close();
  }
}, 120_000);

async function withGrowthConnection<T>(
  db: GrowthDatabase,
  run: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}
