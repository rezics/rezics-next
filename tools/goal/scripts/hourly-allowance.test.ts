import { expect, test } from 'bun:test';
import type { Pool, PoolReading } from '../src/types.ts';
import { hourlyAllowance } from './hourly-allowance.ts';

test('hourly duty compares fresh observations only within the same account and weekly reset window', () => {
  const now = Date.parse('2026-11-10T21:04:00Z');
  const reset = Date.parse('2026-11-11T15:31:14Z');
  const pool = { allowanceKey: 'codex' } as Pool;
  const reading = (usedPercent: number, elapsed: number, resetsAt = reset, allowanceKey = 'codex') =>
    ({
      allowanceKey,
      observedAt: new Date(now - elapsed * 60_000).toISOString(),
      windows: [{ window: 'primary', usedPercent, resetsAt, minutes: 10080 }],
    }) as PoolReading;
  const unrelated = [reading(56, 60, reset + 604_800_000), reading(56, 60, reset, 'codex-1')];
  expect(hourlyAllowance(pool, reading(82, 0), unrelated, now)).toEqual({ used: 82, rate: null });
  expect(hourlyAllowance(pool, reading(82, 0), [...unrelated, reading(82, 63)], now)).toEqual({ used: 82, rate: 0 });
  expect(hourlyAllowance(pool, reading(82, 0), [reading(80, 60)], now)).toEqual({ used: 82, rate: 2 });
  expect(hourlyAllowance(pool, reading(82, 16), [], now)).toEqual({ used: null, rate: null });
});
