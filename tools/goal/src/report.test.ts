import { expect, test } from 'bun:test';
import { report } from './report.ts';
import type { AttemptRecord } from './types.ts';

const luna = { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' } as const;

function record(taskId: string, attempt: number, fields: Partial<AttemptRecord>): AttemptRecord {
  return {
    taskId, attempt, taskClass: 'implementation', profile: luna, pool: 'pool-a', tableVersion: '1', experiment: null,
    startedAt: '2026-10-25T00:00:00.000Z', endedAt: '2026-10-25T00:10:00.000Z', steps: 10, criticalPath: false,
    tokens: { input: 1000, cached: 800, output: 100 }, before: null, after: null, outcome: 'passed', firstFailure: null,
    escalation: null, consulted: false, fixRound: 0, diffLines: 10, changedFiles: ['a.ts'], hostMs: 1000,
    classifierVersion: '1', stepClasses: { decision: 1, read: 3, edit: 2, wait: 1, check: 2, commit: 1 }, earlyStop: false,
    ...fields,
  };
}

const records: AttemptRecord[] = [
  // a: passes first time, 10 minutes, critical path.
  record('a', 1, { criticalPath: true }),
  // b: fails, a consultation follows, the second attempt passes 40 minutes after the first one started.
  record('b', 1, { outcome: 'gate-failed', escalation: 'repeated-assertion', endedAt: '2026-10-25T00:20:00.000Z' }),
  record('b', 2, { consulted: true, pool: 'pool-b', startedAt: '2026-10-25T00:25:00.000Z', endedAt: '2026-10-25T00:40:00.000Z',
    tokens: { input: 3000, cached: 2000, output: 300 } }),
  // c: stopped after an early stop; never passes.
  record('c', 1, { outcome: 'gate-failed', escalation: 'early-stop', earlyStop: true, tokens: { input: 500, cached: 0, output: 50 } }),
  record('c', 2, { outcome: 'stopped', escalation: 'stalled', consulted: true, tokens: { input: 700, cached: 0, output: 70 } }),
  // d: still waiting for its gate; ignored by every metric except the attempt count.
  record('d', 1, { outcome: 'pending-gate' }),
];

test('report computes the measurement metrics over attempt records', () => {
  const result = report(records);
  expect(result.attempts).toBe(6);
  expect(result.tasks).toBe(3);
  expect(result.passedTasks).toBe(2);
  expect(result.attemptsPerPassedTask).toBe(1.5);
  expect(result.firstAttemptPassRate).toBeCloseTo(1 / 3);
  expect(result.wallClockToPassMs.criticalPath).toEqual({ count: 1, p50: 600_000, p90: 600_000 });
  expect(result.wallClockToPassMs.other).toEqual({ count: 1, p50: 2_400_000, p90: 2_400_000 });
  expect(result.pools['pool-a']).toEqual({ attempts: 4, passedTasks: 1, input: 3200, cached: 1600, output: 320 });
  expect(result.pools['pool-b']).toEqual({ attempts: 1, passedTasks: 1, input: 3000, cached: 2000, output: 300 });
  expect(result.consultHitRate).toBe(0.5);
  expect(result.earlyStopRate).toBeCloseTo(1 / 5);
  expect(result.reworkInputTokens).toEqual({ 'repeated-assertion': 1000, 'early-stop': 500, stalled: 700 });
  expect(result.stepShare).toEqual({ decision: 0.1, read: 0.3, edit: 0.2, wait: 0.1, check: 0.2, commit: 0.1 });
});

test('report on no records has no rates', () => {
  const result = report([]);
  expect(result).toMatchObject({ attempts: 0, tasks: 0, passedTasks: 0, attemptsPerPassedTask: null,
    firstAttemptPassRate: null, consultHitRate: null, earlyStopRate: null });
  expect(result.wallClockToPassMs.other).toEqual({ count: 0, p50: null, p90: null });
});

test('percentiles use the nearest rank', () => {
  const many = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(minutes => record(`t${minutes}`, 1, {
    endedAt: new Date(Date.parse('2026-10-25T00:00:00.000Z') + minutes * 60_000).toISOString() }));
  expect(report(many).wallClockToPassMs.other).toEqual({ count: 10, p50: 300_000, p90: 540_000 });
});
