import { expect, test } from 'bun:test';
import { boundedPool, CONNECTION_BOUNDS, connectionBoundOptions } from './pg-pool.ts';

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
