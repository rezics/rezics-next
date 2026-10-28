import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRecord, readMeasurement } from './records.ts';
import { formatUsageReport, report } from './report.ts';
import type { Attempt, AttemptRecord, Task } from './types.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { harness } from './test-support.ts';
import type { WorkerStore } from './store.ts';

const luna = { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' } as const;

function record(taskId: string, attempt: number, fields: Partial<AttemptRecord>): AttemptRecord {
  return {
    taskId,
    attempt,
    taskClass: 'implementation',
    profile: luna,
    pool: 'pool-a',
    tableVersion: '1',
    experiment: null,
    startedAt: '2026-10-25T00:00:00.000Z',
    endedAt: '2026-10-25T00:10:00.000Z',
    steps: 10,
    criticalPath: false,
    tokens: { input: 1000, cached: 800, output: 100 },
    before: null,
    after: null,
    outcome: 'passed',
    firstFailure: null,
    escalation: null,
    consulted: false,
    fixRound: 0,
    diffLines: 10,
    changedFiles: ['a.ts'],
    hostMs: 1000,
    classifierVersion: '1',
    stepClasses: { decision: 1, read: 3, edit: 2, wait: 1, check: 2, commit: 1 },
    earlyStop: false,
    ...fields,
  };
}

const records: AttemptRecord[] = [
  // a: passes first time, 10 minutes, critical path.
  record('a', 1, { criticalPath: true }),
  // b: fails, a consultation follows, the second attempt passes 40 minutes after the first one started.
  record('b', 1, { outcome: 'gate-failed', escalation: 'repeated-assertion', endedAt: '2026-10-25T00:20:00.000Z' }),
  record('b', 2, {
    consulted: true,
    pool: 'pool-b',
    startedAt: '2026-10-25T00:25:00.000Z',
    endedAt: '2026-10-25T00:40:00.000Z',
    tokens: { input: 3000, cached: 2000, output: 300 },
  }),
  // c: stopped after an early stop; never passes.
  record('c', 1, {
    outcome: 'gate-failed',
    escalation: 'early-stop',
    earlyStop: true,
    tokens: { input: 500, cached: 0, output: 50 },
  }),
  record('c', 2, {
    outcome: 'stopped',
    escalation: 'stalled',
    consulted: true,
    tokens: { input: 700, cached: 0, output: 70 },
  }),
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
  expect(result).toMatchObject({
    attempts: 0,
    tasks: 0,
    passedTasks: 0,
    attemptsPerPassedTask: null,
    firstAttemptPassRate: null,
    consultHitRate: null,
    earlyStopRate: null,
  });
  expect(result.wallClockToPassMs.other).toEqual({ count: 0, p50: null, p90: null });
});

test('percentiles use the nearest rank', () => {
  const many = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((minutes) =>
    record(`t${minutes}`, 1, {
      endedAt: new Date(Date.parse('2026-10-25T00:00:00.000Z') + minutes * 60_000).toISOString(),
    }),
  );
  expect(report(many).wallClockToPassMs.other).toEqual({ count: 10, p50: 300_000, p90: 540_000 });
});

