import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import {
  checkFlowAlarms,
  dispatchDailyStepAudit,
  ensureFlow,
  flowReport,
  readFlow,
  readLandingOperations,
  recordFlow,
  summarizeLandingOperations,
  type FlowTask,
} from './flow.ts';
import type { Task } from './types.ts';
import { readControlPolicy } from './policy.ts';

const task = (id: string, goal = 'sample'): Task =>
  ({
    id,
    sequence: 1,
    brief: {
      goal,
      manager: goal,
      kind: 'implementation',
      paths: ['src/a.ts'],
      riskAreas: [],
      acceptance: { command: ['true'], tests: ['flow'], failing: false },
      estimate: { lines: 1, files: 1 },
      criticalPath: false,
      waiting: [],
      after: [],
      inseparable: false,
      citesSources: false,
      hostileInput: false,
      markdown: '',
    },
    branch: 'b',
    worktree: 'w',
    briefPath: 'p',
    base: 'c',
    taskClass: 'implementation',
    state: 'integrated',
    currentAttempt: 0,
    createdAt: '2026-10-29T00:00:00.000Z',
  }) as Task;
const date = (minute: number) => new Date(Date.UTC(2026, 9, 29, 0, minute)).toISOString();

test('dev transpile reporting prices final checks and handbacks while keeping measured zero distinct from unavailable', () => {
  const result = flowReport(
    [
      {
        taskId: 'repair',
        attempt: 1,
        stage: 'landing',
        action: 'dev-transpile',
        at: date(1),
        detail: JSON.stringify({
          outcome: 'repair-handback',
          elapsedMs: 0,
          changedFileCount: 2,
          typescriptFileCount: 1,
        }),
      },
      {
        taskId: 'repair',
        attempt: 2,
        stage: 'landing',
        action: 'dev-transpile',
        at: date(2),
        detail: JSON.stringify({ outcome: 'passed', elapsedMs: 0, changedFileCount: 1, typescriptFileCount: 1 }),
      },
      {
        taskId: 'unavailable',
        attempt: 1,
        stage: 'landing',
        action: 'dev-transpile',
        at: date(3),
        detail: JSON.stringify({
          outcome: 'unavailable',
          elapsedMs: null,
          changedFileCount: 1,
          typescriptFileCount: 1,
        }),
      },
    ],
    [],
  );
  expect(result.devTranspile).toMatchObject({
    successfulChecks: 1,
    repairHandbacks: 1,
    unavailable: 1,
    measuredChecks: 2,
    totalMs: 0,
    changedFiles: 4,
    typescriptFiles: 3,
  });
  const unavailableOnly = flowReport(
    [
      {
        taskId: 'unavailable',
        attempt: 1,
        stage: 'landing',
        action: 'dev-transpile',
        at: date(3),
        detail: JSON.stringify({ outcome: 'unavailable', elapsedMs: null }),
      },
    ],
    [],
  );
  expect(unavailableOnly.devTranspile).toMatchObject({ unavailable: 1, measuredChecks: 0, totalMs: null });
  const kernel = flowReport(
    [
      {
        taskId: 'repair',
        attempt: 1,
        stage: 'landing',
        action: 'dev-kernel-import',
        at: date(1),
        detail: JSON.stringify({
          outcome: 'repair-handback',
          elapsedMs: 0,
          setupMs: 0,
          importMs: 0,
          cleanupMs: 0,
          changedFileCount: 2,
          kernelFileCount: 1,
        }),
      },
      {
        taskId: 'repair',
        attempt: 2,
        stage: 'landing',
        action: 'dev-kernel-import',
        at: date(2),
        detail: JSON.stringify({
          outcome: 'passed',
          elapsedMs: 0,
          setupMs: 0,
          importMs: 0,
          cleanupMs: 0,
          changedFileCount: 1,
          kernelFileCount: 1,
        }),
      },
      {
        taskId: 'unavailable',
        attempt: 1,
        stage: 'landing',
        action: 'dev-kernel-import',
        at: date(3),
        detail: JSON.stringify({
          outcome: 'unavailable',
          elapsedMs: null,
          setupMs: null,
          importMs: null,
          cleanupMs: null,
        }),
      },
    ],
    [],
  );
  expect(kernel.devKernelImport).toMatchObject({
    successfulChecks: 1,
    repairHandbacks: 1,
    unavailable: 1,
    measuredChecks: 2,
    totalMs: 0,
    setupMs: 0,
    importMs: 0,
    cleanupMs: 0,
    changedFiles: 3,
    kernelFiles: 2,
  });
  expect(kernel.devTranspile.successfulChecks).toBe(0);
  const kernelUnavailableOnly = flowReport(
    [
      {
        taskId: 'unavailable',
        attempt: 1,
        stage: 'landing',
        action: 'dev-kernel-import',
        at: date(3),
        detail: JSON.stringify({ outcome: 'unavailable', elapsedMs: null }),
      },
    ],
    [],
  );
  expect(kernelUnavailableOnly.devKernelImport).toMatchObject({
    unavailable: 1,
    measuredChecks: 0,
    totalMs: null,
    setupMs: null,
    importMs: null,
    cleanupMs: null,
  });
});

