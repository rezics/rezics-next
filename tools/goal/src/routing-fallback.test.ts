import { expect, test } from 'bun:test';
import { choosePoolWithFallback } from './allowance.ts';
import { retryFallbacks, type RoutingTable } from './routing.ts';
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

test('a retry whose engine is spent reroutes through the current route, starting at its first profile', () => {
  const sonnet: Profile = { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'high', poolClass: 'claude' };
  const table = { version: 'test', experiments: [], consultation: luna, classes: { implementation: { first: sonnet, fallbacks: [luna], maxSteps: 1, maxMs: 1 } } } as unknown as RoutingTable;
  const withClaude = [...pools, { name: 'claude-worker', cli: 'claude', classes: ['claude'], command: 'claude', configDirectory: '/z', allowanceKey: 'claude', policy }] as unknown as Pool[];
  const fallbacks = retryFallbacks(table, 'implementation');
  expect(fallbacks).toEqual([sonnet, luna]);
  const chosen = choosePoolWithFallback(cursorLuna, fallbacks, withClaude, [reading('cursor', 100), reading('claude', 10)], { now });
  expect(chosen.profile).toBe(sonnet); expect(chosen.pool.name).toBe('claude-worker');
  expect(retryFallbacks(table, 'mechanical')).toEqual([]);
});
