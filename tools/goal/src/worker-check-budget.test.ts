import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startWorkerCheck, workerCheckNeedsStack } from '../../../scripts/worker-check.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { brief, temporaryDirectory } from './test-support.ts';
import type { Attempt, Settings } from './types.ts';
import { runWorkerCommand } from './worker-commands.ts';
import type { WorkerTasks } from './tasks.ts';
import {
  admitWorkerCheckHostRun,
  refuseExcessWorkerCheckHostRun,
  workerCheckBudgetDirectory,
  workerCheckHostBudgetLimit,
  workerCheckHostRunsUsed,
  WORKER_CHECK_HOST_BUDGET_REFUSAL,
  WORKER_CHECK_HOST_RUN_LIMIT,
} from './worker-check-budget.ts';

const product = { brief: { goal: 'web', kind: 'implementation' as const } };

test('a worker attempt may start one check-host run and one rerun; a third request is refused before any host is reserved', () => {
  const directory = temporaryDirectory();
  try {
    const budget = workerCheckBudgetDirectory(directory.path, 'task', 1);
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2 })).toEqual({ ok: true, used: 1 });
    expect(admitWorkerCheckHostRun({ directory: budget, limit: '2' })).toEqual({ ok: true, used: 2 });
    const third = admitWorkerCheckHostRun({ directory: budget, limit: 2 });
    expect(third).toEqual({
      ok: false,
      used: 2,
      message: WORKER_CHECK_HOST_BUDGET_REFUSAL,
    });
    expect(third.ok ? '' : third.message).toBe(WORKER_CHECK_HOST_BUDGET_REFUSAL);
    expect(third.ok ? '' : third.message.split('\n')).toHaveLength(1);
    expect(readdirSync(budget).sort()).toEqual(['1', '2']);
    expect(workerCheckHostRunsUsed(budget)).toBe(2);
  } finally {
    directory.close();
  }
});

test('the count is per attempt and lives in controller state, not the worktree', () => {
  const controller = temporaryDirectory();
  const worktree = temporaryDirectory();
  try {
    const first = workerCheckBudgetDirectory(controller.path, 'task', 1);
    const second = workerCheckBudgetDirectory(controller.path, 'task', 2);
    const other = workerCheckBudgetDirectory(controller.path, 'other', 1);
    expect(admitWorkerCheckHostRun({ directory: first, limit: 2 }).ok).toBe(true);
    expect(admitWorkerCheckHostRun({ directory: first, limit: 2 }).ok).toBe(true);
    expect(admitWorkerCheckHostRun({ directory: first, limit: 2 }).ok).toBe(false);
    expect(admitWorkerCheckHostRun({ directory: second, limit: 2 })).toEqual({ ok: true, used: 1 });
    expect(admitWorkerCheckHostRun({ directory: other, limit: 2 })).toEqual({ ok: true, used: 1 });
    expect(workerCheckHostRunsUsed(join(worktree.path, 'runs', 'task', '1.check-host-runs'))).toBe(0);
    expect(first.startsWith(controller.path)).toBe(true);
    expect(first.includes(worktree.path)).toBe(false);
  } finally {
    controller.close();
    worktree.close();
  }
});

test('proof-run, registered-proof, acceptance-requiring, urgent and control-plane tasks are exempt', () => {
  expect(workerCheckHostBudgetLimit(product, 1)).toBe(WORKER_CHECK_HOST_RUN_LIMIT);
  expect(workerCheckHostBudgetLimit({ brief: { goal: 'web', kind: 'implementation', urgent: true } }, 1)).toBe('off');
  expect(workerCheckHostBudgetLimit({ brief: { goal: 'control-plane', kind: 'implementation' } }, 1)).toBe('off');
  expect(
    workerCheckHostBudgetLimit({
      brief: { goal: 'web', kind: 'implementation', acceptance: { requires: ['browser'] } },
    }),
  ).toBe('off');
  expect(
    workerCheckHostBudgetLimit(
      {
        brief: { goal: 'web', kind: 'verification' },
        proofRun: { binding: { attempt: 2 } },
      },
      2,
    ),
  ).toBe('off');
  expect(
    workerCheckHostBudgetLimit(
      {
        brief: { goal: 'web', kind: 'verification' },
        proofRun: { binding: { attempt: 1 } },
      },
      2,
    ),
  ).toBe(WORKER_CHECK_HOST_RUN_LIMIT);
  expect(
    workerCheckHostBudgetLimit({
      brief: { goal: 'web', kind: 'verification' },
      proofAuthorization: { fingerprint: 'owned' },
    }),
  ).toBe('off');
  const directory = temporaryDirectory();
  try {
    const budget = workerCheckBudgetDirectory(directory.path, 'urgent', 1);
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 'off' })).toEqual({ ok: true, used: 1 });
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 'off' })).toEqual({ ok: true, used: 2 });
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 'off' })).toEqual({ ok: true, used: 3 });
  } finally {
    directory.close();
  }
});