test('dev architecture reporting records one measured candidate check and its repair handback', () => {
  const result = flowReport(
    [
      {
        taskId: 'architecture',
        attempt: 1,
        stage: 'landing',
        action: 'dev-architecture',
        at: date(1),
        detail: JSON.stringify({ outcome: 'repair-handback', elapsedMs: 10_500, changedFileCount: 3 }),
      },
      {
        taskId: 'architecture',
        attempt: 2,
        stage: 'landing',
        action: 'dev-architecture',
        at: date(2),
        detail: JSON.stringify({ outcome: 'passed', elapsedMs: 10_200, changedFileCount: 3 }),
      },
    ],
    [],
  );
  expect(result.devArchitecture).toMatchObject({
    successfulChecks: 1,
    repairHandbacks: 1,
    unavailable: 0,
    measuredChecks: 2,
    totalMs: 20_700,
    changedFiles: 6,
  });
});

test('every task records durable timestamps for dispatch, start, each check-slot request, acquisition and release, worker finish, landing enqueue, landing start, dev update, verification and integration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-'));
  const path = join(dir, 'flow.db');
  let db = openDb(path);
  ensureFlow(db);
  const actions: [string, string, string][] = [
    ['dispatch', 'dispatched', date(0)],
    ['start', 'requested', date(1)],
    ['start', 'started', date(2)],
    ['check', 'requested', date(3)],
    ['check', 'acquired', date(5)],
    ['check', 'released', date(6)],
    ['worker', 'finished', date(7)],
    ['landing', 'enqueued', date(8)],
    ['landing', 'started', date(9)],
    ['dev-update', 'updated', date(10)],
    ['verification', 'verified', date(11)],
    ['integration', 'integrated', date(12)],
    ['promotion', 'promoted', date(13)],
  ];
  for (const [stage, action, at] of actions)
    recordFlow(db, { taskId: 't1', attempt: 0, stage: stage as any, action, at });
  db.close();
  db = openDb(path);
  const events = readFlow(db);
  expect(events.map((e) => e.action)).toEqual(actions.map((x) => x[1]));
  expect(events[3]?.at).toBe(date(3));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('bounded flow reports use half-open UTC windows and pair terminal operations to their own earlier starts', () => {
  const db = openDb(':memory:');
  ensureFlow(db);
  const start = '2026-10-31T00:00:00.000Z';
  const end = '2026-10-31T01:00:00.000Z';
  let queueId = 0;
  const save = (operationId: string, startedAt: string | null, terminalAt: string) =>
    db
      .query(
        `INSERT INTO landing_operations(operation_id,queue_id,task_id,attempt,enqueued_at,started_at,terminal_at,terminal_action,terminal_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'finished', '{}')`,
      )
      .run(operationId, ++queueId, operationId, 1, start, startedAt, terminalAt);
  save('cross-midnight', '2026-10-30T23:40:00.000Z', '2026-10-31T00:10:00.000Z');
  save('missing-start', null, '2026-10-31T00:30:00.000Z');
  save('at-excluded-end', '2026-10-31T00:59:00.000Z', end);
  recordFlow(db, {
    taskId: 'legacy',
    attempt: 1,
    stage: 'landing',
    action: 'finished',
    at: '2026-10-31T00:40:00.000Z',
  });
  recordFlow(db, { taskId: 'window-task', attempt: 1, stage: 'landing', action: 'enqueued', at: start });
  recordFlow(db, { taskId: 'future-task', attempt: 1, stage: 'integration', action: 'integrated', at: end });

  const operations = readLandingOperations(db, start, end);
  const summary = summarizeLandingOperations(operations);
  expect(operations.map((operation) => operation.operationId)).toEqual(['cross-midnight', 'missing-start', null]);
  expect(summary).toMatchObject({
    terminalCount: 3,
    measuredCount: 1,
    unknownDurationCount: 2,
    totalDurationMs: 1_800_000,
    p50DurationMs: 1_800_000,
    p90DurationMs: 1_800_000,
  });
  const events = readFlow(db, start, end);
  expect(events.map((event) => event.taskId)).toEqual(['window-task', 'legacy']);
  const historical = flowReport(
    events,
    [{ ...task('window-task'), currentAttempt: 2, terminalState: 'integrated' } as FlowTask],
    Date.parse('2026-11-01T00:00:00.000Z'),
    { historical: true, landingOperations: operations, window: { since: start, until: end } },
  );
  expect(historical.window).toEqual({ since: start, until: end, startInclusive: true, endExclusive: true });
  expect(historical.landingOperations).toEqual(summary);
  expect(historical.stages.find((stage) => stage.stage === 'landing')).toMatchObject({
    count: 1,
    totalMs: 1_800_000,
    p90Ms: 1_800_000,
  });
  expect(historical.queues).toEqual([]);
  expect(historical.bottleneck).toBeNull();
  expect(historical.urgent.integrated).toBe(0);
  db.close();
});

test('verifier command flow completions retain their operation identity across UTC midnight and reject duplicates', () => {
  const db = openDb(':memory:');
  ensureFlow(db);
  const event = {
    taskId: 'dev-verifier-round:round-id',
    attempt: 1,
    stage: 'check' as const,
    action: 'command-completed',
    at: '2026-11-12T00:00:01.010Z',
    detail: JSON.stringify({ startedAt: '2026-11-11T23:59:58.990Z', durationMs: 2020 }),
    operationId: 'command-run-id',
  };
  recordFlow(db, event);

  expect(readFlow(db, '2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z')).toHaveLength(0);
  expect(readFlow(db, '2026-11-12T00:00:00.000Z', '2026-11-13T00:00:00.000Z')).toMatchObject([
    { taskId: event.taskId, stage: 'check', action: 'command-completed', at: event.at, operationId: event.operationId },
  ]);
  expect(() => recordFlow(db, event)).toThrow(/UNIQUE constraint failed/);
  db.close();
});

