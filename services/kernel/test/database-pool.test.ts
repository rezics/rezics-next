import { expect, test } from 'bun:test';
import { ConfigError, readConfig, startServer } from '../src/server.ts';
import { createPool } from '../src/database/pool.ts';
import { newId } from '../src/route/route.ts';
import { testReceiptKeysEnv } from './support/receipt-keys.ts';
import { withIndependentReadSnapshots, withReadTransaction, withRequestDeadline } from '../src/semantic/read.ts';
import { AccessUnavailableError } from '../src/access/unavailable.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const routeKey = Buffer.alloc(32, 1).toString('base64url');
const sessionKey = Buffer.alloc(32, 2).toString('base64url');
const baseEnv = {
  ...testReceiptKeysEnv(),
  DATABASE_URL: databaseUrl,
  KERNEL_ROUTE_KEY: routeKey,
  KERNEL_SESSION_KEYS: `1:${sessionKey}`,
};

function withPoolTimeout<T>(value: string | undefined, use: () => T): T {
  const previous = process.env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS;
  if (value === undefined) delete process.env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS;
  else process.env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS = value;
  try {
    return use();
  } finally {
    if (previous === undefined) delete process.env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS;
    else process.env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS = previous;
  }
}

async function poolTimeout(value?: string, explicit?: number): Promise<number> {
  const pool = withPoolTimeout(value, () =>
    createPool('postgres://kernel.invalid/pool-test', {
      ...(explicit === undefined ? {} : { connectionTimeoutMillis: explicit }),
    }),
  );
  try {
    return pool.options.connectionTimeoutMillis!;
  } finally {
    await pool.end();
  }
}

test('pool acquisition timeout defaults to 200 ms, accepts bounded integers, and allows explicit overrides', async () => {
  expect(readConfig(baseEnv).poolAcquireTimeoutMillis).toBe(200);
  expect(readConfig({ ...baseEnv, KERNEL_POOL_ACQUIRE_TIMEOUT_MS: '50' }).poolAcquireTimeoutMillis).toBe(50);
  expect(readConfig({ ...baseEnv, KERNEL_POOL_ACQUIRE_TIMEOUT_MS: '10000' }).poolAcquireTimeoutMillis).toBe(10000);
  expect(await poolTimeout()).toBe(200);
  expect(await poolTimeout('50')).toBe(50);
  expect(await poolTimeout('10000')).toBe(10000);
  expect(await poolTimeout('500', 125)).toBe(125);

  for (const value of ['49', '10001', '1.5', '1e2', 'not-a-number', '']) {
    const env = { ...baseEnv, KERNEL_POOL_ACQUIRE_TIMEOUT_MS: value };
    let error: unknown;
    try {
      readConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('KERNEL_POOL_ACQUIRE_TIMEOUT_MS');
  }
});

test('a started server fills its pool before serving and retains every connection while idle', async () => {
  const config = { ...readConfig({ ...baseEnv, KERNEL_PORT: '0' }), poolIdleTimeoutMillis: 50 };
  const server = await startServer(config);

  const pool = server.pool;
  const origin = server.url.href.replace(/\/$/, '');
  try {
    expect(pool.totalCount).toBe(pool.max);
    const totalBeforeRequest = pool.totalCount;
    const firstRequest = await fetch(`${origin}/v1/subjects/${newId(0x0042)}`);
    expect(firstRequest.status).toBe(404);
    expect(pool.totalCount).toBe(totalBeforeRequest);

    await Bun.sleep(pool.idleTimeoutMillis + 50);
    expect(pool.totalCount).toBe(pool.max);
    expect(pool.idleCount).toBe(pool.max);
  } finally {
    await server.stop();
  }
});

test('independent read snapshots keep one backend and observe a concurrent commit between cuts', async () => {
  const reader = createPool(databaseUrl!);
  const writer = createPool(databaseUrl!);
  const client = await writer.connect();
  let leased = 0;
  reader.on('acquire', () => {
    leased++;
  });
  try {
    await client.query('BEGIN');
    const { xid } = (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!;
    const observe = () =>
      withReadTransaction(reader, async (tx) => {
        const row = (
          await tx.query<{ pid: number; visible: boolean; mode: string; timeout_ms: number }>(
            `SELECT pg_backend_pid() AS pid, pg_visible_in_snapshot($1::xid8, pg_current_snapshot()) AS visible,
                current_setting('transaction_isolation') AS mode, setting::integer AS timeout_ms
         FROM pg_settings WHERE name='statement_timeout'`,
            [xid],
          )
        ).rows[0]!;
        expect(row.mode).toBe('repeatable read');
        expect(row.timeout_ms).toBeGreaterThan(0);
        return row;
      });
    await withIndependentReadSnapshots(reader, observe, async (first) => {
      await client.query('COMMIT');
      const second = await observe();
      expect(first.visible).toBe(false);
      expect(second.visible).toBe(true);
      expect(first.pid).toBe(second.pid);
    });
    expect(leased).toBe(1);
  } finally {
    client.release(true);
    await Promise.all([reader.end(), writer.end()]);
  }
});

test('independent snapshots preserve per-step background deadlines and the shared request deadline', async () => {
  const pool = createPool(databaseUrl!);
  try {
    const observe = (duration: number) =>
      withReadTransaction(
        pool,
        async (tx) =>
          (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid, pg_sleep($1)', [duration])).rows[0]!.pid,
      );
    await withIndependentReadSnapshots(
      pool,
      () => observe(1.05),
      async (first) => {
        expect(await observe(1.05)).toBe(first);
      },
    );
    let activeBackend: number | undefined;
    const bounded = withRequestDeadline(Date.now() + 150, () =>
      withIndependentReadSnapshots(
        pool,
        () => observe(0),
        async (first) => {
          activeBackend = first;
          return observe(1);
        },
      ),
    );
    await expect(bounded).rejects.toBeInstanceOf(AccessUnavailableError);
    expect(activeBackend).toBeDefined();
    expect(
      (await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'", [activeBackend]))
        .rowCount,
    ).toBe(0);
    expect(await observe(0)).toBeGreaterThan(0);
  } finally {
    await pool.end();
  }
});
