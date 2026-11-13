import { expect, test } from 'bun:test';
import {
  burnEvidence,
  burnHorizonMs,
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

test('A Codex integer rise of 2 points over 90 minutes is one point of uncertainty, so a 0.8 ceiling still admits; 4 points refuse and fall back', () => {
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
  const twoPoints = observed(codex, 12, now);
  const fourPoints = observed(codex, 14, now);
  const cursorReading = observed(cursor, 5, now);
  const options = { now, spanMs: span, cli: 'codex' as const };
  expect(burnPerHour(twoPoints, history, options)).toBeCloseTo(1 / 1.5, 5);
  expect(burnEvidence(twoPoints, history, options)).toMatchObject({
    evidence: 'rate',
    observedRate: 2 / 1.5,
  });
  expect(choosePool(profile, [codex], [twoPoints], { now, history, spanMs: span }).name).toBe(codex.name);
  expect(poolAllowed(codex, [twoPoints], { now, history, spanMs: span })).toBe(true);
  expect(burnPerHour(fourPoints, history, options)).toBeCloseTo(3 / 1.5, 5);
  expect(() => choosePool(profile, [codex], [fourPoints], { now, history, spanMs: span })).toThrow('no allowed pool');
  expect(poolAllowed(codex, [fourPoints], { now, history, spanMs: span })).toBe(false);
  const chosen = choosePoolWithFallback(profile, [cursorProfile], [codex, cursor], [fourPoints, cursorReading], {
    now,
    history,
    spanMs: span,
  });
  expect(chosen.profile).toBe(cursorProfile);
  expect(chosen.pool.name).toBe('cursor');
  expect(() => choosePoolWithFallback(profile, [], [codex], [fourPoints], { now, history, spanMs: span })).toThrow(
    'no allowed pool',
  );
  expect(poolBurnStatus([codex, cursor], [...history, twoPoints, cursorReading], now, span)).toEqual([
    {
      name: 'fixture',
      allowanceKey: 'fixture',
      burnPerHour: 1 / 1.5,
      observedBurnPerHour: 2 / 1.5,
      maxBurnPerHour: 0.8,
    },
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
  const options = { now, spanMs: span, cli: 'codex' as const };
  expect(burnPerHour(current, history.slice(-2, -1), options)).toBe(0);
  expect(burnEvidence(current, history.slice(-2, -1), options).evidence).toBe('unresolved');
  expect(burnPerHour(current, history.slice(0, -1), options)).toBeCloseTo(1 / 1.5, 5);
  expect(burnEvidence(current, history.slice(0, -1), options).observedRate).toBeCloseTo(2 / 1.5, 5);
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

test('fresh same-profile pools rank by reset pressure, while a same-attempt pool preference stays first', () => {
  const base = fixturePool();
  const expiring = {
    ...base,
    name: 'codex-1',
    allowanceKey: 'codex-1',
    policy: { ...base.policy, weight: 1, allowUnknown: false },
  };
  const weighted = {
    ...base,
    name: 'codex',
    allowanceKey: 'codex',
    policy: { ...base.policy, weight: 2.5, allowUnknown: false },
  };
  const readings = [observed(expiring, 13, now, now + 43.5 * hour), observed(weighted, 7, now, now + 137 * hour)];

  expect(choosePool(profile, [expiring, weighted], readings, { now }).name).toBe('codex-1');
  expect(
    choosePoolWithFallback(profile, [], [expiring, weighted], readings, { now, preferred: 'codex' }).pool.name,
  ).toBe('codex');

  const alpha = { ...expiring, name: 'alpha', allowanceKey: 'alpha' };
  const beta = {
    ...weighted,
    name: 'beta',
    allowanceKey: 'beta',
    policy: { ...weighted.policy, weight: 1 },
  };
  const tied = [observed(alpha, 13, now, now + 43.5 * hour), observed(beta, 13, now, now + 43.5 * hour)];
  expect(choosePool(profile, [beta, alpha], tied, { now }).name).toBe('alpha');

  const managerProfile = { ...profile, poolClass: 'manager' };
  const managerPools = [
    { ...expiring, classes: ['manager'] },
    { ...weighted, classes: ['manager'] },
  ];
  expect(choosePool(managerProfile, managerPools, readings, { now }).name).toBe('codex');
});

test('missing or stale reset evidence falls back to weighted allowance, and caps or exhaustion still exclude a pool', () => {
  const base = fixturePool();
  const expiring = {
    ...base,
    name: 'codex-1',
    allowanceKey: 'codex-1',
    policy: { ...base.policy, weight: 1, allowUnknown: true, maxAgeMs: 60 * 60_000 },
  };
  const weighted = {
    ...base,
    name: 'codex',
    allowanceKey: 'codex',
    policy: { ...base.policy, weight: 2.5, allowUnknown: false, maxAgeMs: 60 * 60_000 },
  };
  const noReset = [observed(expiring, 13, now, now + 43.5 * hour), observed(weighted, 7, now, now + 137 * hour)];
  noReset[0]!.windows[0]!.resetsAt = null;
  expect(choosePool(profile, [expiring, weighted], noReset, { now }).name).toBe('codex');

  const stale = [
    observed(expiring, 13, now - 2 * hour, now + 43.5 * hour),
    observed(weighted, 7, now, now + 137 * hour),
  ];
  expect(choosePool(profile, [expiring, weighted], stale, { now }).name).toBe('codex');

  const capped = {
    ...expiring,
    policy: { ...expiring.policy, allowUnknown: false, maxConcurrent: 1 },
  };
  const fresh = [observed(capped, 13, now, now + 43.5 * hour), noReset[1]!];
  expect(choosePool(profile, [capped, weighted], fresh, { now, running: { 'codex-1': 1 } }).name).toBe('codex');
  fresh[0]!.exhausted = true;
  expect(choosePool(profile, [capped, weighted], fresh, { now }).name).toBe('codex');
});

test('Codex integer 12 to 13 in about an hour at 0.74 is unresolved, then a plateau still admits', () => {
  const pool = { ...fixturePool(), policy: { ...fixturePool().policy, maxBurnPerHour: 0.74, allowUnknown: false } };
  const elapsed = Math.round(hour / 0.991);
  const baseline = observed(pool, 12, now - elapsed);
  const step = observed(pool, 13, now);
  const options = { now, spanMs: span, cli: 'codex' as const };
  expect(burnEvidence(step, [baseline], options)).toMatchObject({ rate: 0, evidence: 'unresolved' });
  expect(burnEvidence(step, [baseline], options).observedRate).toBeCloseTo(0.991, 3);
  expect(poolAllowed(pool, [step], { now, history: [baseline], spanMs: span })).toBe(true);
  const status = poolBurnStatus([pool], [baseline, step], now, span)[0]!;
  expect(status.burnPerHour).toBe(0);
  expect(status.observedBurnPerHour).toBeCloseTo(0.991, 3);
  expect(status.maxBurnPerHour).toBe(0.74);
  const plateau = observed(pool, 13, now + hour);
  expect(burnEvidence(plateau, [baseline, step], { now: now + hour, spanMs: span, cli: 'codex' }).evidence).toBe(
    'unresolved',
  );
  expect(poolAllowed(pool, [plateau], { now: now + hour, history: [baseline, step], spanMs: span })).toBe(true);
});

test('Coarse Codex burn uses the 6 h horizon, isolates accounts, and keeps fractional, reset, missing and exhaustion policy', () => {
  const pool = { ...fixturePool(), policy: { ...fixturePool().policy, maxBurnPerHour: 0.74, allowUnknown: false } };
  const other = { ...pool, name: 'codex-1', allowanceKey: 'codex-1' };
  const horizon = burnHorizonMs(span);
  expect(horizon).toBe(6 * hour);
  const paced = Array.from({ length: 7 }, (_, index) => observed(pool, 12 + index, now - horizon + index * hour));
  const current = paced.at(-1)!;
  const options = { now, spanMs: span, cli: 'codex' as const };
  expect(burnPerHour(current, paced.slice(0, -1), options)).toBeCloseTo(5 / 6, 5);
  expect(poolAllowed(pool, [current], { now, history: paced.slice(0, -1), spanMs: span })).toBe(false);

  const burst = [observed(pool, 12, now - 20 * 60_000), observed(pool, 14, now - 8 * 60_000)];
  expect(burnPerHour(observed(pool, 16, now), burst, options)).toBeGreaterThan(0.74);
  expect(poolAllowed(pool, [observed(pool, 16, now)], { now, history: burst, spanMs: span })).toBe(false);

  const fractionalHistory = [observed(pool, 12.2, now - hour)];
  expect(burnPerHour(observed(pool, 13.31, now), fractionalHistory, options)).toBeCloseTo(1.11, 5);
  expect(poolAllowed(pool, [observed(pool, 13.31, now)], { now, history: fractionalHistory, spanMs: span })).toBe(
    false,
  );
  expect(burnPerHour(observed(pool, 12.6, now), fractionalHistory, options)).toBeCloseTo(0.4, 5);
  expect(poolAllowed(pool, [observed(pool, 12.6, now)], { now, history: fractionalHistory, spanMs: span })).toBe(true);

  const flat = observed(pool, 12, now);
  expect(burnEvidence(flat, [observed(pool, 12, now - hour)], options)).toMatchObject({
    rate: 0,
    observedRate: 0,
    evidence: 'unresolved',
  });
  expect(burnEvidence(flat, [], options).evidence).toBe('none');
  const unordered = [observed(pool, 18, now - 10 * 60_000), observed(pool, 12, now - horizon)];
  expect(burnPerHour(observed(pool, 18, now), unordered, options)).toBeCloseTo(5 / 6, 5);

  const beforeReset = observed(pool, 90, now - span, now - span + 1000);
  expect(burnPerHour(observed(pool, 18, now), [beforeReset], options)).toBe(0);
  const unknownPast = observed(pool, 12, now - horizon);
  unknownPast.windows[0]!.resetsAt = null;
  const unknownNow = observed(pool, 18, now);
  unknownNow.windows[0]!.resetsAt = null;
  expect(burnPerHour(unknownNow, [unknownPast], options)).toBe(0);

  const otherBurn = [observed(other, 12, now - hour), observed(other, 80, now)];
  expect(poolAllowed(pool, [observed(pool, 13, now)], { now, history: otherBurn, spanMs: span })).toBe(true);
  expect(poolAllowed(other, [otherBurn[1]!], { now, history: otherBurn, spanMs: span })).toBe(false);
  const exhausted = observed(pool, 13, now);
  exhausted.exhausted = true;
  expect(poolAllowed(pool, [exhausted], { now, history: [observed(pool, 12, now - hour)], spanMs: span })).toBe(false);
});