test('goal report --flow gives per stage and per Goal totals and percentiles, efficiency, queues, bottleneck and attempts', () => {
  const events: any[] = [];
  const add = (stage: string, action: string, minute: number, attempt = 0) =>
    events.push({ taskId: 't1', attempt, stage, action, at: date(minute) });
  add('dispatch', 'dispatched', 0);
  add('worker', 'started', 1);
  add('check', 'requested', 2);
  add('check', 'acquired', 4);
  add('check', 'released', 5);
  add('worker', 'finished', 8);
  add('landing', 'enqueued', 9);
  add('landing', 'started', 10);
  add('landing', 'finished', 12);
  add('integration', 'integrated', 13);
  const result = flowReport(events, [task('t1')], Date.parse(date(20)));
  expect(result.stages.find((s) => s.stage === 'landing')).toMatchObject({
    totalMs: 180000,
    p50Ms: 180000,
    p90Ms: 180000,
  });
  expect(result.goals[0]).toMatchObject({ goal: 'sample', totalMs: 780000, p50Ms: 780000, p90Ms: 780000 });
  expect(result.goals[0]?.stages.find((s) => s.stage === 'landing')).toMatchObject({
    totalMs: 180000,
    p50Ms: 180000,
    p90Ms: 180000,
  });
  expect(result.bottleneck).toBe('check');
  expect(result.flowEfficiency).toBeGreaterThan(0);
  expect(result.queues.find((q) => q.stage === 'landing')?.length).toBe(0);
  expect(result.attemptsPerIntegrated).toBe(1);
  expect(result.workerProcessLaunches).toBe(1);
});

test('attempt ratios count distinct generations, exclude urgent work and keep launches separate', () => {
  const result = flowReport(
    [
      { taskId: 'ordinary', attempt: 1, stage: 'worker', action: 'started', at: date(1) },
      { taskId: 'ordinary', attempt: 1, stage: 'worker', action: 'started', at: date(2) },
      { taskId: 'ordinary', attempt: 2, stage: 'worker', action: 'started', at: date(3) },
      { taskId: 'ordinary', attempt: 2, stage: 'integration', action: 'integrated', at: date(4) },
      { taskId: 'legacy', attempt: 0, stage: 'integration', action: 'integrated', at: date(5) },
      { taskId: 'urgent', attempt: 1, stage: 'worker', action: 'started', at: date(5) },
      { taskId: 'urgent', attempt: 1, stage: 'worker', action: 'started', at: date(6) },
      { taskId: 'urgent', attempt: 1, stage: 'integration', action: 'integrated', at: date(7) },
    ],
    [task('ordinary'), task('legacy'), { id: 'urgent', brief: { goal: 'sample', urgent: true } }],
    Date.parse(date(20)),
  );
  expect(result.attemptsPerIntegrated).toBe(1.5);
  expect(result.workerProcessLaunches).toBe(5);
  expect(result.attemptsPerIntegratedSample).toMatchObject({
    window: 'trailing 7 days',
    integratedTasks: 2,
    attemptGenerations: 3,
    attemptsPerIntegrated: 1.5,
  });
  const empty = flowReport([], [], Date.parse(date(20)));
  expect(empty.attemptsPerIntegrated).toBeNull();
  expect(empty.workerProcessLaunches).toBe(0);
});

test('the bounded retry sample counts integrations in its half-open window and proves missing launches', () => {
  const now = Date.parse('2026-11-05T00:00:00.000Z');
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const reportSince = now - 2 * 24 * 60 * 60 * 1000;
  const at = (timestamp: number) => new Date(timestamp).toISOString();
  const result = flowReport(
    [
      { taskId: 'before', attempt: 1, stage: 'integration', action: 'integrated', at: at(cutoff - 1) },
      { taskId: 'boundary', attempt: 2, stage: 'worker', action: 'started', at: at(reportSince - 1) },
      { taskId: 'boundary', attempt: 2, stage: 'integration', action: 'integrated', at: at(reportSince) },
      { taskId: 'inside', attempt: 3, stage: 'integration', action: 'integrated', at: at(cutoff + 1) },
      { taskId: 'report', attempt: 1, stage: 'worker', action: 'started', at: at(now - 60_000) },
      { taskId: 'report', attempt: 1, stage: 'integration', action: 'integrated', at: at(now - 30_000) },
      { taskId: 'end', attempt: 4, stage: 'integration', action: 'integrated', at: at(now) },
    ],
    [],
    now,
    { reportSince: at(reportSince) },
  );
  expect(result.workerProcessLaunches).toBe(1);
  expect(result.attemptsPerIntegrated).toBe(1);
  expect(result.attemptsPerIntegratedSample).toMatchObject({
    window: 'trailing 7 days',
    integratedTasks: 3,
    attemptGenerations: 3,
    attemptsPerIntegrated: 1,
  });
});

test('flow reports count over-budget worker and manager launches once per layer', () => {
  const result = flowReport(
    [
      {
        taskId: 't1',
        attempt: 1,
        stage: 'worker',
        action: 'started',
        at: date(1),
        detail: JSON.stringify({ prompt: { overBudget: ['role', 'total', 'role'] } }),
      },
      {
        taskId: 'manager:fixture',
        attempt: 1,
        stage: 'manager',
        action: 'started',
        at: date(2),
        detail: JSON.stringify({ prompt: { overBudget: ['opening'] } }),
      },
      { taskId: 'legacy', attempt: 1, stage: 'worker', action: 'started', at: date(3) },
    ],
    [task('t1')],
  );
  expect(result.overBudgetLaunchesByLayer).toEqual({ role: 1, total: 1, opening: 1 });
});

