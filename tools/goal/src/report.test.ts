import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRecord, readMeasurement } from './records.ts';
import { formatLifecycleMetrics, formatUsageReport, report } from './report.ts';
import { lifecycleMetrics } from './lifecycle-metrics.ts';
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
  // b: out-of-order history; attempt 3 is the landing while attempt 2 is the first pass.
  record('b', 3, {
    pool: 'pool-b',
    startedAt: '2026-10-25T00:45:00.000Z',
    endedAt: '2026-10-25T00:50:00.000Z',
    criticalPath: true,
    tokens: { input: 1000, cached: 800, output: 100 },
    usage: {
      model: 'latest-model',
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
  record('b', 1, {
    outcome: 'gate-failed',
    escalation: 'repeated-assertion',
    consulted: true,
    endedAt: '2026-10-25T00:20:00.000Z',
  }),
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
  record('urgent', 1, { urgent: true, tokens: { input: 40, cached: 10, output: 5 } }),
  record('proof', 1, {
    taskKind: 'verification',
    outcome: 'verified',
    consulted: true,
    pool: 'pool-b',
    tokens: { input: 50, cached: 40, output: 5 },
  }),
  // d: still waiting for its gate; ignored by every metric except the attempt count.
  record('d', 1, { outcome: 'pending-gate' }),
];

test('report computes the measurement metrics over attempt records', () => {
  const partial = report(records.slice(0, 2));
  expect(partial.tokensPerLandedTask[1]).toEqual({
    taskClass: 'implementation',
    model: 'latest-model',
    landedTasks: 1,
    attempts: 1,
    inputPerTask: 1000,
    cachedInputPerTask: 800,
    outputPerTask: 100,
    reasoningPerTask: 40,
    rawPerTask: 1100,
    compactionsPerTask: 1,
  });

  const result = report(records);
  expect(result).toEqual({
    urgent: { tasks: ['urgent'], attempts: 1, passedTasks: 1 },
    verifiedProofs: 1,
    proofAttempts: 1,
    attempts: 9,
    tasks: 3,
    passedTasks: 2,
    attemptsPerPassedTask: 2,
    firstAttemptPassRate: 1 / 3,
    wallClockToPassMs: {
      criticalPath: { count: 1, p50: 600_000, p90: 600_000 },
      other: { count: 1, p50: 2_400_000, p90: 2_400_000 },
    },
    pools: {
      'pool-a': { attempts: 5, passedTasks: 1, input: 3240, cached: 1610, output: 325 },
      'pool-b': { attempts: 3, passedTasks: 2, input: 4050, cached: 2840, output: 405 },
    },
    consultHitRate: 0.5,
    earlyStopRate: 1 / 8,
    reworkInputTokens: { 'repeated-assertion': 1000, 'early-stop': 500, stalled: 700, verified: 50 },
    stepShare: { decision: 0.1, read: 0.3, edit: 0.2, wait: 0.1, check: 0.2, commit: 0.1 },
    tokensPerLandedTask: [
      {
        taskClass: 'implementation',
        model: 'gpt-6-luna',
        landedTasks: 1,
        attempts: 1,
        inputPerTask: 1000,
        cachedInputPerTask: 800,
        outputPerTask: 100,
        reasoningPerTask: 0,
        rawPerTask: 1100,
        compactionsPerTask: 0,
      },
      {
        taskClass: 'implementation',
        model: 'latest-model',
        landedTasks: 1,
        attempts: 3,
        inputPerTask: 5000,
        cachedInputPerTask: 3600,
        outputPerTask: 500,
        reasoningPerTask: 40,
        rawPerTask: 5500,
        compactionsPerTask: 1,
      },
    ],
    nonLandingSpend: { rawTokens: 2475, totalRawTokens: 8020, share: 2475 / 8020 },
  });
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

test('flow text separates observed conflict figures from unavailable producer capabilities and truncated totals', () => {
  const h = harness();
  try {
    const metrics = lifecycleMetrics(h.store.db, Date.UTC(2026, 9, 30, 12));
    const text = formatLifecycleMetrics(metrics).join('\n');
    expect(text).toContain('Owner-landing capability: unavailable');
    expect(text).toContain('Conflicts in trailing hour: 0 observed; 0 unclassified rebase outcomes; total unknown');
    expect(text).toContain('Conflict-to-landed duration: unknown; open conflict count/oldest age: unknown');
    expect(text).toContain('resolution owner/rerere/replay: unknown');
    expect(text).toContain('Conflict-created attempts in trailing hour: 0 observed; 0 unknown causes; total unknown');
    metrics.conflicts.recordedOutcomes.complete = false;
    expect(formatLifecycleMetrics(metrics).join('\n')).toContain('truncated recorded window (lower bounds)');
    // Older snapshots can also reach the formatter directly, without the persisted-snapshot reader.
    const { conflicts, ...oldSnapshot } = metrics;
    const historical = formatLifecycleMetrics(oldSnapshot as typeof metrics).join('\n');
    expect(historical).toContain('Conflicts in trailing hour: unknown observed');
    expect(historical).toContain('Conflict-created attempts in trailing hour: unknown observed');
  } finally {
    h.dispose();
  }
});
