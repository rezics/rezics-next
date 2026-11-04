import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { readConfig, startServer } from '../../src/server.ts';
import '../../src/worker.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const key = () => randomBytes(32).toString('base64url');

test('the server and worker entries import and the API serves health', async () => {
  const server = await startServer(
    readConfig({
      DATABASE_URL: databaseUrl,
      KERNEL_ROUTE_KEY: key(),
      KERNEL_SESSION_KEYS: `1:${key()}`,
      KERNEL_WRITE_RATE_SECRET: key(),
      KERNEL_PORT: '0',
    }),
  );
  try {
    const health = await fetch(new URL('/health', server.url));
    expect([health.status, await health.json()]).toEqual([200, { status: 'ok' }]);
  } finally {
    await server.stop();
  }
});