test('incomplete lifecycle phases remain unknown instead of receiving inferred timestamps', () => {
  const events: any[] = [
    { taskId: 't1', attempt: 0, stage: 'dispatch', action: 'dispatched', at: date(0) },
    { taskId: 't1', attempt: 1, stage: 'worker', action: 'started', at: date(1) },
    { taskId: 't1', attempt: 1, stage: 'check', action: 'requested', at: date(2) },
  ];
  const result = flowReport(events, [{ ...task('t1'), currentAttempt: 1 }], Date.parse(date(20)));
  expect(result.stages.find((s) => s.stage === 'check')).toMatchObject({
    count: 0,
    totalMs: 0,
    p50Ms: null,
    p90Ms: null,
  });
  expect(result.tasks[0]?.workingMs).toBeNull();
  expect(result.queues.find((q) => q.stage === 'check')).toMatchObject({ length: 1, tasks: ['t1'] });
});

test('live queues use the current attempt and settle legacy starts only from observed worker evidence', () => {
  const events: any[] = [
    { taskId: 'retry', attempt: 1, stage: 'start', action: 'requested', at: date(1) },
    { taskId: 'retry', attempt: 2, stage: 'start', action: 'requested', at: date(2) },
    { taskId: 'retry', attempt: 2, stage: 'start', action: 'started', at: date(3) },
    { taskId: 'resumed', attempt: 3, stage: 'start', action: 'requested', at: date(4) },
    { taskId: 'resumed', attempt: 3, stage: 'worker', action: 'started', at: date(5) },
    { taskId: 'unmatched', attempt: 4, stage: 'start', action: 'requested', at: date(6) },
    { taskId: 'promotion', attempt: 1, stage: 'promotion', action: 'requested', at: date(7) },
  ];
  const report = flowReport(
    events,
    [
      { ...task('retry'), currentAttempt: 2, terminalState: 'running' },
      { ...task('resumed'), currentAttempt: 3, terminalState: 'running' },
      { ...task('unmatched'), currentAttempt: 4, terminalState: 'running' },
      { ...task('promotion'), currentAttempt: 2, terminalState: 'integrated' },
    ],
    Date.parse(date(20)),
  );

  expect(report.queues.find((queue) => queue.stage === 'start')).toMatchObject({
    length: 1,
    oldestAgeMs: 14 * 60_000,
    tasks: ['unmatched'],
  });
  expect(report.queues.find((queue) => queue.stage === 'promotion')).toMatchObject({
    length: 1,
    tasks: ['promotion'],
  });
  expect(report.stages.find((stage) => stage.stage === 'start')).toMatchObject({ count: 1, totalMs: 60_000 });
});

test('one ordered interval index keeps equal-time reports and does linear work after sorting', () => {
  const now = Date.parse(date(20));
  const measure = (copies: number) => {
    let visits = 0;
    const events: any[] = [];
    const tasks: (ReturnType<typeof task> & Pick<FlowTask, 'terminalState'>)[] = [];
    const add = (event: { taskId: string; attempt: number; stage: string; action: string; at: string }) => {
      const taskId = event.taskId;
      events.push(
        Object.defineProperty({ ...event }, 'taskId', {
          configurable: true,
          enumerable: true,
          get() {
            visits += 1;
            return taskId;
          },
        }),
      );
    };
    for (let i = 0; i < copies; i++) {
      const id = `live-${i}`;
      const cancelled = `stopped-${i}`;
      const reverse = `equal-${i}`;
      const promo = `promo-${i}`;
      tasks.push(
        { ...task(id), currentAttempt: 1, terminalState: 'running' },
        { ...task(cancelled), currentAttempt: 1, terminalState: 'cancelled' },
        { ...task(reverse), currentAttempt: 1, terminalState: 'running' },
        { ...task(promo), currentAttempt: 1, terminalState: 'running' },
      );
      add({ taskId: id, attempt: 1, stage: 'start', action: 'requested', at: date(1) });
      add({ taskId: id, attempt: 1, stage: 'start', action: 'started', at: date(1) });
      add({ taskId: id, attempt: 1, stage: 'start', action: 'requested', at: date(2) });
      add({ taskId: id, attempt: 1, stage: 'check', action: 'requested', at: date(3) });
      add({ taskId: id, attempt: 1, stage: 'check', action: 'closed', at: date(4) });
      add({ taskId: id, attempt: 1, stage: 'worker', action: 'started', at: date(3) });
      add({ taskId: id, attempt: 1, stage: 'landing', action: 'enqueued', at: date(5) });
      add({ taskId: id, attempt: 1, stage: 'landing', action: 'finished', at: date(8) });
      add({ taskId: promo, attempt: 1, stage: 'verification', action: 'requested', at: date(9) });
      add({ taskId: promo, attempt: 1, stage: 'integration', action: 'integrated', at: date(9) });
      add({ taskId: promo, attempt: 1, stage: 'promotion', action: 'requested', at: date(10) });
      add({ taskId: cancelled, attempt: 1, stage: 'check', action: 'requested', at: date(1) });
      add({ taskId: reverse, attempt: 1, stage: 'start', action: 'started', at: date(1) });
      add({ taskId: reverse, attempt: 1, stage: 'start', action: 'requested', at: date(1) });
    }
    return { report: flowReport(events, tasks, now), visits, n: events.length };
  };
  const small = measure(8);
  const large = measure(32);
  expect(small.report.queues.find((q) => q.stage === 'start')?.length).toBe(8);
  expect(small.report.queues.find((q) => q.stage === 'check')?.length).toBe(0);
  expect(small.report.queues.find((q) => q.stage === 'landing')?.length).toBe(0);
  expect(small.report.queues.find((q) => q.stage === 'verification')?.length).toBe(0);
  expect(small.report.queues.find((q) => q.stage === 'promotion')?.length).toBe(8);
  expect(small.report.bottleneck).toBe('start');
  expect(small.report.stages.find((s) => s.stage === 'landing')).toMatchObject({ count: 8, totalMs: 1_440_000 });
  expect(small.report.tasks.every((t) => t.workingMs === null)).toBe(true);
  expect(large.report.queues.find((q) => q.stage === 'start')?.length).toBe(32);
  expect(large.report.queues.find((q) => q.stage === 'promotion')?.length).toBe(32);
  expect(large.visits / large.n).toBeLessThanOrEqual(small.visits / small.n + 2);
  expect(large.visits / small.visits).toBeLessThan(5);
});

