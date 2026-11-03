import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { checkFlowAlarms, dispatchDailyStepAudit, ensureFlow, flowReport, readFlow, recordFlow } from './flow.ts';
import type { Task } from './types.ts';

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
});

test('incomplete lifecycle phases remain unknown instead of receiving inferred timestamps', () => {
  const events: any[] = [
    { taskId: 't1', attempt: 0, stage: 'dispatch', action: 'dispatched', at: date(0) },
    { taskId: 't1', attempt: 1, stage: 'worker', action: 'started', at: date(1) },
    { taskId: 't1', attempt: 1, stage: 'check', action: 'requested', at: date(2) },
  ];
  const result = flowReport(events, [task('t1')], Date.parse(date(20)));
  expect(result.stages.find((s) => s.stage === 'check')).toMatchObject({
    count: 0,
    totalMs: 0,
    p50Ms: null,
    p90Ms: null,
  });
  expect(result.tasks[0]?.workingMs).toBeNull();
  expect(result.queues.find((q) => q.stage === 'check')).toMatchObject({ length: 1, tasks: ['t1'] });
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

test('real daily audit template passes risk validation for tomorrow without broader privileges', () => {
  const brief = parseBrief(auditTemplate(), ownership());
  expect(brief.riskAreas).toEqual([]);
  expect(brief.paths).toEqual(['tools/goal/reports/daily-step-audit-*.md']);
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
