import { expect, test } from 'bun:test';
import {
  burnPerHour,
  choosePool,
  choosePoolWithFallback,
  countAllowanceWaiting,
  countRunningByPool,
  countWaitingByPool,
  managerWakePoolAllowed,
  PoolUnavailableError,
  poolAllowed,
  poolBurnStatus,
} from './allowance.ts';
import { fixturePool, reading } from './test-support.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

const hour = 3_600_000;
const span = 90 * 60 * 1000;
const now = Date.parse('2026-11-05T12:00:00.000Z');
const profile: Profile = { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' };
const cursorProfile: Profile = { cli: 'cursor', model: 'gpt-5.6-luna', effort: 'high', poolClass: 'cursor' };

test('only a configured but currently refused pool is a typed admission wait', () => {
  const pool = { ...fixturePool(), policy: { ...fixturePool().policy, allowUnknown: false } };
  let refused: unknown;
  try {
    choosePool(profile, [pool], [observed(pool, 100, now)], { now });
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(PoolUnavailableError);
  expect((refused as Error).message).toBe('no allowed pool available for codex/codex');

  let misconfigured: unknown;
  try {
    choosePool(profile, [{ ...pool, cli: 'cursor' as const, classes: ['cursor'] }], [], { now });
  } catch (error) {
    misconfigured = error;
  }
  expect(misconfigured).toBeInstanceOf(Error);
  expect(misconfigured).not.toBeInstanceOf(PoolUnavailableError);
  expect((misconfigured as Error).message).toBe('no allowed pool available for codex/codex');
});

function observed(pool: Pool, usedPercent: number, at: number, resetsAt = now + 8 * hour): PoolReading {
  const result = reading(pool, usedPercent);
  result.observedAt = new Date(at).toISOString();
  result.at = result.observedAt;
  result.windows[0]!.resetsAt = resetsAt;
  result.windows[0]!.minutes = 10080;
  return result;
}

test('A pool whose window used percent rose 2 points over the last 90 minutes, with maxBurnPerHour 0.8, admits no new task, and a task routed to it goes to its next allowed fallback profile or waits', () => {
  const base = fixturePool();
  const codex = { ...base, policy: { ...base.policy, maxBurnPerHour: 0.8, allowUnknown: false } };
  const cursor = {
    ...codex,
    name: 'cursor',
    cli: 'cursor' as const,
    classes: ['cursor'],
    command: 'cursor-agent',
    allowanceKey: 'cursor',
    policy: { weight: 1, reservePercent: 0, allowUnknown: false, maxAgeMs: 60_000 },
  };
  const history = [observed(codex, 10, now - span)];
  const current = observed(codex, 12, now);
  const cursorReading = observed(cursor, 5, now);
  expect(burnPerHour(current, history, { now, spanMs: span })).toBeCloseTo(2 / 1.5, 5);
  expect(() => choosePool(profile, [codex], [current], { now, history, spanMs: span })).toThrow('no allowed pool');
  expect(poolAllowed(codex, [current], { now, history, spanMs: span })).toBe(false);
  const chosen = choosePoolWithFallback(profile, [cursorProfile], [codex, cursor], [current, cursorReading], {
    now,
    history,
    spanMs: span,
  });
  expect(chosen.profile).toBe(cursorProfile);
  expect(chosen.pool.name).toBe('cursor');
  expect(() => choosePoolWithFallback(profile, [], [codex], [current], { now, history, spanMs: span })).toThrow(
    'no allowed pool',
  );
  expect(poolBurnStatus([codex, cursor], [...history, current, cursorReading], now, span)).toEqual([
    { name: 'fixture', allowanceKey: 'fixture', burnPerHour: 2 / 1.5, maxBurnPerHour: 0.8 },
    { name: 'cursor', allowanceKey: 'cursor', burnPerHour: 0 },
  ]);
});

test('Manager mailbox admission bypasses worker reserve, pacing and concurrency, while confirmed provider exhaustion still refuses it', () => {
  const base = fixturePool();
  const pool = {
    ...base,
    policy: {
      ...base.policy,
      reservePercent: 20,
      reservePerHour: 10,
      maxBurnPerHour: 0.1,
      maxConcurrent: 1,
      allowUnknown: false,
    },
  };
  const currentNow = Date.now();
  const resetsAt = currentNow + 8 * hour;
  const history = [observed(pool, 10, currentNow - span, resetsAt)];
  const current = observed(pool, 95, currentNow, resetsAt);
  expect(poolAllowed(pool, [current], { now: currentNow, history, spanMs: span, running: { fixture: 1 } })).toBe(false);
  expect(managerWakePoolAllowed(pool, [current])).toBe(true);
  current.exhausted = true;
  expect(managerWakePoolAllowed(pool, [current])).toBe(false);
});

test('Integer percent readings taken every few minutes, where most consecutive readings are equal, still yield the true rate over the measurement span', () => {
  const pool = fixturePool();
  const used = [10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11, 11, 12, 12, 12, 12, 12, 12];
  const history = used.map((percent, index) => observed(pool, percent, now - span + index * 5 * 60_000));
  const current = history.at(-1)!;
  expect(burnPerHour(current, history.slice(-2, -1), { now, spanMs: span })).toBe(0);
  expect(burnPerHour(current, history.slice(0, -1), { now, spanMs: span })).toBeCloseTo(2 / 1.5, 5);
});

test('A pool with policy.maxConcurrent 8 and 8 running attempts admits no new task. A task routed to it takes its next allowed fallback or waits.', () => {
  const base = fixturePool();
  const codex = { ...base, policy: { ...base.policy, maxConcurrent: 8, allowUnknown: false } };
  const cursor = {
    ...codex,
    name: 'cursor',
    cli: 'cursor' as const,
    classes: ['cursor'],
    command: 'cursor-agent',
    allowanceKey: 'cursor',
    policy: { weight: 1, reservePercent: 0, allowUnknown: false, maxAgeMs: 60_000, maxConcurrent: 8 },
  };
  const current = observed(codex, 10, now);
  const cursorReading = observed(cursor, 5, now);
  const full = { fixture: 8 };
  expect(choosePool(profile, [codex], [current], { now, running: { fixture: 7 } }).name).toBe('fixture');
  expect(() => choosePool(profile, [codex], [current], { now, running: full })).toThrow('no allowed pool');
  expect(() => choosePool(profile, [codex], [current], { now, running: full, preferred: 'fixture' })).toThrow(
    'no allowed pool',
  );
  const chosen = choosePoolWithFallback(profile, [cursorProfile], [codex, cursor], [current, cursorReading], {
    now,
    running: full,
  });
  expect(chosen.profile).toBe(cursorProfile);
  expect(chosen.pool.name).toBe('cursor');
  expect(() => choosePoolWithFallback(profile, [], [codex], [current], { now, running: full })).toThrow(
    'no allowed pool',
  );
  expect(
    countAllowanceWaiting([{ first: profile, fallbacks: [] }], [codex], [current], { now, running: full }),
  ).toEqual({ fixture: 1 });
});

test('Pools without maxConcurrent behave as today; status shows live and waiting against maxConcurrent per pool.', () => {
  const open = { ...fixturePool(), policy: { ...fixturePool().policy, allowUnknown: false } };
  const capped = {
    ...open,
    name: 'capped',
    allowanceKey: 'capped',
    policy: { ...open.policy, maxConcurrent: 8 },
  };
  const current = observed(open, 10, now);
  expect(choosePool(profile, [open], [current], { now, running: { fixture: 8 } }).name).toBe('fixture');
  const attempts = [
    { pool: 'fixture', state: 'running' },
    { pool: 'fixture', state: 'waiting' },
    { pool: 'fixture', state: 'pending' },
    { pool: 'fixture', state: 'exited' },
    { pool: 'cursor', state: 'running' },
  ];
  expect(countRunningByPool(attempts)).toEqual({ fixture: 2, cursor: 1 });
  expect(countWaitingByPool(attempts)).toEqual({ fixture: 1 });
  expect(poolBurnStatus([open, capped], [current], now, span, { fixture: 8, capped: 5 }, { capped: 11 })).toEqual([
    { name: 'fixture', allowanceKey: 'fixture', burnPerHour: 0 },
    { name: 'capped', allowanceKey: 'capped', burnPerHour: 0, live: 5, waiting: 11, maxConcurrent: 8 },
  ]);
});

test('A window reset between readings is not counted as burn', () => {
  const pool = fixturePool();
  const before = observed(pool, 90, now - span, now - span + 1000);
  const after = observed(pool, 5, now, now + 8 * hour);
  expect(burnPerHour(after, [before], { now, spanMs: span })).toBe(0);
  expect(
    choosePool(profile, [{ ...pool, policy: { ...pool.policy, maxBurnPerHour: 0.8 } }], [after], {
      now,
      history: [before],
      spanMs: span,
    }).name,
  ).toBe(pool.name);
});