test('retry and closure events cannot create timed intervals from unrelated endpoints', () => {
  const events: any[] = [
    { taskId: 't1', attempt: 0, stage: 'dispatch', action: 'dispatched', at: date(0) },
    { taskId: 't1', attempt: 1, stage: 'start', action: 'requested', at: date(1) },
    { taskId: 't1', attempt: 0, stage: 'worker', action: 'started', at: date(2) },
    { taskId: 't1', attempt: 0, stage: 'check', action: 'requested', at: date(3) },
    { taskId: 't1', attempt: 1, stage: 'worker', action: 'finished', at: date(5) },
    { taskId: 't1', attempt: 1, stage: 'check', action: 'acquired', at: date(6) },
    { taskId: 't1', attempt: 1, stage: 'check', action: 'released', at: date(7) },
    { taskId: 't1', attempt: 2, stage: 'worker', action: 'started', at: date(8) },
    { taskId: 't1', attempt: 2, stage: 'check', action: 'requested', at: date(8) },
    { taskId: 't1', attempt: 2, stage: 'worker', action: 'closed', at: date(9) },
    { taskId: 't1', attempt: 2, stage: 'check', action: 'closed', at: date(9) },
    { taskId: 't1', attempt: 2, stage: 'worker', action: 'finished', at: date(12) },
    { taskId: 't1', attempt: 2, stage: 'check', action: 'acquired', at: date(12) },
    { taskId: 't1', attempt: 2, stage: 'check', action: 'released', at: date(13) },
  ];
  const report = flowReport(events, [task('t1')], Date.parse(date(20)));
  expect(report.stages.find((stage) => stage.stage === 'dispatch')?.count).toBe(0);
  expect(report.stages.find((stage) => stage.stage === 'worker')?.count).toBe(0);
  expect(report.stages.find((stage) => stage.stage === 'check')?.count).toBe(0);
  expect(report.tasks[0]?.workingMs).toBeNull();
});

test('the manager host evaluates absolute thresholds and sends one supermanager environment alarm per breached threshold per hour', () => {
  const db = openDb(':memory:');
  ensureFlow(db);
  const report: any = {
    flowEfficiency: 0.2,
    queues: [{ stage: 'landing', length: 1, oldestAgeMs: 4_000_000, tasks: ['a', 'b', 'c', 'd'] }],
    stages: [{ stage: 'landing', p90Ms: 2_000_000 }],
    attemptsPerIntegrated: 2,
    attemptsPerIntegratedSample: {
      window: 'trailing 7 days',
      integratedTasks: 1,
      attemptGenerations: 2,
      attemptsPerIntegrated: 2,
    },
  };
  const sent: string[] = [];
  const thresholds = {
    efficiencyBelow: 0.4,
    oldestQueueMs: 3_600_000,
    landingP90Ms: 1_800_000,
    attemptsPerIntegrated: 1.5,
  };
  expect(checkFlowAlarms(db, report, (s) => sent.push(s), new Date(date(0)), thresholds)).toHaveLength(4);
  expect(
    checkFlowAlarms(db, report, (s) => sent.push(s), new Date(Date.parse(date(0)) + 30 * 60_000), thresholds),
  ).toEqual([]);
  expect(sent.every((s) => s.includes('stage') && s.includes('measurement') && s.includes('a, b, c'))).toBe(true);
  db.close();
});

test('once a day the manager host dispatches the daily step audit unless one is already open', () => {
  const db = openDb(':memory:');
  ensureFlow(db);
  const dispatch = () => task('audit', 'daily-step-audit');
  expect(dispatchDailyStepAudit(db, [], dispatch, new Date(date(0)))?.id).toBe('audit');
  expect(dispatchDailyStepAudit(db, [], dispatch, new Date(date(1)))).toBeNull();
  const tomorrow = new Date(Date.parse(date(0)) + 86400_000);
  expect(
    dispatchDailyStepAudit(db, [{ ...task('open', 'daily-step-audit'), state: 'running' }], dispatch, tomorrow),
  ).toBeNull();
  db.close();
});

// These fixtures intentionally use the real risk parser, SQLite store and inbox boundaries.
import { readFileSync } from 'node:fs';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerStore } from './store.ts';
import { readFlowTasks } from './flow.ts';
import { temporaryDirectory } from './test-support.ts';

const ownership = () => readRiskOwnership(join(import.meta.dir, '../risk-areas.json'));
const auditTemplate = () => readFileSync(join(import.meta.dir, '../templates/daily-step-audit.md'), 'utf8');

