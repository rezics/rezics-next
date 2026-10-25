import { afterAll, expect, expectTypeOf, test } from 'bun:test';
import pg from 'pg';
import { migrate, schemaDump } from '../scripts/database.ts';
import { readPartition } from '../src/partition/partition.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
});

async function failure(sql: string): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await client.query(sql).then(
      () => null,
      (error: unknown) => error,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('core.partition holds 4,096 active partitions on one node at epoch 1 and position 0', async () => {
  const { rows } = await pool.query(`SELECT count(*)::int AS partitions, min(partition_no) AS first,
    max(partition_no) AS last, count(DISTINCT node)::int AS nodes,
    bool_and(write_state = 'active' AND moved_to IS NULL AND epoch = 1 AND position = 0) AS initial
    FROM core.partition`);
  expect(rows).toEqual([{ partitions: 4096, first: 0, last: 4095, nodes: 1, initial: true }]);
});

test('readPartition returns one typed row and null for an unknown partition', async () => {
  const partition = await readPartition(pool, 4095);
  expectTypeOf(partition).toEqualTypeOf<{
    partitionNo: number;
    node: string;
    writeState: 'active' | 'fenced' | 'moved';
    movedTo: string | null;
    epoch: number;
    position: bigint;
  } | null>();
  expect(partition).toEqual({
    partitionNo: 4095,
    node: 'b',
    writeState: 'active',
    movedTo: null,
    epoch: 1,
    position: 0n,
  });
  expect(await readPartition(pool, 4096)).toBeNull();
});

test('core.partition refuses inconsistent write states', async () => {
  for (const sql of [
    "UPDATE core.partition SET write_state = 'moved' WHERE partition_no = 0",
    "UPDATE core.partition SET moved_to = 'a' WHERE partition_no = 0",
    "UPDATE core.partition SET write_state = 'retired' WHERE partition_no = 0",
    'UPDATE core.partition SET position = -1 WHERE partition_no = 0',
    'UPDATE core.partition SET epoch = 0 WHERE partition_no = 0',
  ]) {
    expect(await failure(sql)).toMatchObject({ code: '23514' });
  }
  expect(
    await failure("UPDATE core.partition SET write_state = 'moved', moved_to = 'a' WHERE partition_no = 0"),
  ).toBeNull();
});

test('migrations apply once and the committed schema dump matches the database', async () => {
  const before = await schemaDump(databaseUrl);
  await migrate(databaseUrl);
  expect(await schemaDump(databaseUrl)).toBe(before);
  expect(before).toBe(await Bun.file(new URL('../db/schema.sql', import.meta.url)).text());
  const { rows } = await pool.query('SELECT count(*)::int AS partitions FROM core.partition');
  expect(rows).toEqual([{ partitions: 4096 }]);
});
