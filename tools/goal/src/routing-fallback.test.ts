import { expect, test } from 'bun:test';
import { choosePoolWithFallback } from './allowance.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

const luna: Profile = { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' };
const cursorLuna: Profile = { cli: 'cursor', model: 'gpt-5.6-luna', effort: 'high', poolClass: 'cursor' };
const policy = { weight: 1, reservePercent: 20, allowUnknown: true, maxAgeMs: 3_600_000 };
const pools = [
  { name: 'codex', cli: 'codex', classes: ['codex'], command: 'codex', configDirectory: '/x', allowanceKey: 'codex', policy },
  { name: 'cursor', cli: 'cursor', classes: ['cursor'], command: 'cursor-agent', configDirectory: '/y', allowanceKey: 'cursor', policy },
] as unknown as Pool[];
const now = Date.parse('2026-10-25T12:00:00.000Z');
const reading = (pool: string, usedPercent: number) => ({ pool, allowanceKey: pool, observedAt: '2026-10-25T11:59:00.000Z',
  at: '2026-10-25T12:00:00.000Z', exhausted: false, windows: [{ usedPercent, windowMinutes: 10080 }] }) as unknown as PoolReading;

test('the routed profile keeps its pool while that CLI has quota', () => {
  const chosen = choosePoolWithFallback(luna, [cursorLuna], pools, [reading('codex', 40)], { now });
  expect(chosen.profile).toBe(luna); expect(chosen.pool.name).toBe('codex');
});

test('a routed CLI below its reserve falls back to the next profile on another CLI', () => {
  const chosen = choosePoolWithFallback(luna, [cursorLuna], pools, [reading('codex', 85)], { now });
  expect(chosen.profile).toBe(cursorLuna); expect(chosen.pool.name).toBe('cursor');
});

test('with no fallback that has quota the original refusal stands', () => {
  expect(() => choosePoolWithFallback(luna, [], pools, [reading('codex', 85)], { now })).toThrow('no allowed pool');
});