test('flow task reads use the authoritative current-attempt column', () => {
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    const created = store.createTask(
      task('snapshot').brief,
      { branch: 'b', worktree: 'w', briefPath: 'p', base: 'c' },
      'implementation',
    );
    db.query('UPDATE worker_tasks SET current_attempt=?, body=? WHERE id=?').run(
      2,
      JSON.stringify({ ...created, currentAttempt: 1 }),
      created.id,
    );
    expect(readFlowTasks(db).find((row) => row.id === created.id)?.currentAttempt).toBe(2);
  } finally {
    db.close();
  }
});

test('real daily audit template passes risk validation for tomorrow without broader privileges', () => {
  const brief = parseBrief(auditTemplate(), ownership());
  expect(brief.riskAreas).toEqual([]);
  expect(brief.paths).toEqual(['tools/goal/reports/daily-step-audit-*.md']);
  expect(brief.acceptance.command).toEqual([]);
  expect(brief.acceptance.tests).toEqual([]);
  const db = openDb(':memory:');
  try {
    const tomorrow = new Date(Date.parse(date(0)) + 86400_000);
    expect(dispatchDailyStepAudit(db, [], () => ({ ...task('tomorrow'), brief }), tomorrow)?.brief).toEqual(brief);
  } finally {
    db.close();
  }
});

test('daily audit parse and dispatch failures retain their causes across reopen and report exactly once', () => {
  for (const failure of ['parse', 'dispatch']) {
    const dir = temporaryDirectory();
    const path = join(dir.path, 'audit.sqlite');
    let db = openDb(path);
    let calls = 0;
    const dispatch = (): Task => {
      calls++;
      if (failure === 'parse') parseBrief(auditTemplate().replace('daily-step-audit-*.md', '**'), ownership());
      throw new Error('dispatch fixture: worktree unavailable\noriginal cause');
    };
    try {
      let inbox = new SqliteManagerInbox(db, dir.path);
      const report = (summary: string) => inbox.deliver({ managerId: 'supermanager', kind: 'environment', summary });
      expect(dispatchDailyStepAudit(db, [], dispatch, new Date(date(0)), report)).toBeNull();
      const cause = (db.query('SELECT cause FROM flow_audit_failures').get() as { cause: string }).cause;
      expect(cause).toContain(failure === 'parse' ? 'declared paths touch undeclared risk area' : 'original cause');
      expect(cause).toContain('flow.test.ts');
      db.close();
      db = openDb(path);
      inbox = new SqliteManagerInbox(db, dir.path);
      expect(dispatchDailyStepAudit(db, [], dispatch, new Date(date(1)), report)).toBeNull();
      expect(calls).toBe(1);
      expect(inbox.pending('supermanager')).toHaveLength(1);
      expect(inbox.pending('supermanager')[0]!.event.summary).toContain(
        failure === 'parse' ? 'undeclared risk area' : 'original cause',
      );
      expect(inbox.pending('supermanager')[0]!.event.summary).not.toMatch(/[\r\n]/);
    } finally {
      db.close();
      dir.close();
    }
  }
});

test('a failed audit notice delivery is retried durably without redispatching the audit', () => {
  const dir = temporaryDirectory();
  const db = openDb(join(dir.path, 'retry.sqlite'));
  const inbox = new SqliteManagerInbox(db, dir.path);
  let calls = 0;
  try {
    dispatchDailyStepAudit(
      db,
      [],
      () => {
        calls++;
        throw new Error('original dispatch failure');
      },
      new Date(date(0)),
      () => {
        throw new Error('inbox unavailable');
      },
    );
    expect(
      (db.query('SELECT reported_at FROM flow_audit_failures').get() as { reported_at: string | null }).reported_at,
    ).toBeNull();
    dispatchDailyStepAudit(
      db,
      [],
      () => {
        calls++;
        return task('wrong');
      },
      new Date(date(1)),
      (summary) => inbox.deliver({ managerId: 'supermanager', kind: 'environment', summary }),
    );
    expect(calls).toBe(1);
    expect(inbox.pending('supermanager')).toHaveLength(1);
    expect(inbox.pending('supermanager')[0]!.event.summary).toContain('original dispatch failure');
  } finally {
    db.close();
    dir.close();
  }
});

test('integration and cancellation close open stages idempotently without inventing completions', () => {
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    for (const state of ['integrated', 'cancelled'] as const) {
      const t = store.createTask(
        task(state).brief,
        { branch: 'b', worktree: 'w', briefPath: 'p', base: 'c' },
        'implementation',
        state,
      );
      for (const stage of ['start', 'check', 'landing', 'verification'] as const)
        recordFlow(db, {
          taskId: t.id,
          attempt: 0,
          stage,
          action: stage === 'landing' ? 'enqueued' : 'requested',
          at: date(0),
        });
      if (state === 'integrated') store.commitMerge({ taskId: t.id, attempt: 0 }, () => 'actual-commit');
      else
        store.updateTask({ taskId: t.id, attempt: 0 }, (current) => {
          current.state = state;
        });
      const count = readFlow(db).filter((e) => e.taskId === t.id && e.action === 'closed').length;
      store.updateTask({ taskId: t.id, attempt: 0 }, () => {});
      expect(readFlow(db).filter((e) => e.taskId === t.id && e.action === 'closed')).toHaveLength(count);
      expect(count).toBeGreaterThanOrEqual(4);
    }
    const report = flowReport(readFlow(db), readFlowTasks(db), Date.parse(date(180)));
    expect(report.queues.every((q) => q.length === 0)).toBe(true);
    expect(report.stages.find((s) => s.stage === 'check')?.p90Ms).toBeNull();
    expect(report.stages.find((s) => s.stage === 'verification')?.p90Ms).toBeNull();
    expect(
      checkFlowAlarms(
        db,
        report,
        () => {
          throw new Error('stale alarm');
        },
        new Date(date(180)),
      ),
    ).toEqual([]);
  } finally {
    db.close();
  }
});

