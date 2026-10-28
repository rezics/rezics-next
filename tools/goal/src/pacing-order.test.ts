import { expect, test } from 'bun:test';
import { choosePoolWithFallback } from './pools.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

const now = Date.parse('2026-10-28T00:00:00.000Z');
const hour = 60 * 60 * 1000;
const codex = {
  name: 'codex',
  cli: 'codex',
  classes: ['codex'],
  command: 'codex',
  configDirectory: '/fixture/codex',
  allowanceKey: 'codex',
  policy: { weight: 1, reservePercent: 5, allowUnknown: false, maxAgeMs: 24 * hour },
} as Pool;
const claude = {
  ...codex,
  name: 'claude',
  cli: 'claude',
  classes: ['claude'],
  allowanceKey: 'claude',
} as Pool;
const reading: PoolReading = {
  pool: codex.name,
  allowanceKey: codex.allowanceKey,
  at: new Date(now).toISOString(),
  observedAt: new Date(now).toISOString(),
  exhausted: false,
  error: null,
  windows: [{ usedPercent: 20, resetsAt: now + 8 * hour, minutes: 300 }],
};
const claudeReading: PoolReading = { ...reading, pool: claude.name, allowanceKey: claude.allowanceKey };
const sol: Profile = { cli: 'codex', model: 'gpt-6-sol', effort: 'high', poolClass: 'codex' };
const luna: Profile = { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' };
const sonnet: Profile = { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'high', poolClass: 'claude' };

test('candidates on the same pool get the same pacing urgency, so route order decides between models that share a pool', () => {
  const urgencyTimes: number[] = [];
  let urgencyCalls = 0;
  const choice = choosePoolWithFallback(sol, [luna], [codex], [reading], { now }, (_pool, selectedAt) => {
    urgencyCalls++;
    urgencyTimes.push(selectedAt);
    // A fresh calculation for Luna would produce a larger value and overturn the route order.
    return urgencyCalls;
  });

  expect(urgencyCalls).toBe(1);
  expect(urgencyTimes).toEqual([now]);
  expect(choice.profile).toEqual(sol);
  expect(choice.pool).toBe(codex);
});

test('one pacing timestamp is shared across all pools in a route selection', () => {
  const urgencyTimes: number[] = [];
  choosePoolWithFallback(sol, [sonnet], [codex, claude], [reading, claudeReading], { now }, (_pool, selectedAt) => {
    urgencyTimes.push(selectedAt);
    return 1;
  });

  expect(urgencyTimes).toEqual([now, now]);
});
