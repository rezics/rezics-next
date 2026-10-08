import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import {
  boundedPool, CONNECTION_BOUNDS, CONNECTION_CHECKOUT_WAIT_MS, connectionBoundOptions,
  NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedCheckoutReportClock,
  setNestedPoolCheckoutMode,
} from './pg-pool.ts';

const repositoryRoot = resolve(import.meta.dir, '../../../..');
const querySecret = "SELECT 'nested_checkout_secret_value'";

function sourceLine(origin: string): string {
  const match = /^(.+):(\d+)(?: \S+)?$/.exec(origin);
  if (!match?.[1] || !match[2]) throw new Error(`not a checkout origin: ${origin}`);
  return readFileSync(resolve(repositoryRoot, match[1]), 'utf8').split('\n')[Number(match[2]) - 1] ?? '';
}

function expectBounded(error: NestedPoolCheckoutError): void {
  expect(error.outers.length).toBeLessThanOrEqual(3);
  for (const field of [error.inner, ...error.outers, error.pool ?? '']) {
    expect(field.length).toBeLessThanOrEqual(200);
  }
}

function idleClient(): PoolClient {
  const client = {
    release() {},
    query(_text: string, values?: unknown, done?: (error: Error | undefined, result?: { rows: unknown[] }) => void) {
      const callback = typeof values === 'function'
        ? values as (error: Error | undefined, result?: { rows: unknown[] }) => void
        : done;
      callback?.(undefined, { rows: [] });
    },
    on() { return client; },
    once() { return client; },
    removeListener() { return client; },
  };
  return client as unknown as PoolClient;
}

async function withMockedPool<T>(
  config: PoolConfig, work: (pool: Pool) => Promise<T>,
): Promise<T> {
  const connect = spyOn(Pool.prototype, 'connect').mockImplementation(
    ((callback?: unknown) => {
      const client = idleClient();
      if (typeof callback === 'function') {
        (callback as (error: undefined, client: PoolClient, done: () => void) => void)(undefined, client, () => undefined);
        return;
      }
      return Promise.resolve(client);
    }) as Pool['connect'],
  );
  const pool = boundedPool({ max: 4, connectionTimeoutMillis: 50, ...config });
  try { return await work(pool); }
  finally {
    connect.mockRestore();
    await pool.end();
  }
}

async function captureErrors(work: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try { await work(); }
  finally { console.error = original; }
  return logged;
}

test('the bounds are startup options applied before the caller options', () => {
  expect(connectionBoundOptions()).toBe(
    `-c lock_timeout=${CONNECTION_BOUNDS.lockTimeout}`
    + ` -c idle_in_transaction_session_timeout=${CONNECTION_BOUNDS.idleInTransactionSessionTimeout}`
    + ` -c transaction_timeout=${CONNECTION_BOUNDS.transactionTimeout}`);
  expect(connectionBoundOptions('-c default_transaction_read_only=on'))
    .toEndWith(' -c default_transaction_read_only=on');
});

test('a bounded pool keeps the caller settings and its own client error listener', async () => {
  const pool = boundedPool({ connectionString: 'postgres://u@127.0.0.1:1/d', max: 2,
    options: '-c default_transaction_read_only=on' });
  try {
    expect(pool.options.max).toBe(2);
    expect(pool.options.connectionTimeoutMillis).toBe(CONNECTION_CHECKOUT_WAIT_MS);
    expect(pool.options.options).toContain('-c lock_timeout=');
    expect(pool.options.options).toContain('-c default_transaction_read_only=on');
    expect(pool.listenerCount('error')).toBe(1);
    expect(pool.listenerCount('connect')).toBe(1);
  } finally { await pool.end(); }
});

test('the idle-in-transaction bound outlasts the longest request-path wait', () => {
  // A graph command is cut at 12 s and a catalogue batch at 35 s while a
  // transaction idles; the lock wait must stay under the Content fence's 15 s.
  const seconds = (value: string) => value.endsWith('min') ? Number.parseInt(value) * 60 : Number.parseInt(value);
  expect(seconds(CONNECTION_BOUNDS.idleInTransactionSessionTimeout)).toBeGreaterThan(35);
  expect(seconds(CONNECTION_BOUNDS.lockTimeout)).toBeGreaterThan(2);
  expect(seconds(CONNECTION_BOUNDS.lockTimeout)).toBeLessThan(15);
  expect(seconds(CONNECTION_BOUNDS.transactionTimeout))
    .toBeGreaterThan(seconds(CONNECTION_BOUNDS.idleInTransactionSessionTimeout));
});

