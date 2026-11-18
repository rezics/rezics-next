import { expect, spyOn, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import { withConnection } from '../../src/database/pool.ts';
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
      const timer = AsyncLocalStorage.bind(run);
      scheduled.set(timer, now + delay);
      return () => {
        scheduled.delete(timer);
      };
    },
  };
  const homes: number[] = [];
  const subjectHomes: number[] = [];
  const pendingCoverage = new Set<number>();
  const firstStatements: string[] = [];
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
      let coverageHome: number | undefined;
      return {
        async query(statement: string | { text: string; values?: number[] }, args: number[] = []) {
          const sql = typeof statement === 'string' ? statement : statement.text;
          if (typeof statement !== 'string') args = statement.values ?? [];
          statements++;
          if (firstStatements.length < 8) firstStatements.push(sql);
          if (sql.startsWith('SELECT route, account_id') && sql.includes('account_discovery_claim_intent'))
            homes.push(args[0]! / 16);
          if (sql.includes('AND input_key=$2') && String(args[1]) === '["scope","subject"]')
            subjectHomes.push(args[0]!);
          await beforeQuery?.();
          if (sql.includes('SELECT * FROM semantic.public_filter_privacy_pending')) coverageHome = args[0];
          if (sql === 'COMMIT' && coverageHome !== undefined) pendingCoverage.delete(coverageHome);
          if (sql.startsWith('SELECT partition_no FROM semantic.public_filter_privacy_pending')) {
            const next = [...pendingCoverage].filter((home) => home >= args[0]!).sort((a, b) => a - b)[0];
            return { rows: next === undefined ? [] : [{ partition_no: next }], rowCount: next === undefined ? 0 : 1 };
          }
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
    subjectHomes,
    firstStatements,
    pendingCoverage,
    start: () => start(),
    stats: () => ({ statements, held, peak, attempts }),
    fail: (error?: Error) => {
      failure = error;
    },
    pause: (run?: () => Promise<void>) => {
      beforeQuery = run;
    },
    wake: (home = 37) => effects[0]!.run({ data: { accountId: newId(home * 16) } } as Parameters<Effect['run']>[0]),
    admitVisibility: (home: number, visibility: 'hidden' | 'visible') =>
      withConnection(pool as unknown as Pool, (client) =>
        effects[0]!.admit!(client, {
          type: 'com.rezics.subject.visibility_changed.v1',
          data: { id: newId(home * 16), visibility },
        } as Parameters<Effect['run']>[0]),
      ),
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

test('empty indexed recovery idles, source wakes one home, and a missed wake at the last home is recovered', async () => {
  const f = fixture();
  expect(f.stats().attempts).toBe(0);
  const service = await f.start();
  await f.wake(); // Even a boot-time event respects the startup grace.
  await f.advance(START - 1);
  expect(f.stats().attempts).toBe(0);
  await f.advance(1 + STEP);
  expect(f.homes).toEqual([37]);
  expect(f.stats().statements).toBe(10);
  expect(f.firstStatements.map((sql) => sql.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
    'SELECT route,',
    'SELECT route,',
    'BEGIN',
    'SET LOCAL',
    'SELECT epoch,write_state',
    'SELECT enrollment_generation::text',
    'SELECT *',
    'COMMIT',
  ]);
  await f.advance(IDLE - STEP);
  expect(f.homes).toEqual([37]);
  await f.admitVisibility(42, 'visible');
  await f.advance(0);
  expect(f.homes).toEqual([37]);
  await Promise.all([f.admitVisibility(42, 'hidden'), f.admitVisibility(42, 'hidden')]);
  await f.advance(0);
  expect(f.subjectHomes).toEqual([42]);
  f.pendingCoverage.add(4095);
  await f.advance(STEP);
  expect(f.homes).toEqual([37, 4095]);
  expect(f.pendingCoverage.size).toBe(0);
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
  // The public reads waiting for Subject coverage cannot release their own barrier.
  await f.admitVisibility(42, 'hidden');
  await f.advance(RETRY);
  expect(f.subjectHomes).toEqual([42]);
  expect(f.homes).toEqual([]);
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
    await f.wake(0);
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

test.each([new Error('private query and Account data'), new TypeError('unexpected driver defect'), null])(
  'unexpected query faults retain the original wake home and recover with bounded delay: %s',
  async (error) => {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture(),
      service = await f.start();
    try {
      await f.wake(37);
      f.pause(async () => {
        throw error;
      });
      await f.advance(START);
      let delay = RETRY;
      for (let i = 0; i < 8; i++) {
        const attempts = f.stats().attempts;
        await Promise.all([f.wake(38), f.wake(38)]);
        await f.advance(delay - 1);
        expect(f.stats().attempts).toBe(attempts);
        await f.advance(1);
        expect(f.stats().attempts).toBe(attempts + 1);
        delay = Math.min(delay * 2, MAX_RETRY);
      }
      expect(new Set(f.homes)).toEqual(new Set([37]));
      expect(log.mock.calls[0]).toEqual([
        'Account discovery redrive failed',
        { home: 37, source: 'wake', reason: 'unexpected', retryInMs: RETRY },
      ]);
      expect(log.mock.calls.at(-1)?.[1]).toMatchObject({ retryInMs: MAX_RETRY });
      f.pause();
      await f.advance(delay + 2 * STEP);
      expect(f.homes.slice(-2)).toEqual([37, 38]);
      expect(f.stats()).toMatchObject({ peak: 1, held: 0 });
      await f.wake(39);
      const resumedAt = f.next();
      f.pause(async () => {
        throw error;
      });
      await f.advance(STEP);
      expect(f.next()).toBe(resumedAt + RETRY);
    } finally {
      await service.stop();
      log.mockRestore();
    }
    expect(f.next()).toBe(Infinity);
  },
);

test('stop drains a failing query and cancels its pending recovery', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture(),
    service = await f.start();
  try {
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_, fail) => {
      reject = fail;
    });
    f.pause(() => gate);
    const inFlight = f.advance(START);
    await Promise.resolve();
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    reject(new Error('query failed during shutdown'));
    await Promise.all([inFlight, stopping]);
    const attempts = f.stats().attempts;
    await f.wake();
    await f.advance(MAX_RETRY);
    expect(f.stats()).toMatchObject({ attempts, peak: 1, held: 0 });
    expect(f.next()).toBe(Infinity);
  } finally {
    await service.stop();
    log.mockRestore();
  }
});
