import { afterAll, expect, spyOn, test } from 'bun:test';
import pg, { type QueryConfig } from 'pg';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { newId } from '../../src/route/route.ts';
import { readSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const timeouts: number[] = [];
let delayRead = false;
let delayedReads = 0;
let resumeClock: (() => void) | undefined;

pool.on('connect', (client) => {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  client.query = ((statement: string | QueryConfig, ...args: unknown[]) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    const timeout = /statement_timeout\s*=\s*'(\d+)ms'/.exec(text);
    if (timeout) timeouts.push(Number(timeout[1]));
    if (delayRead) {
      delayedReads++;
      resumeClock?.();
      return Bun.sleep(20).then(() => query(statement, ...args));
    }
    return query(statement, ...args);
  }) as typeof client.query;
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

const id = newId(0x0042);
const allow = async () => true;
const realAccess = await createRealAccess(admin, {}, ['subject:read']);

test("a semantic read's statement timeout is the time left before its request deadline", async () => {
  // Warm the connection and SQL analysis before measuring a short request budget.
  expect(await readSubject(pool, id, allow, undefined, new Uint8Array(32).fill(13))).toBeNull();
  const outside = timeouts.at(-1)!;
  expect(outside).toBeGreaterThanOrEqual(1);
  expect(outside).toBeLessThanOrEqual(DEFAULT_REQUEST_DEADLINE_MS);

  timeouts.length = 0;
  await withRequestDeadline(Date.now() + 150, () =>
    readSubject(pool, id, allow, undefined, new Uint8Array(32).fill(13)),
  );
  expect(timeouts).toHaveLength(1);
  expect(timeouts[0]).toBeGreaterThanOrEqual(1);
  expect(timeouts[0]).toBeLessThanOrEqual(150);

  timeouts.length = 0;
  await withRequestDeadline(Date.now() + 5_000, () =>
    readSubject(pool, id, allow, undefined, new Uint8Array(32).fill(13)),
  );
  expect(timeouts).toHaveLength(1);
  expect(timeouts[0]).toBeGreaterThan(DEFAULT_REQUEST_DEADLINE_MS);
  expect(timeouts[0]).toBeLessThanOrEqual(5_000);
});

test('a subject read rejects expiry while waiting for its snapshot', async () => {
  delayRead = true;
  try {
    await expect(
      withRequestDeadline(Date.now() + 10, () => readSubject(pool, id, allow, undefined, new Uint8Array(32).fill(13))),
    ).rejects.toMatchObject({
      reason: 'deadline',
    });
  } finally {
    delayRead = false;
  }
});

test('an expired subject read answers retryable 503 instead of 404', async () => {
  const kernel = createKernel({
    pool,
    access: realAccess.access,
    writeRate: realAccess.writeRate,
    routeKey: new Uint8Array(32).fill(13),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) },
    requestDeadlineMs: 1,
  });
  // Compile routes and initialize Access outside the measured request.
  kernel.compile();
  await kernel.handle(new Request(`http://kernel.test/v1/subjects/${id}`));
  delayedReads = 0;
  delayRead = true;
  // Start elapsed time at the transport, so admission scheduling cannot consume the 1ms budget first.
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  resumeClock = () => clock.mockRestore();
  try {
    const response = await kernel.handle(new Request(`http://kernel.test/v1/subjects/${id}`));
    expect(delayedReads).toBeGreaterThan(0);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'deadline_exceeded', retryable: true });
  } finally {
    delayRead = false;
    resumeClock = undefined;
    clock.mockRestore();
  }
});