test('a caller checkout wait is kept and a non-positive wait cannot wait forever', async () => {
  const chosen = boundedPool({ connectionString: 'postgres://u@127.0.0.1:1/d', max: 1, connectionTimeoutMillis: 250 });
  const forever = boundedPool({ connectionString: 'postgres://u@127.0.0.1:1/d', max: 1, connectionTimeoutMillis: 0 });
  try {
    expect(chosen.options.connectionTimeoutMillis).toBe(250);
    expect(forever.options.connectionTimeoutMillis).toBe(CONNECTION_CHECKOUT_WAIT_MS);
  } finally {
    await chosen.end();
    await forever.end();
  }
});

test('a second checkout of a held pool is reported and a finished checkout is not', async () => {
  const previous = nestedPoolCheckoutMode();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  const refused = { connectionString: 'postgres://u@127.0.0.1:1/none', max: 2, connectionTimeoutMillis: 200 };
  const callbackPool = boundedPool(refused);
  const throwPool = boundedPool(refused);
  const logPool = boundedPool(refused);
  try {
    expect(previous).toBe(process.env.REZICS_NESTED_POOL_CHECKOUT === 'throw' ? 'throw' : 'log');
    setNestedPoolCheckoutMode('throw');
    callbackPool.connect(() => undefined);
    const afterCallback = await callbackPool.connect().then(() => undefined, (error: unknown) => error);
    expect(afterCallback).not.toBeInstanceOf(NestedPoolCheckoutError);
    const cleared = await throwPool.connect().then(() => undefined, (error: unknown) => error);
    expect(cleared).not.toBeInstanceOf(NestedPoolCheckoutError);
    const afterFailure = await throwPool.connect().then(() => undefined, (error: unknown) => error);
    expect(afterFailure).not.toBeInstanceOf(NestedPoolCheckoutError);

    const held = throwPool.connect();
    await expect(throwPool.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    await expect(throwPool.query('SELECT 1')).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    expect(logged.some(item => JSON.parse(item)['error.class'] === 'NestedPoolCheckoutError')).toBe(false);
    await held.catch(() => undefined);

    setNestedPoolCheckoutMode('log');
    const first = logPool.connect(); // log-outer
    const second = logPool.connect(); // log-inner
    const faults = logged.map(item => JSON.parse(item) as Record<string, unknown>);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      level: 'error', event: 'worker_fault',
      'rezics.worker.name': 'main.database.nested-checkout',
      'error.class': 'NestedPoolCheckoutError',
    });
    const outers = faults[0]?.['rezics.checkout.outer'];
    const inner = faults[0]?.['rezics.checkout.inner'];
    expect(Array.isArray(outers)).toBe(true);
    expect(sourceLine(String((outers as string[])[0]))).toContain('log-outer');
    expect(sourceLine(String(inner))).toContain('log-inner');
    expect(JSON.stringify(faults[0])).not.toContain('SELECT');
    const loggedError = await second.then(() => undefined, (error: unknown) => error);
    expect(loggedError).not.toBeInstanceOf(NestedPoolCheckoutError);
    await first.catch(() => undefined);
  } finally {
    console.error = original;
    setNestedPoolCheckoutMode(previous);
    await Promise.all([callbackPool.end(), throwPool.end(), logPool.end()]);
  }
});

test('nested checkout fields stay inside their bounds and reject query text', () => {
  const longName = 'n'.repeat(250);
  const error = new NestedPoolCheckoutError({
    outers: [
      `services/main/src/caller.ts:10 ${longName}`,
      'services/main/src/caller.ts:11',
      'services/main/src/caller.ts:12',
      'services/main/src/caller.ts:13',
    ],
    inner: querySecret,
    pool: 'postgres://account_user:super-secret-password@127.0.0.1/access_pool',
  });
  expect(error.outers).toEqual([
    'services/main/src/caller.ts:10',
    'services/main/src/caller.ts:11',
    'services/main/src/caller.ts:12',
  ]);
  expect(error.inner).toBe('unknown');
  expect(error.pool).toBeUndefined();
  expectBounded(error);
  const rendered = JSON.stringify(error);
  expect(rendered).not.toContain('nested_checkout_secret_value');
  expect(rendered).not.toContain('super-secret-password');
  expect(rendered).not.toContain('SELECT');
});

