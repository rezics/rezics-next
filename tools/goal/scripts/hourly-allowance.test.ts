import { expect, test } from 'bun:test';
import type { Pool, PoolReading } from '../src/types.ts';
import { hourlyAllowance, hourlyAllowanceReport } from './hourly-allowance.ts';

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
    {
      allowanceKey: 'codex',
      observedAt: new Date(now).toISOString(),
      windows: [{ window: 'primary', usedPercent: 12.6, resetsAt: reset, minutes: 10080 }],
    } as PoolReading,
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

const reportNow = Date.parse('2026-11-10T21:04:00Z');
const minute = 60_000;
const hour = 60 * minute;
const pool = (name: string, allowanceKey = name, cli: Pool['cli'] = 'codex', maxAgeMs = hour, usageFile?: string) =>
  ({ name, allowanceKey, cli, usageFile, policy: { maxAgeMs, maxBurnPerHour: 0.74 } }) as Pool;
const reportReading = (
  name: string,
  allowanceKey: string,
  observed: number | null,
  windows: PoolReading['windows'],
): PoolReading => ({
  pool: name,
  allowanceKey,
  at: new Date(reportNow).toISOString(),
  observedAt: observed === null ? null : new Date(observed).toISOString(),
  windows,
  exhausted: windows.some((window) => window.usedPercent >= 100),
  error: windows.length ? null : 'quota observation unavailable',
});

test('reports exact weekly and short-window resets with freshness and remaining time', () => {
  const reset = Date.parse('2026-11-11T15:31:14Z');
  const shortReset = reportNow + 90 * minute;
  const current = reportReading('codex', 'codex', reportNow - minute, [
    { window: 'primary', usedPercent: 42, resetsAt: reset, minutes: 10080 },
    { window: 'secondary', usedPercent: 18, resetsAt: shortReset, minutes: 300 },
  ]);
  const report = hourlyAllowanceReport([pool('codex')], [], reportNow, () => current);
  expect(report.codex).toMatchObject({
    used: 42,
    rate: null,
    observedRate: null,
    evidence: 'none',
    allowanceKey: 'codex',
    sharedPools: ['codex'],
    freshness: { status: 'fresh', observedAt: current.observedAt, ageMs: minute, maxAgeMs: hour },
    windows: [
      {
        identity: { window: 'primary', minutes: 10080, resetsAt: reset },
        usedPercent: 42,
        resetStatus: 'scheduled',
        remainingMs: reset - reportNow,
      },
      {
        identity: { window: 'secondary', minutes: 300, resetsAt: shortReset },
        usedPercent: 18,
        resetStatus: 'scheduled',
        remainingMs: 90 * minute,
      },
    ],
    ceiling: 0.74,
  });
});

test('shares one source read and exposes fresh retained, stale and expired allowance evidence', () => {
  const codex = pool('codex', 'shared', 'codex', 5 * minute);
  const grok = pool('grok', 'shared', 'grok', 2 * hour, '/private/grok-usage.json');
  const stale = reportReading('grok', 'shared', reportNow - 2 * hour, [
    { window: 'seven_day', usedPercent: 100, resetsAt: reportNow - hour, minutes: 10080 },
    { window: 'five_hour', usedPercent: 40, resetsAt: reportNow + hour, minutes: 300 },
  ]);
  const calls: string[] = [];
  const report = hourlyAllowanceReport([codex, grok], [], reportNow, (source) => {
    calls.push(source.name);
    return stale;
  });
  const codexStatus = report.codex!;
  const grokStatus = report.grok!;
  expect(calls).toEqual(['grok']);
  expect(codexStatus.sharedPools).toEqual(['codex', 'grok']);
  expect(grokStatus.windows).toEqual(codexStatus.windows);
  expect(codexStatus.freshness.status).toBe('stale');
  expect(grokStatus.freshness.status).toBe('fresh');
  expect(codexStatus.used).toBeNull();
  expect(codexStatus.windows[0]).toMatchObject({ resetStatus: 'expired', remainingMs: -hour });
  const retained = { ...stale, observedAt: new Date(reportNow - minute).toISOString() };
  const retainedReport = hourlyAllowanceReport([codex, grok], [retained], reportNow, () => {
    throw new Error('unexpected source read');
  });
  expect(retainedReport.grok!.freshness.status).toBe('fresh');
});

test('reports unavailable provider windows without inventing a reset or usage', () => {
  const unavailable = reportReading('grok', 'grok', null, []);
  const report = hourlyAllowanceReport([pool('grok', 'grok', 'grok')], [], reportNow, () => unavailable);
  expect(report.grok).toMatchObject({
    used: null,
    rate: null,
    observedRate: null,
    evidence: 'none',
    freshness: { status: 'unavailable', observedAt: null, ageMs: null },
    windowStatus: 'unavailable',
    windows: [],
    ceiling: 0.74,
  });
});
