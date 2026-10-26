import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choosePoolWithFallback } from './allowance.ts';
import { alertUnspentAllowances, pace, parseCodexStatus } from './pacing.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

const now = Date.parse('2026-10-26T10:00:00Z');
const hour = 3_600_000;
const policy = (reservePercent: number) => ({ weight: 1, reservePercent, allowUnknown: true, maxAgeMs: 24 * hour });
const claude = { name: 'claude-worker', cli: 'claude', classes: ['claude'], command: 'claude', configDirectory: '/c', allowanceKey: 'claude', policy: policy(30) } as unknown as Pool;
const codex = { name: 'codex', cli: 'codex', classes: ['codex'], command: 'codex', configDirectory: '/x', allowanceKey: 'codex', policy: policy(5) } as unknown as Pool;
const reading = (pool: Pool, usedPercent: number, resetsInHours: number): PoolReading => ({
  pool: pool.name, allowanceKey: pool.allowanceKey, at: new Date(now).toISOString(), observedAt: new Date(now - 60_000).toISOString(),
  exhausted: false, error: null,
  windows: [{ usedPercent: 5, resetsAt: now + hour, minutes: 300 }, { usedPercent, resetsAt: now + resetsInHours * hour, minutes: 10080 }],
});
const sonnet: Profile = { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'high', poolClass: 'claude' };
const luna: Profile = { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' };

test('pace is the share of the allowance per hour that must be spent before its weekly reset', () => {
  expect(pace(reading(claude, 52, 5), claude, now)).toEqual({ allowanceKey: 'claude', unusedPercent: 18, hoursToReset: 5, urgency: 3.6 });
  // An announced Codex reset before the window's own reset leaves less time.
  const schedule = { scheduledAt: new Date(now + 10 * hour).toISOString(), latestResetAt: null, fetchedAt: new Date(now).toISOString() };
  expect(pace(reading(codex, 15, 160), codex, now, schedule)?.hoursToReset).toBe(10);
  expect(parseCodexStatus(JSON.stringify({ data: { scheduled_reset: null, latest_reset: { announced_at: '2026-10-26T07:00:00Z' } } }), now))
    .toEqual({ scheduledAt: null, latestResetAt: '2026-10-26T07:00:00Z', fetchedAt: new Date(now).toISOString() });
});

test('a new task goes to the allowed engine whose allowance would expire unused first; a retry keeps its engine', () => {
  const readings = [reading(claude, 52, 5), reading(codex, 20, 150)];
  const urgency = (pool: Pool) => pace(readings.find((r) => r.pool === pool.name)!, pool, now)?.urgency;
  // Codex is the routed first profile, but Claude's week ends in five hours with most of it unused.
  expect(choosePoolWithFallback(luna, [sonnet], [claude, codex], readings, { now }, urgency).pool.name).toBe('claude-worker');
  // Early in Claude's week, the routed order stands.
  const early = [reading(claude, 10, 150), reading(codex, 20, 150)];
  const earlyUrgency = (pool: Pool) => pace(early.find((r) => r.pool === pool.name)!, pool, now)?.urgency;
  expect(choosePoolWithFallback(luna, [sonnet], [claude, codex], early, { now }, earlyUrgency).pool.name).toBe('codex');
  expect(choosePoolWithFallback(luna, [sonnet], [claude, codex], readings, { now, preferred: 'codex' }, urgency).pool.name).toBe('codex');
});

test('an allowance that will expire unused alerts the supermanager, at most every three hours', () => {
  const state = mkdtempSync(join(tmpdir(), 'pacing-'));
  try {
    const sent: string[] = [];
    const read = (pool: Pool) => (pool === claude ? reading(claude, 52, 5) : reading(codex, 20, 150));
    expect(alertUnspentAllowances([claude, codex], read, state, (s) => sent.push(s), now)).toBe(1);
    expect(sent[0]).toContain('claude has 18% unused');
    expect(alertUnspentAllowances([claude, codex], read, state, (s) => sent.push(s), now + hour)).toBe(0);
    expect(alertUnspentAllowances([claude, codex], read, state, (s) => sent.push(s), now + 3 * hour)).toBe(1);
    writeFileSync(join(state, 'pacing-alerts.json'), 'not json');
    expect(alertUnspentAllowances([claude, codex], read, state, () => {}, now + 4 * hour)).toBe(1);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