test('a nested checkout names the outer and inner call sites and omits the query', async () => {
  const previous = nestedPoolCheckoutMode();
  setNestedCheckoutReportClock();
  setNestedPoolCheckoutMode('throw');
  try {
    await withMockedPool({
      connectionString: 'postgres://account_user:super-secret-password@127.0.0.1:9/access_pool?sslmode=require',
    }, async (pool) => {
      const held = await pool.connect(); // site-outer
      const thrown = await pool.query(querySecret).then(() => undefined, (error: unknown) => error);
      const logged = await captureErrors(async () => {
        setNestedPoolCheckoutMode('log');
        await pool.query(`dbname=keyword_pool ${querySecret}`); // site-log-query
      });
      expect(thrown).toBeInstanceOf(NestedPoolCheckoutError);
      const fault = thrown as NestedPoolCheckoutError;
      expectBounded(fault);
      expect(fault.outers[0]).toMatch(/pg-pool\.test\.ts:\d+(?: \S+)?$/);
      expect(fault.inner).toMatch(/pg-pool\.test\.ts:\d+(?: \S+)?$/);
      expect(sourceLine(fault.outers[0]!).includes('site-outer')).toBe(true);
      expect(sourceLine(fault.inner).includes('pool.query(querySecret)')).toBe(true);
      expect(fault.pool).toBe('access_pool');
      expect(fault.repeats).toBeUndefined();
      const rendered = JSON.stringify(fault);
      expect(rendered).not.toContain('nested_checkout_secret_value');
      expect(rendered).not.toContain('super-secret-password');
      expect(rendered).not.toContain('account_user');
      expect(rendered).not.toContain('127.0.0.1');
      expect(rendered).not.toContain('SELECT');
      expect(logged).toHaveLength(1);
      const line = logged[0]!;
      const reported = JSON.parse(line) as Record<string, unknown>;
      expect(sourceLine(String(reported['rezics.checkout.inner']))).toContain('site-log-query');
      expect(line).not.toContain('nested_checkout_secret_value');
      expect(line).not.toContain('super-secret-password');
      expect(line).not.toContain('keyword_pool');
      expect(line).not.toContain('SELECT');
      held.release();
    });
    setNestedPoolCheckoutMode('throw');
    await withMockedPool({
      connectionString: 'host=127.0.0.1 dbname=relay_pool user=account_user password=super-secret-password',
    }, async (pool) => {
      const held = await pool.connect();
      const thrown = await pool.connect().then(() => undefined, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(NestedPoolCheckoutError);
      expect((thrown as NestedPoolCheckoutError).pool).toBe('relay_pool');
      expect(JSON.stringify(thrown)).not.toContain('super-secret-password');
      held.release();
    });
  } finally {
    setNestedPoolCheckoutMode(previous);
    setNestedCheckoutReportClock();
  }
});

test('the same outer and inner pair is logged in full at most once a minute', async () => {
  const previous = nestedPoolCheckoutMode();
  let now = 1_700_000_000_000;
  setNestedCheckoutReportClock(() => now);
  setNestedPoolCheckoutMode('log');
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await withMockedPool({}, async (pool) => {
      const outer = await pool.connect(); // repeat-outer
      try {
        await repeatInner(pool);
        await repeatInner(pool);
        await repeatInner(pool);
        now += 59_999;
        await repeatInner(pool);
        const during = lines.map(item => JSON.parse(item) as Record<string, unknown>);
        expect(during).toHaveLength(1);
        expect(during[0]?.['rezics.checkout.repeats']).toBeUndefined();
        expect(sourceLine(String((during[0]?.['rezics.checkout.outer'] as string[])[0]))).toContain('repeat-outer');
        expect(sourceLine(String(during[0]?.['rezics.checkout.inner']))).toContain('repeat-inner');
        now += 1;
        await repeatInner(pool);
        await otherInner(pool);
      } finally { outer.release(); }
    });
    const faults = lines.map(item => JSON.parse(item) as Record<string, unknown>);
    expect(faults).toHaveLength(3);
    expect(faults[1]?.['rezics.checkout.repeats']).toBe(3);
    expect(sourceLine(String(faults[1]?.['rezics.checkout.inner']))).toContain('repeat-inner');
    expect(sourceLine(String(faults[2]?.['rezics.checkout.inner']))).toContain('other-inner');
    expect(faults[2]?.['rezics.checkout.repeats']).toBeUndefined();
  } finally {
    console.error = original;
    setNestedPoolCheckoutMode(previous);
    setNestedCheckoutReportClock();
  }
});

