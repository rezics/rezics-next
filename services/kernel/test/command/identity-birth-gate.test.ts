import { afterAll, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { beginIdentityBirthTransaction } from '../../src/command/gate.ts';
import {
  createPool,
  withBoundedCommandConnection,
  withBoundedReadConnection,
  withConnection,
  withPretransactionReads,
  withQueryAccounting,
} from '../../src/database/pool.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the test database');
const pool = createPool(url);
afterAll(() => pool.end());

test('a different home sharing the birth shard starts its serializable snapshot after the first commit', async () => {
  const first = await pool.connect();
  const second = await pool.connect();
  const observer = await pool.connect();
  const home = randomInt(0, 64);
  let waiting: ReturnType<typeof beginIdentityBirthTransaction> | undefined;
  try {
    const deadline = Date.now() + 10_000;
    const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    expect(await beginIdentityBirthTransaction(first, home)).toBe('writer');
    const { xid, pid } = (await first.query('SELECT pg_current_xact_id()::text AS xid, pg_backend_pid() AS pid'))
      .rows[0]!;
    waiting = beginIdentityBirthTransaction(second, home + 64, { deadline, prepare: async () => {} });
    // The independent shard retains its own writer even while these two homes contend.
    expect(await beginIdentityBirthTransaction(observer, home + 1)).toBe('writer');
    await observer.query('ROLLBACK');
    expect(await beginIdentityBirthTransaction(observer, home + 128)).toBe('receipt');
    await observer.query('ROLLBACK');
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      blocked = (await observer.query('SELECT $1::integer = ANY(pg_blocking_pids($2)) AS blocked', [pid, secondPid]))
        .rows[0]!.blocked;
      if (!blocked) await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    await first.query('COMMIT');
    expect(await waiting).toBe('writer');
    expect((await second.query('SHOW transaction_isolation')).rows[0]).toEqual({
      transaction_isolation: 'serializable',
    });
    expect(
      (await second.query('SELECT pg_visible_in_snapshot($1::xid8, pg_current_snapshot()) AS visible', [xid])).rows[0],
    ).toEqual({ visible: true });
  } finally {
    await first.query('ROLLBACK');
    await waiting?.catch(() => {});
    await second.query('ROLLBACK');
    await observer.query('ROLLBACK');
    first.release();
    second.release();
    observer.release();
  }
});

test('preparation keeps local bounded reads on the writer lease and a different pool on its own backend', async () => {
  const remote = createPool(url!);
  const deadline = Date.now() + 5_000;
  const home = randomInt(0, 64);
  try {
    await withBoundedCommandConnection(pool, deadline, async (client) => {
      const { pid } = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!;
      const read = (source: typeof pool) =>
        withBoundedReadConnection(source, deadline, async (connection) => {
          const row = (
            await connection.query(
              "SELECT pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation",
            )
          ).rows[0]!;
          return row;
        });
      expect(
        await beginIdentityBirthTransaction(client, home, {
          deadline,
          prepare: () =>
            withPretransactionReads(pool, client, async () => {
              const [local, second, other] = await Promise.all([read(pool), read(pool), read(remote)]);
              expect(local).toEqual({ pid, isolation: 'read committed' });
              expect(second).toEqual(local);
              expect(other.pid).not.toBe(pid);
              await expect(pool.connect()).rejects.toThrow('second connection');
            }),
        }),
      ).toBe('writer');
      expect((await client.query('SHOW transaction_isolation')).rows[0]!.transaction_isolation).toBe('serializable');
      await client.query('ROLLBACK');
    });
  } finally {
    await remote.end();
  }
});

test('a rejected preparation releases its confirmed native lease and preserves the rejection', async () => {
  const home = randomInt(0, 64);
  const deadline = Date.now() + 5_000;
  await withBoundedCommandConnection(pool, deadline, async (client) => {
    await expect(
      beginIdentityBirthTransaction(client, home, {
        deadline,
        prepare: async () => {
          throw new Error('Revoked original grant');
        },
      }),
    ).rejects.toThrow('Revoked original grant');
    expect(
      (await client.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'"))
        .rows[0],
    ).toEqual({ n: 0 });
  });
});

test('the original deadline retires a blocked checkout before its preparation can run', async () => {
  const blocker = await pool.connect();
  const home = randomInt(0, 64);
  let prepared = false;
  const deadline = Date.now() + 200;
  try {
    expect(await beginIdentityBirthTransaction(blocker, home)).toBe('writer');
    await expect(
      withBoundedCommandConnection(pool, deadline, (client) =>
        beginIdentityBirthTransaction(client, home, {
          deadline,
          prepare: async () => {
            prepared = true;
          },
        }),
      ),
    ).rejects.toThrow();
    expect(prepared).toBe(false);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  await withConnection(pool, async (client) => {
    expect(await beginIdentityBirthTransaction(client, home)).toBe('writer');
    await client.query('ROLLBACK');
  });
});

test.each(['pg_try_advisory_lock(', 'pg_advisory_lock(', 'pg_advisory_xact_lock('])(
  'a lost %s reply discards the physical backend and its lock',
  async (boundary) => {
    const home = randomInt(0, 64);
    let lostPid = 0;
    await expect(
      withQueryAccounting(
        {
          connection: (dispatch) => dispatch(),
          async query(sql, _values, dispatch) {
            const result = await dispatch();
            if (sql.includes(boundary)) throw new Error('Lost native birth lock reply');
            return result;
          },
        },
        () =>
          withBoundedCommandConnection(pool, Date.now() + 5_000, async (client) => {
            lostPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            const wait =
              boundary === 'pg_advisory_lock(' ? { deadline: Date.now() + 4_000, prepare: async () => {} } : undefined;
            await beginIdentityBirthTransaction(client, home, wait);
          }),
      ),
    ).rejects.toThrow('Lost native birth lock reply');
    expect(lostPid).toBeGreaterThan(0);
    await withConnection(pool, async (client) => {
      const { pid } = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!;
      expect(pid).not.toBe(lostPid);
      expect(await beginIdentityBirthTransaction(client, home + 64)).toBe('writer');
      await client.query('ROLLBACK');
      expect(
        (await client.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [lostPid]))
          .rows[0],
      ).toEqual({ n: 0 });
    });
  },
);
