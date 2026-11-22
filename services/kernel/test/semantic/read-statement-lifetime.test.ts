import { expect, test } from 'bun:test';
import pg from 'pg';
import { withReadStatement, withReadTransaction } from '../../src/semantic/read.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');

test('a native statement restores the checked-out session timeout and preserves a settled source error', async () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("SET statement_timeout = '17s'");
    const session = async () =>
      (await pool.query("SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout")).rows[0];
    const before = await session();
    await withReadStatement(
      pool,
      async (client) => {
        const {
          rows: [state],
        } = await client.query(
          "SELECT pg_backend_pid() AS pid, setting::int AS ms FROM pg_settings WHERE name = 'statement_timeout'",
        );
        expect(state.pid).toBe(before.pid);
        expect(state.ms).toBeGreaterThan(0);
        expect(state.ms).toBeLessThanOrEqual(500);
      },
      Date.now() + 500,
    );
    expect(await session()).toEqual(before);
    await expect(
      withReadStatement(pool, (c) => c.query('SELECT * FROM pg_catalog.semantic_read_missing_source')),
    ).rejects.toMatchObject({ code: '42P01' });
    expect(await session()).toEqual(before);
    await withReadTransaction(pool, async (outer) => {
      const current = await outer.query('SHOW statement_timeout');
      await withReadStatement(pool, async (inner) => {
        expect(inner).toBe(outer);
        expect((await inner.query('SHOW statement_timeout')).rows).toEqual(current.rows);
      });
    });
    expect(await session()).toEqual(before);
    await pool.query("SET statement_timeout = '120ms'");
    const short = await withReadStatement(pool, (client) => client.query('SHOW statement_timeout'), Date.now() + 1500);
    expect(short.rows).toEqual([{ statement_timeout: '120ms' }]);
    expect((await session()).timeout).toBe('120ms');
  } finally {
    await pool.end();
  }
});

test('an expired native statement stops on the original PostgreSQL backend', async () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  try {
    const {
      rows: [session],
    } = await pool.query('SELECT pg_backend_pid() AS pid');
    const end = Date.now() + 750;
    const sleep = withReadStatement(
      pool,
      async (client) => {
        await client.query('SELECT 1');
        await Bun.sleep(430);
        return client.query('SELECT pg_sleep(5)');
      },
      end,
    );
    const failure = sleep.catch((error: unknown) => error);
    let active = false;
    while (Date.now() < end) {
      const state = await observer.query(
        "SELECT state FROM pg_stat_activity WHERE pid=$1 AND query='SELECT pg_sleep(5)'",
        [session.pid],
      );
      if (state.rows[0]?.state === 'active') {
        active = true;
        break;
      }
      await Bun.sleep(5);
    }
    expect(active).toBe(true);
    expect(await failure).toMatchObject({ reason: 'deadline' });
    let stillRunning = true;
    for (let i = 0; i < 9 && stillRunning; i++) {
      const state = await observer.query(
        "SELECT state FROM pg_stat_activity WHERE pid=$1 AND query='SELECT pg_sleep(5)'",
        [session.pid],
      );
      stillRunning = state.rows[0]?.state === 'active';
      if (stillRunning) await Bun.sleep(20);
    }
    expect(stillRunning).toBe(false);
    expect((await pool.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
  } finally {
    await observer.end();
    await pool.end();
  }
});

test('an expired callback cannot return a session with its temporary timeout to another reader', async () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => (resume = resolve));
  try {
    const {
      rows: [state],
    } = await pool.query("SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout");
    let entered = false;
    const visit = withReadStatement(
      pool,
      async (client) => {
        await client.query('SELECT 1');
        entered = true;
        await wait;
        await client.query('SELECT 2');
      },
      Date.now() + 180,
    );
    await expect(visit).rejects.toMatchObject({ reason: 'deadline' });
    expect(entered).toBe(true);
    const {
      rows: [next],
    } = await pool.query("SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout");
    expect(next.pid).not.toBe(state.pid);
    expect(next.timeout).toBe(state.timeout);
  } finally {
    resume();
    await pool.end();
  }
});