test('Codex usage is read per attempt from the recorded session ledger', () => {
  const tempRoot = join(import.meta.dir, '../../../.temp');
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(join(tempRoot, 'goal-codex-usage-'));
  const session = 'codex-usage-session';
  const configDirectory = join(root, 'codex-home');
  const sessions = join(configDirectory, 'sessions', '2026', '10', '27');
  mkdirSync(sessions, { recursive: true });
  try {
    const fixture = readFileSync(join(import.meta.dir, 'fixtures/codex-usage.jsonl'), 'utf8');
    writeFileSync(join(sessions, `rollout-2026-10-27T00-00-00-${session}.jsonl`), fixture);
    const logPath = join(root, 'attempt.jsonl');
    writeFileSync(
      logPath,
      [
        { timestamp: '2026-10-27T00:01:00.000Z', type: 'thread.started', thread_id: session },
        {
          timestamp: '2026-10-27T00:03:30.000Z',
          type: 'turn.completed',
          usage: { input_tokens: 4000, output_tokens: 400 },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    );
    const attempt = {
      taskId: 'task',
      attempt: 1,
      logPath,
      session: null,
      startedAt: '2026-10-27T00:01:00.000Z',
      endedAt: '2026-10-27T00:04:00.000Z',
      profile: { cli: 'codex', model: 'routed-model', effort: 'medium', poolClass: 'codex' },
      pool: 'codex-pool',
      tableVersion: '1',
      experiment: null,
      before: null,
      after: null,
      failure: null,
      escalation: null,
      fixRound: 0,
      consulted: false,
    } as unknown as Attempt;

    const measured = readMeasurement(attempt, { configDirectory });
    expect(measured.tokens).toEqual({ input: 3000, cached: 2000, output: 300 });
    expect(measured.usage).toMatchObject({
      model: 'gpt-6.1-sol',
      effort: 'high',
      serviceTier: 'priority',
      reasoning: 140,
      compactions: 1,
    });
    const record = makeRecord(
      { id: 'task', taskClass: 'implementation', brief: { criticalPath: false } } as unknown as Task,
      attempt,
      measured,
    );
    expect(record.usage).toEqual({
      model: 'gpt-6.1-sol',
      effort: 'high',
      serviceTier: 'priority',
      input: 3000,
      cachedInput: 2000,
      output: 300,
      reasoning: 140,
      compactions: 1,
      source: 'codex-session',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('report groups landed histories by the winning model and reports nonlanding token share', () => {
  const history: AttemptRecord[] = [
    record('landed', 1, {
      outcome: 'stopped',
      tokens: { input: 500, cached: 400, output: 50 },
      usage: {
        model: 'old-model',
        effort: 'medium',
        serviceTier: 'default',
        input: 500,
        cachedInput: 400,
        output: 50,
        reasoning: 20,
        compactions: 2,
        source: 'codex-session',
      },
    }),
    record('landed', 2, {
      outcome: 'passed',
      tokens: { input: 1000, cached: 800, output: 100 },
      usage: {
        model: 'actual-model',
        effort: 'high',
        serviceTier: 'priority',
        input: 1000,
        cachedInput: 800,
        output: 100,
        reasoning: 40,
        compactions: 1,
        source: 'codex-session',
      },
    }),
    record('unlanded', 1, { outcome: 'gate-failed', tokens: { input: 3000, cached: 0, output: 300 } }),
    record('waiting', 1, { outcome: 'pending-gate', tokens: { input: 10000, cached: 9000, output: 1000 } }),
  ];
  const result = report(history);
  expect(result.tokensPerLandedTask).toEqual([
    {
      taskClass: 'implementation',
      model: 'actual-model',
      landedTasks: 1,
      attempts: 2,
      inputPerTask: 1500,
      cachedInputPerTask: 1200,
      outputPerTask: 150,
      reasoningPerTask: 60,
      rawPerTask: 1650,
      compactionsPerTask: 3,
    },
  ]);
  expect(result.nonLandingSpend).toEqual({ rawTokens: 3850, totalRawTokens: 4950, share: 3850 / 4950 });
  expect(formatUsageReport(result)).toEqual([
    'Tokens per landed task by class and winning model:',
    '  implementation / actual-model: 1,650 raw; 1,500 input (1,200 cached); 150 output; 60 reasoning; 3 compactions.',
    'Spend on attempts that did not land: 77.8% (3,850 / 4,950 raw tokens).',
  ]);
});

test('goal report prints the landed usage rows and nonlanding share', async () => {
  const h = harness();
  const output: string[] = [];
  const rows = [
    record('cli-task', 1, { outcome: 'stopped', tokens: { input: 500, cached: 400, output: 50 } }),
    record('cli-task', 2, {
      outcome: 'passed',
      tokens: { input: 1000, cached: 800, output: 100 },
      usage: {
        model: 'gpt-6.1-sol',
        effort: 'high',
        serviceTier: 'priority',
        input: 1000,
        cachedInput: 800,
        output: 100,
        reasoning: 40,
        compactions: 1,
        source: 'codex-session',
      },
    }),
  ];
  try {
    await runWorkerCommand('report', [], {
      settings: h.settings,
      store: { records: () => rows } as unknown as WorkerStore,
      print: (value) => output.push(value),
      env: {},
    });
    expect(output[0]).toContain('implementation / gpt-6.1-sol: 1,650 raw');
    expect(output[0]).toContain('Spend on attempts that did not land: 33.3% (550 / 1,650 raw tokens).');
  } finally {
    h.dispose();
  }
});
