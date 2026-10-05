import { expect, spyOn, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { meterStatements } from '../feed-read-support.ts';
import { runBackgroundOperation } from './operation-cost.ts';

test('SQL statements and async commit probes exclude overlapping background transactions', async () => {
  const native = spyOn(pg.Client.prototype, 'query').mockImplementation((async () => {
    await delay(1);
    return { rows: [{ writes: 0 }] };
  }) as typeof pg.Client.prototype.query);
  const meter = meterStatements();
  const foreground = new pg.Client();
  const background = new pg.Client();
  const transaction = async (client: pg.Client, end = 'COMMIT') => {
    await client.query('BEGIN; SET LOCAL synchronous_commit = off');
    await delay(1);
    await client.query('SELECT 1');
    await client.query(end);
  };
  try {
    await Promise.all([
      transaction(foreground),
      runBackgroundOperation(() => transaction(background)),
    ]);
    expect(meter.count()).toBe(3);
    expect(meter.asyncCommits()).toBe(1);
    // Both transactions run all statements and both probes; attribution only
    // changes the cost counters, never the asynchronous write-safety checks.
    expect(native).toHaveBeenCalledTimes(10);
    expect(meter.violations).toEqual([]);

    await transaction(foreground, 'ROLLBACK');
    expect(meter.count()).toBe(6);
    expect(meter.asyncCommits()).toBe(1);

    await runBackgroundOperation(async () => {
      await background.query('BEGIN; SET LOCAL synchronous_commit = off');
      await background.query('UPDATE access.fixture SET value = 1');
      await background.query('COMMIT');
    });
    expect(meter.count()).toBe(6);
    expect(meter.asyncCommits()).toBe(1);
    expect(meter.violations).toHaveLength(1);
    expect(meter.violations[0]).toContain('UPDATE access.fixture');
  } finally {
    meter.restore();
    native.mockRestore();
  }
});
