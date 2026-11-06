import { expect, test } from 'bun:test';
import { burnPerHour, choosePoolWithFallback, poolBurnStatus } from './allowance.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

const minute = 60_000;
const hour = 3_600_000;
const span = 90 * minute;
const now = Date.parse('2026-11-06T04:08:12.528Z');
const resetAt = Date.parse('2026-11-09T15:00:00.000Z');
const claudeWorker: Pool = {
  name: 'claude-worker',
  cli: 'claude',
  classes: ['claude'],
  configDirectory: '/fixture/claude',
  command: 'claude',
  allowanceKey: 'claude',
  policy: { weight: 1, reservePercent: 25, allowUnknown: false, maxAgeMs: 21_600_000, maxBurnPerHour: 0.8 },
};
const haiku: Profile = { cli: 'claude', model: 'claude-haiku-5-5', effort: 'high', poolClass: 'claude' };

/** One reading of the shared Claude allowance's window, as the probe records it. */
function weekly(usedPercent: number, at: number, resetsAt = resetAt, minutes = 10080): PoolReading {
  const observedAt = new Date(at).toISOString();
  return {
    pool: claudeWorker.name,
    allowanceKey: 'claude',
    at: observedAt,
    observedAt,
    windows: [{ usedPercent, resetsAt, minutes }],
    exhausted: false,
    error: null,
  };
}

test('Claude weekly usage rising 34% to 37% over 90 minutes burns 2 per hour, even when reset stamps drift', () => {
  const exact = [weekly(34, now - span), weekly(35, now - 60 * minute), weekly(36, now - 30 * minute)];
  expect(burnPerHour(weekly(37, now), exact, { now, spanMs: span })).toBeCloseTo(2, 9);
  const drifting = [
    weekly(34, now - span, resetAt + 1_400),
    weekly(35, now - 60 * minute, resetAt - 1_000),
    weekly(36, now - 30 * minute, resetAt + 7),
  ];
  expect(burnPerHour(weekly(37, now, resetAt + 800), drifting, { now, spanMs: span })).toBeCloseTo(2, 9);
});

test('Reset stamps pair within 60 seconds of the same length; a real reset or another length is not burn', () => {
  const beforeReset = [weekly(90, now - 30 * minute, resetAt - 7 * 24 * hour)];
  expect(burnPerHour(weekly(5, now), beforeReset, { now, spanMs: span })).toBe(0);
  const start = [weekly(34, now - span)];
  expect(burnPerHour(weekly(37, now, resetAt + 61_000), start, { now, spanMs: span })).toBe(0);
  expect(burnPerHour(weekly(37, now, resetAt + 60_000), start, { now, spanMs: span })).toBeCloseTo(2, 9);
  expect(burnPerHour(weekly(37, now, resetAt, 300), start, { now, spanMs: span })).toBe(0);
});

test('status shows claude-worker burning 2 per hour; its 0.8 ceiling holds Haiku starts while exceeded', () => {
  const series = [
    weekly(34, now - span, resetAt + 1_400),
    weekly(35, now - 60 * minute, resetAt - 1_000),
    weekly(36, now - 30 * minute, resetAt + 7),
    weekly(37, now, resetAt + 800),
  ];
  expect(poolBurnStatus([claudeWorker], series, now, span)).toEqual([
    { name: 'claude-worker', allowanceKey: 'claude', burnPerHour: 2, maxBurnPerHour: 0.8 },
  ]);
  const options = { now, history: series, spanMs: span };
  expect(() => choosePoolWithFallback(haiku, [], [claudeWorker], series, options)).toThrow('no allowed pool');
  const flat = [weekly(37, now - span, resetAt + 1_400), weekly(37, now, resetAt + 800)];
  const admitted = choosePoolWithFallback(haiku, [], [claudeWorker], flat, { now, history: flat, spanMs: span });
  expect(admitted.pool.name).toBe('claude-worker');
});