test('legacy terminal tasks suppress stale queues while live workers and post-integration promotion remain visible', () => {
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    for (const state of ['integrated', 'merged', 'cancelled', 'running'] as const) {
      const t = store.createTask(
        task(state).brief,
        { branch: 'b', worktree: 'w', briefPath: 'p', base: 'c' },
        'implementation',
        state,
      );
      // Legacy rows deliberately bypass the new closure writer.
      db.query('UPDATE worker_tasks SET body=? WHERE id=?').run(JSON.stringify({ ...t, state }), t.id);
      for (const stage of ['check', 'promotion'] as const)
        recordFlow(db, { taskId: t.id, attempt: 0, stage, action: 'requested', at: date(0) });
    }
    const events = readFlow(db);
    const report = flowReport(events, readFlowTasks(db), Date.parse(date(180)));
    expect(report.queues.find((q) => q.stage === 'check')?.tasks).toEqual(['running']);
    expect(report.queues.find((q) => q.stage === 'promotion')?.tasks).toEqual(['integrated', 'running']);
    expect(report.tasks.every((t) => t.workingMs === null)).toBe(true);
    expect(readFlow(db)).toEqual(events);
  } finally {
    db.close();
  }
});

test('flow alarm overrides cap examples and permit another alarm exactly at the configured interval', () => {
  const db = openDb(':memory:');
  const policy = readControlPolicy({ flow: { alertEveryMs: 25, waitingTaskExamples: 1 } });
  const now = Date.parse(date(0));
  const report = flowReport([], [task('a'), task('b')], now);
  report.flowEfficiency = 0;
  report.queues = [{ stage: 'landing', length: 2, oldestAgeMs: 1, tasks: ['a', 'b'] }];
  const sent: string[] = [];
  const run = (offset: number) =>
    checkFlowAlarms(db, report, (s) => sent.push(s), new Date(now + offset), undefined, policy);
  try {
    expect([run(0).length, run(24).length, run(25).length]).toEqual([1, 0, 1]);
    expect(sent.every((s) => s.endsWith('top waiting tasks a'))).toBe(true);
  } finally {
    db.close();
  }
});

