import { expect, test } from 'bun:test';
import {
  boundedPool, CONNECTION_BOUNDS, CONNECTION_CHECKOUT_WAIT_MS, connectionBoundOptions,
  NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode,
} from './pg-pool.ts';

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
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args[0]);
    if (args[0] instanceof NestedPoolCheckoutError || args[0] === 'Database connection failed:') return;
    original(...args);
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
    expect(logged.some(item => item instanceof NestedPoolCheckoutError)).toBe(false);
    await held.catch(() => undefined);

    setNestedPoolCheckoutMode('log');
    const first = logPool.connect();
    const second = logPool.connect();
    expect(logged.some(item => item instanceof NestedPoolCheckoutError)).toBe(true);
    const loggedError = await second.then(() => undefined, (error: unknown) => error);
    expect(loggedError).not.toBeInstanceOf(NestedPoolCheckoutError);
    await first.catch(() => undefined);
  } finally {
    console.error = original;
    setNestedPoolCheckoutMode(previous);
    await Promise.all([callbackPool.end(), throwPool.end(), logPool.end()]);
  }
});
