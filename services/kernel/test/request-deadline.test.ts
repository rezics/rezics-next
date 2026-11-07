import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../src/database/pool.ts';
import { createApp } from '../src/http/app.ts';
import { deadlineFor, withRequestDeadline } from '../src/request/deadline.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

const probe = {
  operationId: 'deadline.probe',
  'x-action': 'deadline:read',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
};
let late: Promise<number> | undefined;
const app = createApp({ pool, requestDeadlineMs: 1_234 }).get('/v1/deadline', { detail: probe }, async ({ job }) => {
  await Bun.sleep(1);
  const nested = await Promise.resolve().then(() => deadlineFor(60_000));
  late = new Promise((resolve) => setTimeout(() => resolve(deadlineFor(60_000)), 50));
  return { job: job.deadline, scoped: deadlineFor(60_000), nested };
});

type Seen = { job: number; scoped: number; nested: number };

test('a route and everything it awaits see the request deadline fixed at arrival', async () => {
  const before = Date.now();
  const response = await app.handle(new Request('http://kernel.test/v1/deadline'));
  const after = Date.now();
  expect(response.status).toBe(200);
  const seen = (await response.json()) as Seen;
  expect(seen.scoped).toBe(seen.job);
  expect(seen.nested).toBe(seen.job);
  expect(seen.job).toBeGreaterThanOrEqual(before + 1_234);
  expect(seen.job).toBeLessThanOrEqual(after + 1_234);
});

test('the request deadline reaches code entered through fetch', async () => {
  const before = Date.now();
  const response = await app.fetch(new Request('http://kernel.test/v1/deadline'));
  const seen = (await response.json()) as Seen;
  expect(seen.scoped).toBe(seen.job);
  expect(seen.job).toBeGreaterThanOrEqual(before + 1_234);
  expect(seen.job).toBeLessThan(before + 60_000);
});

test('a timer that outlives its request gets a fresh budget', async () => {
  const response = await app.handle(new Request('http://kernel.test/v1/deadline'));
  const seen = (await response.json()) as Seen;
  const fired = await late!;
  expect(fired).toBeGreaterThan(seen.job + 50_000);
});

test('concurrent requests keep their own deadlines', async () => {
  const [first, second] = await Promise.all([
    withRequestDeadline(1_000, async () => {
      await Bun.sleep(5);
      return deadlineFor(9);
    }),
    withRequestDeadline(2_000, async () => {
      await Bun.sleep(1);
      return deadlineFor(9);
    }),
  ]);
  expect([first, second]).toEqual([1_000, 2_000]);
});

test('a later HTTP request starts a fresh envelope instead of a leaked ALS deadline', async () => {
  const leaked = Date.now() + 25;
  const before = Date.now();
  const seen = await withRequestDeadline(leaked, async () => {
    const response = await app.handle(new Request('http://kernel.test/v1/deadline'));
    expect(response.status).toBe(200);
    return (await response.json()) as Seen;
  });
  expect(seen.job).toBeGreaterThan(leaked);
  expect(seen.job).toBeGreaterThanOrEqual(before + 1_234);
  expect(seen.scoped).toBe(seen.job);
});

test('outside a request a deadline is now plus the budget', () => {
  const before = Date.now();
  const deadline = deadlineFor(5_000);
  expect(deadline).toBeGreaterThanOrEqual(before + 5_000);
  expect(deadline).toBeLessThanOrEqual(Date.now() + 5_000);
  expect(() => deadlineFor(0)).toThrow();
  expect(() => deadlineFor(Number.NaN)).toThrow();
});
