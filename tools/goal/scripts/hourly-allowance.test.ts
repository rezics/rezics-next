import { expect, test } from 'bun:test';
import type { Pool, PoolReading } from '../src/types.ts';
import { hourlyAllowance } from './hourly-allowance.ts';

test('hourly duty compares fresh observations only within the same account and weekly reset window', () => {
  const now = Date.parse('2026-11-10T21:04:00Z');
  const reset = Date.parse('2026-11-11T15:31:14Z');
  const pool = { allowanceKey: 'codex', cli: 'codex' } as Pool;
  const reading = (usedPercent: number, elapsed: number, resetsAt = reset, allowanceKey = 'codex') =>
    ({
      allowanceKey,
      observedAt: new Date(now - elapsed * 60_000).toISOString(),
      windows: [{ window: 'primary', usedPercent, resetsAt, minutes: 10080 }],
    }) as PoolReading;
  const unrelated = [reading(56, 60, reset + 604_800_000), reading(56, 60, reset, 'codex-1')];
  expect(hourlyAllowance(pool, reading(82, 0), unrelated, now)).toEqual({
    used: 82,
    rate: null,
    observedRate: null,
    evidence: 'none',
  });
  expect(hourlyAllowance(pool, reading(82, 0), [...unrelated, reading(82, 63)], now)).toEqual({
    used: 82,
    rate: null,
    observedRate: 0,
    evidence: 'unresolved',
  });
  expect(hourlyAllowance(pool, reading(82, 0), [reading(80, 60)], now)).toEqual({
    used: 82,
    rate: 1,
    observedRate: 2,
    evidence: 'rate',
  });
  expect(hourlyAllowance(pool, reading(82, 16), [], now)).toEqual({
    used: null,
    rate: null,
    observedRate: null,
    evidence: 'none',
  });
});

test('hourly bridge leaves a 12 to 13 integer step and a later plateau unresolved so a 0.74 ceiling does not alarm', () => {
  const now = Date.parse('2026-11-10T21:04:00Z');
  const reset = Date.parse('2026-11-11T15:31:14Z');
  const pool = { allowanceKey: 'codex', cli: 'codex' } as Pool;
  const reading = (usedPercent: number, elapsed: number) =>
    ({
      allowanceKey: 'codex',
      observedAt: new Date(now - elapsed * 60_000).toISOString(),
      windows: [{ window: 'primary', usedPercent, resetsAt: reset, minutes: 10080 }],
    }) as PoolReading;
  const step = hourlyAllowance(pool, reading(13, 0), [reading(12, 60 / 0.991)], now);
  expect(step.used).toBe(13);
  expect(step.rate).toBeNull();
  expect(step.evidence).toBe('unresolved');
  expect(step.observedRate).toBeCloseTo(0.991, 3);
  const plateau = hourlyAllowance(pool, reading(13, 0), [reading(13, 60)], now);
  expect(plateau).toMatchObject({ used: 13, rate: null, observedRate: 0, evidence: 'unresolved' });
  const fractional = hourlyAllowance(
    { ...pool, cli: 'codex' },
    reading(12.6, 0),
    [
      {
        allowanceKey: 'codex',
        observedAt: new Date(now - 60 * 60_000).toISOString(),
        windows: [{ window: 'primary', usedPercent: 12.2, resetsAt: reset, minutes: 10080 }],
      } as PoolReading,
    ],
    now,
  );
  expect(fractional.used).toBe(12.6);
  expect(fractional.evidence).toBe('rate');
  expect(fractional.rate).toBeCloseTo(0.4, 5);
});
