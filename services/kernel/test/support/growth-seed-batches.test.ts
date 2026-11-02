import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { SEED_BATCH_BYTE_LIMIT, SEED_BATCH_ROW_LIMIT, seedBulkRows, type SeedRow } from './growth-seed-batches.ts';

type Insert = { readonly table: string; readonly rows: SeedRow[] };

function recordingPool(options: { readonly insertFailure?: Error; readonly rollbackFailure?: Error } = {}) {
  const transactions: Insert[][] = [];
  const calls: string[] = [];
  const releases: (Error | undefined)[] = [];
  let current: Insert[] = [];
  let connections = 0;
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push(sql);
      if (sql === 'BEGIN') current = [];
      else if (sql === 'ROLLBACK' && options.rollbackFailure) throw options.rollbackFailure;
      else if (sql === 'COMMIT') transactions.push(current);
      else if (sql.startsWith('INSERT INTO')) {
        if (options.insertFailure) throw options.insertFailure;
        const table = /INSERT INTO "([^"]+)"\."([^"]+)"/.exec(sql);
        current.push({ table: `${table?.[1]}.${table?.[2]}`, rows: JSON.parse(String(values?.[0])) as SeedRow[] });
      }
      return { rows: [], rowCount: 0 };
    },
    release(error?: Error) {
      releases.push(error);
    },
  };
  const admin = {
    async connect() {
      connections++;
      return client;
    },
  } as unknown as Pool;
  return { admin, calls, connections: () => connections, releases, transactions };
}

test('splits by total rows and preserves placement, table order, and supported encodings', async () => {
  const database = recordingPool();
  const created = new Date('2025-04-03T02:01:00.000Z');
  await seedBulkRows(
    database.admin,
    4,
    5,
    (ordinal) => ({ ordinal, route: 12 }),
    ({ ordinal, route }) => ({
      'growth.parent': Array.from({ length: SEED_BATCH_ROW_LIMIT + 1 }, (_, id) => ({ route, id: ordinal * 501 + id })),
      'growth.child': [
        { route, id: 900n + BigInt(ordinal), created, bytes: new Uint8Array([0, 255]), values: [null, true] },
      ],
    }),
  );

  expect(database.transactions).toHaveLength(2);
  expect(database.transactions[0]!.map(({ table, rows }) => [table, rows.length])).toEqual([['growth.parent', 500]]);
  expect(database.transactions[0]![0]!.rows[0]).toEqual({ route: 12, id: 4 * 501 });
  expect(database.transactions[1]!.map(({ table, rows }) => [table, rows.length])).toEqual([
    ['growth.parent', 1],
    ['growth.child', 1],
  ]);
  expect(database.transactions[1]![0]!.rows[0]).toEqual({ route: 12, id: 4 * 501 + 500 });
  expect(database.transactions[1]![1]!.rows[0]).toEqual({
    route: 12,
    id: '904',
    created: '2025-04-03T02:01:00.000Z',
    bytes: '\\x00ff',
    values: [null, true],
  });
});

test('preserves each ordinal when a row and nested byte container are reused', async () => {
  const database = recordingPool();
  const bytes = new Uint8Array([0]);
  const nested = { n: 0 };
  const row = { id: 0n, bytes, nested };
  await seedBulkRows(database.admin, 0, 3, (ordinal) => ordinal, (ordinal) => {
    row.id = BigInt(ordinal);
    bytes[0] = ordinal;
    nested.n = ordinal;
    return { 'growth.reused': [row] };
  });

  expect(database.transactions).toEqual([
    [
      {
        table: 'growth.reused',
        rows: [
          { id: '0', bytes: '\\x00', nested: { n: 0 } },
          { id: '1', bytes: '\\x01', nested: { n: 1 } },
          { id: '2', bytes: '\\x02', nested: { n: 2 } },
        ],
      },
    ],
  ]);
});

test('keeps total encoded payload bytes within each batch below the row limit', async () => {
  const database = recordingPool();
  const largeValue = 'x'.repeat(400_000);
  await seedBulkRows(
    database.admin,
    0,
    1,
    () => 0,
    () => ({ 'growth.payload': [0, 1, 2].map((id) => ({ id, value: largeValue })) }),
  );

  expect(database.transactions).toHaveLength(2);
  for (const transaction of database.transactions) {
    const payloadBytes = transaction.reduce(
      (total, insert) => total + Buffer.byteLength(JSON.stringify(insert.rows)),
      0,
    );
    expect(payloadBytes).toBeLessThanOrEqual(SEED_BATCH_BYTE_LIMIT);
  }
  expect(database.transactions.map((transaction) => transaction[0]!.rows.length)).toEqual([2, 1]);
});

test('rejects one oversized row before acquiring a connection', async () => {
  const database = recordingPool();
  const oversized = 'x'.repeat(SEED_BATCH_BYTE_LIMIT);

  await expect(
    seedBulkRows(
      database.admin,
      0,
      1,
      () => 0,
      () => ({ 'growth.large': [{ value: oversized }] }),
    ),
  ).rejects.toThrow(/growth\.large at ordinal 0.*1,048,576-byte/);
  expect(database.connections()).toBe(0);
});

test('preserves an insert failure when rollback fails and discards the damaged connection', async () => {
  const insertFailure = new Error('insert failed');
  const rollbackFailure = new Error('rollback failed');
  const database = recordingPool({ insertFailure, rollbackFailure });

  await expect(
    seedBulkRows(
      database.admin,
      0,
      1,
      () => 0,
      () => ({ 'growth.parent': [{ id: 1 }] }),
    ),
  ).rejects.toBe(insertFailure);
  expect(database.calls).toEqual(['BEGIN', expect.stringContaining('INSERT INTO'), 'ROLLBACK']);
  expect(database.releases).toEqual([rollbackFailure]);
});