test('unchanged global alarms with no waiting tasks stay quiet after delivery, without changing the report metric', () => {
  const db = openDb(':memory:');
  const policy = readControlPolicy({ flow: { alertEveryMs: 25 } });
  const now = Date.parse(date(0));
  const report = flowReport([], [], now);
  report.flowEfficiency = 0;
  const sent: string[] = [];
  const run = (offset: number) =>
    checkFlowAlarms(db, report, (summary) => sent.push(summary), new Date(now + offset), undefined, policy);
  try {
    expect(() =>
      checkFlowAlarms(
        db,
        report,
        () => {
          throw new Error('inbox unavailable');
        },
        new Date(now),
        undefined,
        policy,
      ),
    ).toThrow('inbox unavailable');
    expect([run(0).length, run(25).length, run(1000).length]).toEqual([1, 0, 0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('flow efficiency 0.0%');
    expect(report.flowEfficiency).toBe(0);
  } finally {
    db.close();
  }
});

test('the recent retry alarm ignores older history and same-attempt launches but rearms on a changed ratio', () => {
  const db = openDb(':memory:');
  const policy = readControlPolicy({ flow: { alertEveryMs: 10_000 } });
  const now = Date.parse(date(0));
  const report = flowReport([], [], now);
  const sample = (integratedTasks: number, attemptGenerations: number) => ({
    window: 'trailing 7 days',
    windowMs: 7 * 24 * 60 * 60 * 1000,
    integratedTasks,
    attemptGenerations,
    attemptsPerIntegrated: attemptGenerations / integratedTasks,
  });
  report.attemptsPerIntegrated = 3.67;
  report.attemptsPerIntegratedSample = sample(3, 11);
  const empty = report.queues[1]!;
  const waiting = { stage: 'check' as const, length: 1, oldestAgeMs: 1, tasks: ['waiting-task'] };
  const sent: string[] = [];
  const run = (offset: number) =>
    checkFlowAlarms(db, report, (summary) => sent.push(summary), new Date(now + offset), undefined, policy);
  try {
    report.queues[1] = waiting;
    expect(run(0)).toEqual(['attempts-per-integrated']);
    expect(sent[0]).toContain('trailing 7 days (3 integrated tasks; 11 attempt generations)');
    report.queues[1] = empty;
    expect(run(1)).toEqual([]);
    report.queues[1] = { ...waiting, tasks: ['next-task'] };
    expect(run(2)).toEqual([]);
    report.attemptsPerIntegrated = 99;
    report.workerProcessLaunches++;
    report.attemptsPerIntegratedSample = sample(6, 22);
    expect(run(3)).toEqual([]);
    const changes = db.query('SELECT total_changes() AS changes').get();
    expect(run(10_003)).toEqual([]);
    expect(db.query('SELECT total_changes() AS changes').get()).toEqual(changes);
    expect(sent).toHaveLength(1);
    expect(report.attemptsPerIntegrated).toBe(99);
    report.attemptsPerIntegratedSample = sample(6, 24);
    expect(run(10_004)).toEqual(['attempts-per-integrated']);
  } finally {
    db.close();
  }
});

test('global alarms rearm on a changed measurement, new waiting task and recovery', () => {
  const db = openDb(':memory:');
  const policy = readControlPolicy({ flow: { alertEveryMs: 10_000 } });
  const now = Date.parse(date(0));
  const report = flowReport([], [], now);
  report.flowEfficiency = 0.1;
  const sent: string[] = [];
  const run = (offset: number) =>
    checkFlowAlarms(db, report, (summary) => sent.push(summary), new Date(now + offset), undefined, policy);
  try {
    expect(run(0)).toEqual(['flow-efficiency']);
    report.flowEfficiency = 0.2;
    expect(run(1)).toEqual(['flow-efficiency']);
    report.queues[1] = { stage: 'check', length: 1, oldestAgeMs: 1, tasks: ['new-waiting-task'] };
    expect(run(2)).toEqual(['flow-efficiency']);
    expect(sent.at(-1)).toContain('new-waiting-task');

    report.flowEfficiency = 0.5;
    expect(run(3)).toEqual([]);
    report.flowEfficiency = 0.2;
    expect(run(4)).toEqual(['flow-efficiency']);
    expect(sent).toHaveLength(4);
  } finally {
    db.close();
  }
});

test('actionable queue alarms keep interval escalation when waiting-task details change', () => {
  const db = openDb(':memory:');
  const policy = readControlPolicy({ flow: { alertEveryMs: 25 } });
  const now = Date.parse(date(0));
  const report = flowReport([], [], now);
  report.queues[1] = { stage: 'check', length: 1, oldestAgeMs: 60_000, tasks: ['first'] };
  const sent: string[] = [];
  const run = (offset: number) =>
    checkFlowAlarms(
      db,
      report,
      (summary) => sent.push(summary),
      new Date(now + offset),
      { efficiencyBelow: 0, oldestQueueMs: 0, landingP90Ms: 1_000_000, attemptsPerIntegrated: 10 },
      policy,
    );
  try {
    expect(run(0)).toEqual(['queue-check']);
    report.queues[1] = { stage: 'check', length: 2, oldestAgeMs: 120_000, tasks: ['first', 'new'] };
    expect(run(1)).toEqual([]);
    expect(run(25)).toEqual(['queue-check']);
    expect(sent).toHaveLength(2);
  } finally {
    db.close();
  }
});

test.each([null, `v1:${'0'.repeat(64)}`])(
  'legacy flow-alarm rows keep their cooldown and remain readable by old queries (%s)',
  (fingerprint) => {
    const db = openDb(':memory:');
    const policy = readControlPolicy({ flow: { alertEveryMs: 25 } });
    const now = Date.parse(date(0));
    const report = flowReport([], [], now);
    report.flowEfficiency = 0;
    ensureFlow(db);
    db.query('INSERT INTO flow_alarm_sends(threshold,sent_at,fingerprint) VALUES (?,?,?)').run(
      'flow-efficiency',
      new Date(now).toISOString(),
      fingerprint,
    );
    const oldReader = db.query('SELECT sent_at FROM flow_alarm_sends WHERE threshold=?').get('flow-efficiency') as {
      sent_at: string;
    };
    try {
      expect(oldReader.sent_at).toBe(new Date(now).toISOString());
      const run = (offset: number) => checkFlowAlarms(db, report, () => {}, new Date(now + offset), undefined, policy);
      expect(run(24)).toEqual([]);
      expect(run(25)).toEqual([]);
      expect(
        db.query('SELECT fingerprint, active FROM flow_alarm_sends WHERE threshold=?').get('flow-efficiency'),
      ).toMatchObject({
        fingerprint: expect.any(String),
        active: 1,
      });
    } finally {
      db.close();
    }
  },
);

test('flow alarms use distinct examples from the breached queue and oldest distinct tasks for global alarms', () => {
  const db = openDb(':memory:');
  const policy = readControlPolicy({ flow: { waitingTaskExamples: 3 } });
  const report = flowReport([], [task('a'), task('b')], Date.parse(date(0)));
  report.flowEfficiency = 0.2;
  report.queues = [
    { stage: 'start', length: 3, oldestAgeMs: 300, tasks: ['shared', 'start-only', 'shared'] },
    { stage: 'check', length: 4, oldestAgeMs: 200, tasks: ['shared', 'check-only', 'check-only', 'check-second'] },
    { stage: 'landing', length: 1, oldestAgeMs: 100, tasks: ['landing-only'] },
    { stage: 'verification', length: 0, oldestAgeMs: 0, tasks: [] },
    { stage: 'promotion', length: 0, oldestAgeMs: 0, tasks: [] },
  ];
  const sent: string[] = [];
  try {
    expect(
      checkFlowAlarms(
        db,
        report,
        (summary) => sent.push(summary),
        new Date(date(0)),
        { efficiencyBelow: 0.4, oldestQueueMs: 50, landingP90Ms: 10_000, attemptsPerIntegrated: 10 },
        policy,
      ),
    ).toEqual(['flow-efficiency', 'queue-start', 'queue-check', 'queue-landing']);
    expect(sent.find((summary) => summary.includes('stage check'))).toContain(
      'top waiting tasks shared, check-only, check-second',
    );
    expect(sent.find((summary) => summary.includes('stage landing'))).toContain('top waiting tasks landing-only');
    expect(sent.find((summary) => summary.includes('flow efficiency'))).toContain(
      'top waiting tasks shared, start-only, check-only',
    );
    expect(report.queues.find((queue) => queue.stage === 'check')?.length).toBe(4);
  } finally {
    db.close();
  }
});
