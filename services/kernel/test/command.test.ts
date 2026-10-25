import { afterAll, afterEach, expect, test } from 'bun:test';
import pg from 'pg';
import { CommandUnavailableError, runCommand, type CommandEvent } from '../src/command/command.ts';
import { createPool, NestedPoolCheckoutError } from '../src/database/pool.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const partitions = [7, 8, 9, 10, 11, ...Array.from({ length: 11 }, (_, n) => 100 + n)];
afterEach(async () => {
  await admin.query(
    "UPDATE core.partition SET write_state = 'active', moved_to = NULL, position = 0 WHERE partition_no = ANY($1)",
    [partitions],
  );
  await admin.query('DELETE FROM core.outbox WHERE partition_no = ANY($1)', [partitions]);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const event = (n: number): CommandEvent => ({ type: 'com.rezics.test.happened.v1', subject: `s${n}`, data: { n } });
const failure = (code: string) => Object.assign(new Error(`failure ${code}`), { code });
async function position(partition: number): Promise<number> {
  const { rows } = await admin.query('SELECT position::int FROM core.partition WHERE partition_no = $1', [partition]);
  return rows[0].position;
}

test('a command runs serializable with its timeouts, takes the next position and appends one envelope', async () => {
  const first = await runCommand(pool, { partition: 7 }, async (tx) => {
    const { rows } = await tx.query(`SELECT current_setting('transaction_isolation') AS isolation,
      (SELECT setting::int FROM pg_settings WHERE name = 'lock_timeout') AS lock,
      (SELECT setting::int FROM pg_settings WHERE name = 'statement_timeout') AS statement,
      (SELECT setting::int FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout') AS idle`);
    return { value: rows[0], events: [event(1), event(2)] };
  });
  expect(first).toMatchObject({ value: { isolation: 'serializable', lock: 200, idle: 5000 }, partition: 7, epoch: 1 });
  expect(first.position).toBe(1n);
  expect(first.value.statement).toBeGreaterThan(1500);
  expect(first.value.statement).toBeLessThanOrEqual(2000);
  const second = await runCommand(pool, { partition: 7 }, async () => ({ value: null, events: [event(3)] }));
  expect(second).toEqual({ value: null, partition: 7, epoch: 1, position: 2n });
  expect(await position(7)).toBe(2);
  const { rows } = await admin.query(`SELECT position::int, event_seq, event_count, epoch, id::text, type, subject, data
    FROM core.outbox WHERE partition_no = 7 ORDER BY position, event_seq`);
  const type = 'com.rezics.test.happened.v1';
  expect(rows.map(({ id: _, ...row }) => row)).toEqual([
    { position: 1, event_seq: 0, event_count: 2, epoch: 1, type, subject: 's1', data: { n: 1 } },
    { position: 1, event_seq: 1, event_count: 2, epoch: 1, type, subject: 's2', data: { n: 2 } },
    { position: 2, event_seq: 0, event_count: 1, epoch: 1, type, subject: 's3', data: { n: 3 } },
  ]);
  for (const { id } of rows)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(new Set(rows.map(({ id }) => id)).size).toBe(3);
});

test('a failed command leaves no position and no events', async () => {
  const thrown = new Error('domain rule');
  await expect(
    runCommand(pool, { partition: 8 }, async (tx) => {
      await tx.query('SELECT 1');
      throw thrown;
    }),
  ).rejects.toBe(thrown);
  await expect(runCommand(pool, { partition: 8 }, async () => ({ value: null, events: [] }))).rejects.toThrow(
    TypeError,
  );
  let called = false;
  await expect(
    runCommand(pool, { partition: 4096 }, async () => {
      called = true;
      return { value: null, events: [event(1)] };
    }),
  ).rejects.toThrow(RangeError);
  expect(called).toBe(false);
  expect(await position(8)).toBe(0);
  expect((await admin.query('SELECT count(*)::int AS n FROM core.outbox WHERE partition_no = 8')).rows).toEqual([
    { n: 0 },
  ]);
});

test('commands that collide at the fence retry and both commit', async () => {
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => (release = resolve));
  const command = (n: number) =>
    runCommand(pool, { partition: 9 }, async (tx) => {
      await tx.query('SELECT position FROM core.partition WHERE partition_no = 9');
      if (++started === 2) release();
      await bothStarted;
      return { value: n, events: [event(n)] };
    });
  const results = await Promise.all([command(1), command(2)]);
  expect(started).toBe(3);
  expect(results.map((result) => result.position).sort()).toEqual([1n, 2n]);
  expect(await position(9)).toBe(2);
});

test('contention is retried at most three times and other failures are not retried', async () => {
  let calls = 0;
  const error = await runCommand(pool, { partition: 10 }, async () => {
    calls++;
    throw failure('40001');
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CommandUnavailableError);
  expect(error).toMatchObject({ reason: 'contention', partition: 10 });
  expect(calls).toBe(3);
  calls = 0;
  const recovered = await runCommand(pool, { partition: 10 }, async () => {
    if (++calls < 3) throw failure(calls === 1 ? '40P01' : '55P03');
    return { value: calls, events: [event(1)] };
  });
  expect(recovered).toMatchObject({ value: 3, position: 1n });
  calls = 0;
  const unique = failure('23505');
  await expect(
    runCommand(pool, { partition: 10 }, async () => {
      calls++;
      throw unique;
    }),
  ).rejects.toBe(unique);
  expect(calls).toBe(1);
});

test('a fenced partition is retried until it opens or the deadline passes', async () => {
  await admin.query("UPDATE core.partition SET write_state = 'fenced' WHERE partition_no = 11");
  const started = Date.now();
  const error = await runCommand(pool, { partition: 11, deadline: started + 300 }, async () => ({
    value: null,
    events: [event(1)],
  })).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CommandUnavailableError);
  expect(error).toMatchObject({ reason: 'fenced', partition: 11, movedTo: null });
  expect(Date.now() - started).toBeLessThan(1000);
  setTimeout(() => void admin.query("UPDATE core.partition SET write_state = 'active' WHERE partition_no = 11"), 150);
  const opened = await runCommand(pool, { partition: 11 }, async () => ({ value: 'done', events: [event(2)] }));
  expect(opened).toMatchObject({ value: 'done', position: 1n });
});

test('a moved partition fails at once and names its new node', async () => {
  await admin.query("UPDATE core.partition SET write_state = 'moved', moved_to = 'a' WHERE partition_no = 11");
  let calls = 0;
  const error = await runCommand(pool, { partition: 11 }, async () => {
    calls++;
    return { value: null, events: [event(1)] };
  }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ reason: 'moved', partition: 11, movedTo: 'a' });
  expect(calls).toBe(1);
  expect(await position(11)).toBe(0);
});