test('status shows checks used per running attempt', async () => {
  const directory = temporaryDirectory();
  const db = openDb(':memory:');
  try {
    const store = new WorkerStore(db);
    const task = store.createTask(
      brief(),
      { briefPath: join(directory.path, 'brief.md'), worktree: '/work', branch: 'worker/task', base: 'a'.repeat(40) },
      'implementation',
      'task',
    );
    const attempt = {
      taskId: task.id,
      attempt: 1,
      state: 'running',
      profile: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', poolClass: 'default' },
      pool: 'fixture',
      tableVersion: '1',
      experiment: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      process: null,
      driver: null,
      logPath: 'log',
      evidencePath: 'evidence',
      auxiliaryProcesses: [],
      session: null,
      fixRound: 0,
      consulted: false,
      previousFailure: null,
      failure: null,
      escalation: null,
      before: null,
      after: null,
      exitCode: null,
      result: '',
      blocker: null,
      approaches: [],
    } as Attempt;
    db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
      task.id,
      1,
      JSON.stringify(attempt),
    );
    db.query("UPDATE worker_tasks SET current_attempt=1, body=json_set(body, '$.currentAttempt', 1) WHERE id=?").run(
      task.id,
    );
    db.query("UPDATE worker_tasks SET body=json_set(body, '$.state', 'running') WHERE id=?").run(task.id);
    const live = new WorkerStore(db);
    const budget = workerCheckBudgetDirectory(directory.path, task.id, 1);
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2 })).toEqual({ ok: true, used: 1 });
    const output: string[] = [];
    const code = await runWorkerCommand('status', [task.id], {
      settings: { stateDirectory: directory.path, mainCheckout: directory.path, integrationBranch: 'dev' } as Settings,
      tasks: { settings: { stateDirectory: directory.path }, store: live } as unknown as WorkerTasks,
      store: live,
      env: {},
      print: (value) => output.push(value),
    });
    expect(code).toBe(0);
    const status = JSON.parse(output[0]!) as { checksUsed: number; checkBudget: number | 'off'; state: string };
    expect(status.checksUsed).toBe(1);
    expect(status.checkBudget).toBe(WORKER_CHECK_HOST_RUN_LIMIT);
  } finally {
    db.close();
    directory.close();
  }
});

test('the wrapper refuses a third check-host request before it writes a check record', () => {
  const directory = temporaryDirectory();
  const previousBudget = process.env.GOAL_WORKER_CHECK_BUDGET;
  const previousDirectory = process.env.GOAL_WORKER_CHECK_BUDGET_DIR;
  try {
    mkdirSync(join(directory.path, 'scripts'), { recursive: true });
    writeFileSync(join(directory.path, 'scripts/worker-check.ts'), '');
    const budget = workerCheckBudgetDirectory(directory.path, 'task', 3);
    mkdirSync(budget, { recursive: true });
    writeFileSync(join(budget, '1'), '');
    writeFileSync(join(budget, '2'), '');
    const command = ['make', 'check'];
    expect(workerCheckNeedsStack(command, directory.path)).toBe(true);
    process.env.GOAL_WORKER_CHECK_BUDGET = '2';
    process.env.GOAL_WORKER_CHECK_BUDGET_DIR = budget;
    expect(() => startWorkerCheck(command, directory.path)).toThrow(WORKER_CHECK_HOST_BUDGET_REFUSAL);
    expect(existsSync(join(directory.path, '.temp/goal/checks'))).toBe(false);
    expect(() => refuseExcessWorkerCheckHostRun({ GOAL_WORKER_CHECK_BUDGET_DIR: budget }, false)).not.toThrow();
  } finally {
    if (previousBudget === undefined) delete process.env.GOAL_WORKER_CHECK_BUDGET;
    else process.env.GOAL_WORKER_CHECK_BUDGET = previousBudget;
    if (previousDirectory === undefined) delete process.env.GOAL_WORKER_CHECK_BUDGET_DIR;
    else process.env.GOAL_WORKER_CHECK_BUDGET_DIR = previousDirectory;
    directory.close();
  }
});