async function repeatInner(pool: Pool): Promise<void> {
  const client = await pool.connect(); // repeat-inner
  client.release();
}

async function otherInner(pool: Pool): Promise<void> {
  const client = await pool.connect(); // other-inner
  client.release();
}

test('a checkout records its origin within a loose per-connect bound', async () => {
  const previous = nestedPoolCheckoutMode();
  setNestedPoolCheckoutMode('log');
  setNestedCheckoutReportClock();
  interface StackSite {
    getFileName(): string | null;
    getLineNumber(): number | null;
    getColumnNumber(): number | null;
    getFunctionName(): string | null;
  }
  const errorWithPrepare = Error as ErrorConstructor & {
    prepareStackTrace?: (error: Error, sites: StackSite[]) => unknown;
  };
  const previousPrepare = errorWithPrepare.prepareStackTrace;
  let formatted = 0;
  errorWithPrepare.prepareStackTrace = (_error, sites) => {
    formatted += 1;
    return sites.map(site => {
      const name = site.getFunctionName();
      const location = `${site.getFileName() ?? ''}:${site.getLineNumber() ?? 0}:${site.getColumnNumber() ?? 0}`;
      return name ? `    at ${name} (${location})` : `    at ${location}`;
    }).join('\n');
  };
  try {
    await withMockedPool({}, async (pool) => {
      for (let warm = 0; warm < 50; warm += 1) {
        const client = await pool.connect();
        client.release();
      }
      formatted = 0;
      const iterations = 400;
      const started = performance.now();
      for (let index = 0; index < iterations; index += 1) {
        const client = await pool.connect();
        client.release();
      }
      const perCall = (performance.now() - started) / iterations;
      expect(formatted).toBe(0);
      if (!(perCall < 1)) throw new Error(`checkout origin capture took ${perCall.toFixed(4)} ms per connect`);
      console.info(`nested checkout origin capture ${perCall.toFixed(4)} ms/connect`);
      const held = await pool.connect();
      formatted = 0;
      await captureErrors(async () => { await pool.connect(); }); // overhead-inner
      expect(formatted).toBeGreaterThan(0);
      held.release();
    });
  } finally {
    errorWithPrepare.prepareStackTrace = previousPrepare;
    setNestedPoolCheckoutMode(previous);
    setNestedCheckoutReportClock();
  }
});

test('the oldest three holders are named when more than three checkouts nest', async () => {
  const previous = nestedPoolCheckoutMode();
  setNestedCheckoutReportClock();
  setNestedPoolCheckoutMode('log');
  try {
    const logged = await captureErrors(() => withMockedPool({}, async (pool) => {
      const first = await pool.connect(); // holder-a
      const second = await pool.connect(); // holder-b
      const third = await pool.connect(); // holder-c
      const fourth = await pool.connect(); // holder-d
      const fifth = await pool.connect(); // holder-e
      first.release();
      second.release();
      third.release();
      fourth.release();
      fifth.release();
    }));
    const faults = logged.map(item => JSON.parse(item) as { 'rezics.checkout.outer': string[]; 'rezics.checkout.inner': string });
    const deepest = faults.find(fault => sourceLine(fault['rezics.checkout.inner']).includes('holder-e'));
    expect(deepest?.['rezics.checkout.outer'].map(sourceLine)).toEqual([
      expect.stringContaining('holder-a'),
      expect.stringContaining('holder-b'),
      expect.stringContaining('holder-c'),
    ]);
    for (const fault of faults) {
      expect(fault['rezics.checkout.outer'].length).toBeLessThanOrEqual(3);
      for (const field of [fault['rezics.checkout.inner'], ...fault['rezics.checkout.outer']]) {
        expect(field.length).toBeLessThanOrEqual(200);
      }
    }
  } finally {
    setNestedPoolCheckoutMode(previous);
    setNestedCheckoutReportClock();
  }
});
