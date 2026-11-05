import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../src/database/pool.ts';
import { Admission, ADMISSION_LIMITS } from '../src/http/admission.ts';
import { createApp, REQUEST_DEADLINE_MS } from '../src/http/app.ts';
import { ProblemError } from '../src/http/problem.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}
const later = () => ({ deadline: Date.now() + 5000 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the limits follow doc 04 and the pool has room for every permit', () => {
  expect(ADMISSION_LIMITS).toEqual({ permits: 8, reserved: 2, queue: 32 });
  expect(pool.options.max).toBe(ADMISSION_LIMITS.permits + ADMISSION_LIMITS.reserved);
});

test('at most eight jobs run at once and waiters start in arrival order', async () => {
  const admission = new Admission();
  const blocker = gate();
  const order: number[] = [];
  const jobs = Array.from({ length: 11 }, (_, n) =>
    admission.run('normal', later(), async () => {
      order.push(n);
      if (n < 8) await blocker.opened;
      return n;
    }),
  );
  await settle();
  expect(admission.running).toEqual({ normal: 8, reserved: 0 });
  expect(admission.waiting).toBe(3);
  expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  blocker.open();
  expect(await Promise.all(jobs)).toEqual(Array.from({ length: 11 }, (_, n) => n));
  expect(order).toEqual(Array.from({ length: 11 }, (_, n) => n));
  expect(admission.running).toEqual({ normal: 0, reserved: 0 });
});

test('a full queue is refused at once as overloaded with Retry-After', async () => {
  const admission = new Admission();
  const blocker = gate();
  const held = Array.from({ length: 8 + 32 }, () => admission.run('normal', later(), () => blocker.opened));
  await settle();
  expect(admission.waiting).toBe(32);
  const started = Date.now();
  const refused = await admission.run('normal', later(), async () => 'ran').catch((error: unknown) => error);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(refused).toBeInstanceOf(ProblemError);
  expect(refused).toMatchObject({ code: 'overloaded', headers: { 'retry-after': '1' } });
  blocker.open();
  await Promise.all(held);
});

test('a waiter leaves the queue when its deadline passes or its client goes away', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 4 });
  const blocker = gate();
  const holder = admission.run('normal', later(), () => blocker.opened);
  let ran = false;
  const expired = admission
    .run('normal', { deadline: Date.now() + 40 }, async () => {
      ran = true;
    })
    .catch((error: unknown) => error);
  const client = new AbortController();
  const abandoned = admission
    .run('normal', { deadline: Date.now() + 5000, signal: client.signal }, async () => {
      ran = true;
    })
    .catch((error: unknown) => error);
  await settle();
  expect(admission.waiting).toBe(2);
  client.abort();
  expect(await abandoned).toMatchObject({ name: 'AbortError' });
  expect(admission.waiting).toBe(1);
  expect(await expired).toMatchObject({ code: 'overloaded' });
  expect(admission.waiting).toBe(0);
  const gone = new AbortController();
  gone.abort();
  expect(
    await admission.run('normal', { deadline: Date.now() + 5000, signal: gone.signal }, async () => 1).catch((e) => e),
  ).toMatchObject({ name: 'AbortError' });
  expect(await admission.run('normal', { deadline: Date.now() - 1 }, async () => 1).catch((e) => e)).toMatchObject({
    code: 'overloaded',
  });
  blocker.open();
  await holder;
  expect(ran).toBe(false);
  expect(admission.running).toEqual({ normal: 0, reserved: 0 });
});

test('a failed job gives its permit back', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 1 });
  const failure = new Error('job failed');
  expect(await admission.run('normal', later(), () => Promise.reject(failure)).catch((e) => e)).toBe(failure);
  expect(await admission.run('normal', later(), async () => 'next')).toBe('next');
  expect(admission.running).toEqual({ normal: 0, reserved: 0 });
});

test('health checks use the reserved permits while resource work is saturated', async () => {
  const admission = new Admission();
  const blocker = gate();
  const held = Array.from({ length: 8 + 32 }, () => admission.run('normal', later(), () => blocker.opened));
  await settle();
  const app = createApp({ pool, admission });
  const health = await app.handle(new Request('http://kernel.test/health'));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
  expect(admission.running.reserved).toBe(0);
  blocker.open();
  await Promise.all(held);
});

test('a request carries a deadline two seconds from its arrival and its client signal', async () => {
  expect(REQUEST_DEADLINE_MS()).toBe(2000);
  const seen: { deadline: number; aborted: boolean }[] = [];
  const app = createApp({ pool }).get('/probe/deadline', ({ job }) => {
    seen.push({ deadline: job.deadline, aborted: job.signal?.aborted ?? true });
    return { ok: true };
  });
  const before = Date.now();
  const response = await app.handle(new Request('http://kernel.test/probe/deadline'));
  const after = Date.now();
  expect(response.status).toBe(200);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.deadline).toBeGreaterThanOrEqual(before + 2000);
  expect(seen[0]!.deadline).toBeLessThanOrEqual(after + 2000);
  expect(seen[0]!.aborted).toBe(false);
});

test('an overloaded request is served as a problem document', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 0 });
  const blocker = gate();
  const holder = admission.run('normal', later(), () => blocker.opened);
  const app = createApp({ pool, admission }).get('/probe/work', ({ admission: lanes, job }) =>
    lanes.run('normal', job, async () => ({ ok: true })),
  );
  const response = await app.handle(new Request('http://kernel.test/probe/work'));
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('1');
  expect(await response.json()).toMatchObject({ code: 'overloaded', retryable: true, effect_status: 'not_applicable' });
  blocker.open();
  await holder;
});
