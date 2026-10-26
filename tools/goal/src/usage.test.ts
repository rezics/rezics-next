import { expect, test } from 'bun:test';
import { choosePool, burnPerHour } from './allowance.ts';
import { markExhausted, parseCodexUsage, withObservedExhaustion } from './usage.ts';
import { fixturePool, reading, tempDirectory } from './test-support.ts';
const profile = { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' } as const;
test('quota readings normalize reset windows and pool selection respects local reserves, freshness and shared allowance', () => {
  const pool = fixturePool();
  const now = Date.now();
  const parsed = parseCodexUsage(JSON.stringify({ timestamp: new Date(now).toISOString(), payload: { rate_limits: {
    primary: { used_percent: 100, window_minutes: 300, resets_at: now / 1000 - 1 }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: now / 1000 + 1000 },
  } } }), pool, now);
  expect(parsed.windows.map(w => w.usedPercent)).toEqual([0, 30]); expect(parsed.exhausted).toBe(false);
  const second = { ...pool, name: 'second', allowanceKey: 'second' };
  expect(choosePool(profile, [pool, second], [reading(pool, 90), reading(second, 10)]).name).toBe('second');
  expect(choosePool(profile, [pool, second], [reading(pool, 90), reading(second, 10)], { preferred: pool.name }).name).toBe(pool.name);
  expect(() => choosePool(profile, [{ ...pool, policy: { ...pool.policy, reservePercent: 20 } }], [reading(pool, 90)])).toThrow('no allowed pool');
  const correlated = { ...second, allowanceKey: pool.allowanceKey };
  expect(() => choosePool(profile, [pool, correlated], [reading(pool, 100), reading(correlated, 0)])).toThrow('no allowed pool');
  expect(() => choosePool(profile, [{ ...pool, policy: { ...pool.policy, allowUnknown: false } }], [])).toThrow('no allowed pool');
  expect(choosePool(profile, [pool], []).name).toBe(pool.name);
});
test('pacing measures only matching quota windows and never mistakes a reset for consumption', () => {
  const pool = fixturePool(), before = reading(pool, 10), after = reading(pool, 30);
  before.observedAt = new Date(Date.now() - 3600000).toISOString(); after.windows[0]!.resetsAt = before.windows[0]!.resetsAt;
  expect(burnPerHour(after, before)).toBeCloseTo(20, 1);
  const limited = { ...pool, policy: { ...pool.policy, maxBurnPerHour: 5 } };
  expect(() => choosePool(profile, [limited], [after], { history: [before] })).toThrow('no allowed pool');
  after.windows[0]!.resetsAt! += 3600000; expect(burnPerHour(after, before)).toBe(0);
});

test('an observed exhaustion keeps its allowance out of routing for the pool maxAgeMs, then lapses', () => {
  const pool = fixturePool(), state = tempDirectory(), now = Date.now();
  const unknown = { pool: pool.name, allowanceKey: pool.allowanceKey, at: new Date(now).toISOString(), observedAt: null, windows: [], exhausted: false, error: null };
  expect(withObservedExhaustion(unknown, pool, state, now)).toEqual(unknown);
  markExhausted(state, pool.allowanceKey, now);
  const marked = withObservedExhaustion(unknown, pool, state, now + 1000);
  expect(marked.exhausted).toBe(true);
  expect(() => choosePool(profile, [pool], [marked], { now: now + 1000 })).toThrow('no allowed pool');
  expect(withObservedExhaustion(unknown, pool, state, now + pool.policy.maxAgeMs + 1).exhausted).toBe(false);
});