test('a statement still running at the deadline is cancelled', async () => {
  const started = Date.now();
  const error = await runCommand(pool, { partition: 8, deadline: started + 300 }, async (tx) => {
    await tx.query('SELECT pg_sleep(2)');
    return { value: null, events: [event(1)] };
  }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ reason: 'deadline', partition: 8 });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(await position(8)).toBe(0);
});

test('a command cannot take a second connection from its pool', async () => {
  await expect(
    runCommand(pool, { partition: 8 }, async () => {
      await pool.query('SELECT 1');
      return { value: null, events: [event(1)] };
    }),
  ).rejects.toBeInstanceOf(NestedPoolCheckoutError);
  await expect(
    runCommand(pool, { partition: 8 }, async () => {
      await runCommand(pool, { partition: 9 }, async () => ({ value: null, events: [event(1)] }));
      return { value: null, events: [event(2)] };
    }),
  ).rejects.toBeInstanceOf(NestedPoolCheckoutError);
  expect((await pool.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
  expect([await position(8), await position(9)]).toEqual([0, 0]);
  expect(pool.options).toMatchObject({ max: 10, connectionTimeoutMillis: 200, idleTimeoutMillis: 30_000 });
});

test('a command that cannot get a connection in time is refused as overloaded', async () => {
  let holding = 0;
  let allHolding!: () => void;
  const ready = new Promise<void>((resolve) => (allHolding = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const holders = Array.from({ length: 10 }, (_, n) =>
    runCommand(pool, { partition: 100 + n }, async () => {
      if (++holding === 10) allHolding();
      await held;
      return { value: n, events: [event(n)] };
    }),
  );
  await ready;
  const started = Date.now();
  const error = await runCommand(pool, { partition: 110 }, async () => ({ value: null, events: [event(0)] })).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CommandUnavailableError);
  expect(error).toMatchObject({ reason: 'overloaded', partition: 110 });
  expect(Date.now() - started).toBeLessThan(1000);
  release();
  expect((await Promise.all(holders)).map((result) => result.position)).toEqual(Array(10).fill(1n));
});
