import { expect, spyOn, test } from 'bun:test';
import type { Effect } from '../../src/events/effects.ts';
import type { WorkContext, WorkService } from '../../src/work/registry.ts';
import { newId } from '../../src/route/route.ts';
import {
  ACCOUNT_DISCOVERY_IDLE_MS as IDLE,
  ACCOUNT_DISCOVERY_START_DELAY_MS as START,
  ACCOUNT_DISCOVERY_STEP_MS as STEP,
  ACCOUNT_DISCOVERY_RETRY_MS as RETRY,
  ACCOUNT_DISCOVERY_MAX_RETRY_MS as MAX_RETRY,
  registerAccountDiscoveryWork,
  type AccountDiscoveryTimers,
} from '../../src/access/account-discovery-work.ts';

function fixture() {
  let now = 0;
  const scheduled = new Map<() => Promise<void>, number>();
  const time: AccountDiscoveryTimers = {
    now: () => now,
    schedule(run, delay) {
      scheduled.set(run, now + delay);
      return () => {
        scheduled.delete(run);
      };
    },
  };
  const homes: number[] = [];
  let statements = 0,
    held = 0,
    peak = 0,
    attempts = 0;
  let failure: Error | undefined;
  let beforeQuery: (() => Promise<void>) | undefined;
  const pool = {
    options: { max: 10 },
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    async connect() {
      attempts++;
      if (failure) throw failure;
      peak = Math.max(peak, ++held);
      return {
        async query(sql: string, args: number[] = []) {
          await beforeQuery?.();
          statements++;
          if (sql.includes('account_discovery_claim_intent')) homes.push(args[0]! / 16);
          const rows = sql.includes('SELECT epoch,write_state')
            ? [{ epoch: 1, write_state: 'active' }]
            : sql.includes('SELECT enrollment_generation')
              ? [{ enrollment_generation: '1' }]
              : [];
          return { rows, rowCount: rows.length };
        },
        release() {
          held--;
        },
      };
    },
  };
  let effects: Effect[] = [];
  let start!: () => WorkService | Promise<WorkService>;
  registerAccountDiscoveryWork(
    {
      pool,
      clock: () => new Date(now),
      addEffects(value: Effect[]) {
        effects = value;
      },
      addService(value: typeof start) {
        start = value;
      },
    } as unknown as WorkContext,
    time,
  );
  return {
    pool,
    homes,
    start: () => start(),
    stats: () => ({ statements, held, peak, attempts }),
    fail: (error?: Error) => {
      failure = error;
    },
    pause: (run?: () => Promise<void>) => {
      beforeQuery = run;
    },
    wake: (home = 37) => effects[0]!.run({ data: { accountId: newId(home * 16) } } as Parameters<Effect['run']>[0]),
    next: () => Math.min(...scheduled.values()),
    async advance(ms: number) {
      const end = now + ms;
      while (scheduled.size) {
        const [run, at] = [...scheduled.entries()].sort((a, b) => a[1] - b[1])[0]!;
        if (at > end) break;
        now = at;
        scheduled.delete(run);
        await run();
      }
      now = end;
    },
  };
}

test('empty full pass idles, source events wake one home, and bounded recovery resumes', async () => {
  const f = fixture();
  expect(f.stats().attempts).toBe(0);
  const service = await f.start();
  await f.wake(); // Even a boot-time event respects the startup grace.
  await f.advance(START - 1);
  expect(f.stats().attempts).toBe(0);
  await f.advance(1 + 4096 * STEP);
  expect(f.homes).toEqual([37, ...Array.from({ length: 4096 }, (_, i) => i)]);
  expect(f.stats().statements).toBe(4097 * 9);
  await f.advance(IDLE - STEP);
  expect(f.homes.length).toBe(4097);
  await Promise.all([f.wake(), f.wake()]);
  await f.advance(0);
  expect(f.homes.slice(-1)).toEqual([37]);
  await f.advance(STEP);
  expect(f.homes.slice(-2)).toEqual([37, 0]);
  await service.stop();
  expect(f.next()).toBe(Infinity);
});

test('pool pressure yields without checkout and events share one serial connection', async () => {
  const f = fixture(),
    service = await f.start();
  f.pool.totalCount = 9;
  await f.advance(START);
  expect(f.stats().attempts).toBe(0);
  f.pool.idleCount = 1;
  f.pool.waitingCount = 1;
  await f.wake();
  await f.advance(RETRY);
  expect(f.stats().attempts).toBe(0);
  f.pool.waitingCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.pause(() => gate);
  const inFlight = f.advance(RETRY);
  await Promise.resolve();
  await f.wake();
  let stopped = false;
  const stop = service.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await Promise.all([inFlight, stop]);
  expect(f.stats()).toMatchObject({ peak: 1, held: 0 });
  expect(f.next()).toBe(Infinity);
});

test.each([
  new Error('timeout exceeded when trying to connect'),
  Object.assign(new Error('connection lost'), { code: '08006' }),
  Object.assign(new Error('too many connections'), { code: '53300' }),
  Object.assign(new Error('statement timeout'), { code: '57014' }),
])('unavailability backs off exponentially, wakeups cannot bypass it, success resets it: %s', async (error) => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture(),
    service = await f.start();
  try {
    f.fail(error);
    await f.advance(START);
    let delay = RETRY;
    for (let i = 0; i < 8; i++) {
      const attempts = f.stats().attempts;
      await f.wake(0);
      await f.advance(delay - 1);
      expect(f.stats().attempts).toBe(attempts);
      await f.advance(1);
      expect(f.stats().attempts).toBe(attempts + 1);
      delay = Math.min(delay * 2, MAX_RETRY);
    }
    f.fail();
    await f.advance(delay);
    expect(f.homes).toEqual([0]);
    f.fail(error);
    await f.advance(STEP);
    const next = f.next();
    await f.advance(RETRY - 1);
    expect(f.next()).toBe(next);
    await f.advance(1);
    expect(f.next()).toBe(next + 2 * RETRY);
  } finally {
    await service.stop();
    log.mockRestore();
  }
});

test('unexpected database defects escape instead of entering a retry loop', async () => {
  const f = fixture(),
    service = await f.start();
  const error = new Error('unexpected query defect');
  f.fail(error);
  await expect(f.advance(START)).rejects.toBe(error);
  expect(f.next()).toBe(Infinity);
  await expect(service.stop()).rejects.toBe(error);
});
