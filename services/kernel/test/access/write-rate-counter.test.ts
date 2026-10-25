import { afterAll, beforeEach, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { AccessClient } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url, max: 8 });
afterAll(() => pool.end());
beforeEach(() => pool.query('TRUNCATE access.write_rate_counter'));
const input = { identityDigest: 'a'.repeat(64), family: 'write', units: 3, budget: { maximum: 10, seconds: 60 } };
async function spend(client: AccessClient = pool, value = input) {
  const { spendWriteRateCounter } = await import('../../src/access/write-rate-counter.ts');
  return spendWriteRateCounter(client, value);
}
async function stored() {
  return (await pool.query('SELECT count, expires_at::text AS expiry FROM access.write_rate_counter')).rows;
}

test('unlogged native counter spends all units atomically with a single point upsert', async () => {
  const metadata = await pool.query(`SELECT relpersistence, relkind FROM pg_class
    WHERE oid = 'access.write_rate_counter'::regclass`);
  expect(metadata.rows).toEqual([{ relpersistence: 'u', relkind: 'r' }]);
  const indexes = await pool.query(`SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'access' AND tablename = 'write_rate_counter'`);
  expect(indexes.rows.some((row) => /UNIQUE.*\(identity_digest, family\)/.test(row.indexdef))).toBe(true);
  expect(indexes.rows.some((row) => /\(expires_at\)/.test(row.indexdef))).toBe(true);
  expect(await spend()).toEqual({ allowed: true });
  expect(await spend(pool, { ...input, units: 7 })).toEqual({ allowed: true });
  expect((await stored()).map((row) => row.count)).toEqual([10]);
});

test('denied batch keeps original expiry and no partial debit', async () => {
  expect(await spend()).toEqual({ allowed: true });
  const before = await stored();
  for (let attempt = 0; attempt < 3; attempt++) {
    const denied = await spend(pool, { ...input, units: 8, budget: { maximum: 10, seconds: 172800 } });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error('Expected denial');
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(denied.retryAfter).toBeLessThanOrEqual(60);
    expect(await stored()).toEqual(before);
  }
  expect(await spend(pool, { ...input, units: 7 })).toEqual({ allowed: true });
});

test('over-budget first and expired batches record zero accepted units', async () => {
  const batch = { ...input, units: 11 };
  expect(await spend(pool, batch)).toEqual({ allowed: false, retryAfter: 60 });
  expect((await stored()).map((row) => row.count)).toEqual([0]);
  expect(await spend(pool, { ...input, units: 10 })).toEqual({ allowed: true });
  await pool.query("UPDATE access.write_rate_counter SET expires_at = statement_timestamp() - interval '1 second'");
  expect(await spend(pool, batch)).toEqual({ allowed: false, retryAfter: 60 });
  expect((await stored()).map((row) => row.count)).toEqual([0]);
});

test('concurrent admission never exceeds maximum', async () => {
  const clients = await Promise.all(Array.from({ length: 8 }, () => pool.connect()));
  try {
    expect(
      new Set(
        (await Promise.all(clients.map((c) => c.query('SELECT pg_backend_pid() AS pid')))).map((r) => r.rows[0].pid),
      ).size,
    ).toBe(8);
    for (const expired of [false, true]) {
      await poolReset(clients[0]!);
      if (expired)
        await clients[0]!.query(
          `INSERT INTO access.write_rate_counter
        (identity_digest, family, count, expires_at) VALUES ($1, $2, 10, statement_timestamp() - interval '1 second')`,
          [input.identityDigest, input.family],
        );
      const decisions = await Promise.all(clients.flatMap((client) => Array.from({ length: 4 }, () => spend(client))));
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
      const rows = await clients[0]!.query('SELECT count FROM access.write_rate_counter');
      expect(rows.rows).toEqual([{ count: 9 }]);
      expect(await spend(clients[0]!, { ...input, units: 1 })).toEqual({ allowed: true });
    }
  } finally {
    clients.forEach((client) => client.release());
  }
});
async function poolReset(client: AccessClient) {
  await client.query('TRUNCATE access.write_rate_counter');
}

