import { expect, test } from 'bun:test';
import { ConfigError, readConfig, startServer } from '../src/server.ts';
import { createPool } from '../src/database/pool.ts';
import { newId } from '../src/route/route.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const routeKey = Buffer.alloc(32, 1).toString('base64url');
const sessionKey = Buffer.alloc(32, 2).toString('base64url');
const baseEnv = {
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