test('expiry boundary uses database statement time and resets lazily', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_sleep(0.03)');
    // Expiry equals this statement timestamp, after transaction start. now() would reject.
    await client.query(
      `INSERT INTO access.write_rate_counter (identity_digest, family, count, expires_at)
      VALUES ($1, $2, 10, statement_timestamp())`,
      [input.identityDigest, input.family],
    );
    expect(await spend(client, { ...input, units: 7, budget: { maximum: 7, seconds: 90 } })).toEqual({ allowed: true });
    const row = (
      await client.query(`SELECT count, expires_at > statement_timestamp() + interval '89 seconds' AS fresh
      FROM access.write_rate_counter`)
    ).rows[0];
    expect(row).toEqual({ count: 7, fresh: true });
    await client.query(
      "UPDATE access.write_rate_counter SET count = 10, expires_at = statement_timestamp() + interval '0.25 seconds'",
    );
    expect(await spend(client)).toEqual({ allowed: false, retryAfter: 1 });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('class budget changes share a key without shortening, extending or decrementing its window', async () => {
  expect(await spend(pool, { ...input, units: 10 })).toEqual({ allowed: true });
  const before = await stored();
  expect((await spend(pool, { ...input, budget: { maximum: 5, seconds: 1 } })).allowed).toBe(false);
  expect(await stored()).toEqual(before);
  expect(await spend(pool, { ...input, units: 5, budget: { maximum: 15, seconds: 172800 } })).toEqual({
    allowed: true,
  });
  expect(await stored()).toEqual([{ count: 15, expiry: before[0].expiry }]);
  expect(await spend(pool, { ...input, family: 'upload', units: 10 })).toEqual({ allowed: true });
  expect(await spend(pool, { ...input, identityDigest: 'b'.repeat(64), units: 10 })).toEqual({ allowed: true });
  expect(await stored()).toHaveLength(3);
});

test('maximum count cannot overflow and denials never decrement it', async () => {
  await pool.query(
    `INSERT INTO access.write_rate_counter (identity_digest, family, count, expires_at)
    VALUES ($1, $2, 2147483646, statement_timestamp() + interval '60 seconds')`,
    [input.identityDigest, input.family],
  );
  const budget = { maximum: 2147483647, seconds: 60 };
  expect((await spend(pool, { ...input, units: 100, budget })).allowed).toBe(false);
  expect((await stored())[0].count).toBe(2147483646);
  expect(await spend(pool, { ...input, units: 1, budget })).toEqual({ allowed: true });
  expect((await spend(pool, { ...input, units: 100, budget })).allowed).toBe(false);
  expect((await stored())[0].count).toBe(2147483647);
  await expect(pool.query('UPDATE access.write_rate_counter SET count = -1')).rejects.toMatchObject({ code: '23514' });
});

test('invalid trusted-stage inputs fail before any I/O', async () => {
  let calls = 0;
  const client = {
    query() {
      calls++;
      throw new Error('Unexpected I/O');
    },
  } as unknown as AccessClient;
  const invalid = [
    ...['', 'x'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64)].map((identityDigest) => ({
      ...input,
      identityDigest,
    })),
    ...['', 'a'.repeat(65), 'write account', 'write\n', 'write/class'].map((family) => ({ ...input, family })),
    ...[0, -1, 1.5, 101, NaN, Infinity].map((units) => ({ ...input, units })),
    ...[0, -1, 1.5, 2147483648, NaN, Infinity].map((maximum) => ({ ...input, budget: { ...input.budget, maximum } })),
    ...[0, -1, 1.5, 172801, NaN, Infinity].map((seconds) => ({ ...input, budget: { ...input.budget, seconds } })),
  ];
  for (const value of invalid) await expect(spend(client, value)).rejects.toBeInstanceOf(RangeError);
  expect(calls).toBe(0);
});

test('storage errors and missing results cannot become admissions', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await expect(spend(client)).rejects.toMatchObject({ code: '25006' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const missing = { query: async () => ({ rows: [] }) } as unknown as AccessClient;
  await expect(spend(missing)).rejects.toThrow();
  const closed = new Pool({ connectionString: url });
  await closed.end();
  await expect(spend(closed)).rejects.toThrow();
});
