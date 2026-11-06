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
  classifyOrdinaryProductCommand,
  ordinaryProductCheckRefusal,
  refuseExcessWorkerCheckHostRun,
  refuseOrdinaryProductTestCheck,
  settleWorkerCheckHostBudget,
  verifierFailureRevertsLanding,
  workerCheckBudgetDirectory,
  workerCheckHostBudgetLimit,
  workerCheckHostCommandReached,
  workerCheckHostRunsUsed,
  WORKER_CHECK_HOST_BUDGET_REFUSAL,
  WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT,
  WORKER_CHECK_HOST_RUN_LIMIT,
  WORKER_CHECK_TESTS_AFTER_LANDING,
} from './worker-check-budget.ts';

const product = { brief: { goal: 'web', kind: 'implementation' as const } };

test('a worker attempt may start one check-host run and one rerun; a third request is refused before any host is reserved', () => {
  const directory = temporaryDirectory();
  try {
    const budget = workerCheckBudgetDirectory(directory.path, 'task', 1);
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2 })).toEqual({ ok: true, used: 1, stamp: '1' });
    expect(admitWorkerCheckHostRun({ directory: budget, limit: '2' })).toEqual({ ok: true, used: 2, stamp: '2' });
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
    expect(admitWorkerCheckHostRun({ directory: second, limit: 2 })).toEqual({ ok: true, used: 1, stamp: '1' });
    expect(admitWorkerCheckHostRun({ directory: other, limit: 2 })).toEqual({ ok: true, used: 1, stamp: '1' });
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
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 'off' })).toEqual({ ok: true, used: 1, stamp: '1' });
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 'off' })).toEqual({ ok: true, used: 2, stamp: '2' });
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 'off' })).toEqual({ ok: true, used: 3, stamp: '3' });
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
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2 })).toEqual({ ok: true, used: 1, stamp: '1' });
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
    const command = ['bun', 'scripts/typecheck.ts'];
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

test('an infrastructure exit 75 before the check command ran gives its budget stamp back', () => {
  const directory = temporaryDirectory();
  try {
    const budget = workerCheckBudgetDirectory(directory.path, 'task', 1);
    const env: NodeJS.ProcessEnv = {
      GOAL_WORKER_CHECK_BUDGET: '2',
      GOAL_WORKER_CHECK_BUDGET_DIR: budget,
    };
    refuseExcessWorkerCheckHostRun(env, true);
    expect(env.GOAL_WORKER_CHECK_BUDGET_STAMP).toBe('1');
    expect(workerCheckHostRunsUsed(budget)).toBe(1);
    expect(workerCheckHostCommandReached(undefined)).toBe(false);
    expect(workerCheckHostCommandReached({ resources: { commandStartedMonoMs: null } })).toBe(false);
    settleWorkerCheckHostBudget(env, WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT, false);
    expect(workerCheckHostRunsUsed(budget)).toBe(0);
    expect(readdirSync(budget)).toEqual([]);
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2 })).toEqual({ ok: true, used: 1, stamp: '1' });
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2 })).toEqual({ ok: true, used: 2, stamp: '2' });
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2 }).ok).toBe(false);
  } finally {
    directory.close();
  }
});

test('runs that reached the check command keep counting, whatever their exit code', () => {
  const directory = temporaryDirectory();
  try {
    const budget = workerCheckBudgetDirectory(directory.path, 'task', 1);
    const env: NodeJS.ProcessEnv = {
      GOAL_WORKER_CHECK_BUDGET: '2',
      GOAL_WORKER_CHECK_BUDGET_DIR: budget,
    };
    expect(workerCheckHostCommandReached({ resources: { commandStartedMonoMs: 12 } })).toBe(true);
    refuseExcessWorkerCheckHostRun(env, true);
    settleWorkerCheckHostBudget(env, WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT, true);
    expect(workerCheckHostRunsUsed(budget)).toBe(1);
    refuseExcessWorkerCheckHostRun(env, true);
    for (const code of [0, 1, 70, 124, WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT]) {
      settleWorkerCheckHostBudget(env, code, true);
      expect(workerCheckHostRunsUsed(budget)).toBe(2);
    }
    settleWorkerCheckHostBudget(env, 1, false);
    expect(workerCheckHostRunsUsed(budget)).toBe(2);
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2 })).toEqual({
      ok: false,
      used: 2,
      message: WORKER_CHECK_HOST_BUDGET_REFUSAL,
    });
  } finally {
    directory.close();
  }
});

test('an ordinary product check is the typecheck of changed workspaces; test, native, browser and growth commands are refused', () => {
  expect(classifyOrdinaryProductCommand(['bun', 'run', '--cwd', 'tools/goal', 'typecheck'])).toBe('typecheck');
  expect(classifyOrdinaryProductCommand(['bun', 'scripts/typecheck.ts'])).toBe('typecheck');
  expect(ordinaryProductCheckRefusal(['bun', 'run', '--cwd', 'apps/web', 'typecheck'], false)).toBeUndefined();
  expect(
    ordinaryProductCheckRefusal(
      ['sh', '-c', 'bun run --cwd tools/goal typecheck; s=$?; bun scripts/typecheck.ts || s=1; exit $s'],
      false,
    ),
  ).toBeUndefined();
  expect(ordinaryProductCheckRefusal(['bun', 'test', 'apps/web/tests/library.test.ts'], false)).toBe(
    WORKER_CHECK_TESTS_AFTER_LANDING,
  );
  expect(ordinaryProductCheckRefusal(['bun', 'apps/auth/scripts/isolated.ts', 'bun', 'test'], false)).toBe(
    WORKER_CHECK_TESTS_AFTER_LANDING,
  );
  expect(ordinaryProductCheckRefusal(['npx', 'playwright', 'test'], false)).toBe(WORKER_CHECK_TESTS_AFTER_LANDING);
  expect(ordinaryProductCheckRefusal(['env', 'GROWTH_PROFILE=profiles/x', 'bun', 'test', 'x.test.ts'], false)).toBe(
    WORKER_CHECK_TESTS_AFTER_LANDING,
  );
});

test('payment, payout, order settlement, points and balance tests stay in the same check when those paths changed', () => {
  const money = ['bun', 'test', 'services/kernel/test/commerce/work.test.ts'];
  const kernel = ['bun', 'run', '--cwd', 'services/kernel', 'check', 'test/commerce/payouts.test.ts'];
  expect(classifyOrdinaryProductCommand(money)).toBe('money-test');
  expect(classifyOrdinaryProductCommand(kernel)).toBe('money-test');
  expect(ordinaryProductCheckRefusal(money, true)).toBeUndefined();
  expect(ordinaryProductCheckRefusal(kernel, true)).toBeUndefined();
  expect(
    ordinaryProductCheckRefusal(
      [
        'sh',
        '-c',
        'bun run --cwd services/kernel typecheck; s=$?; bun test services/kernel/test/commerce/work.test.ts || s=1; exit $s',
      ],
      true,
    ),
  ).toBeUndefined();
  expect(ordinaryProductCheckRefusal(money, false)).toBe(WORKER_CHECK_TESTS_AFTER_LANDING);
  expect(
    ordinaryProductCheckRefusal(
      ['bun', 'test', 'apps/web/tests/library.test.ts', 'services/kernel/test/commerce/work.test.ts'],
      true,
    ),
  ).toBe(WORKER_CHECK_TESTS_AFTER_LANDING);
});

test('verification, proof-run, control-plane, urgent and requires briefs keep their declared checks', () => {
  expect(workerCheckHostBudgetLimit({ brief: { goal: 'web', kind: 'verification' }, proofAuthorization: {} }, 1)).toBe(
    'off',
  );
  expect(workerCheckHostBudgetLimit({ brief: { goal: 'control-plane', kind: 'implementation' } }, 1)).toBe('off');
  expect(workerCheckHostBudgetLimit({ brief: { goal: 'web', kind: 'implementation', urgent: true } }, 1)).toBe('off');
  expect(
    workerCheckHostBudgetLimit({
      brief: { goal: 'web', kind: 'implementation', acceptance: { requires: ['native'] } },
    }),
  ).toBe('off');
  const directory = temporaryDirectory();
  try {
    const budget = workerCheckBudgetDirectory(directory.path, 'exempt', 1);
    expect(() =>
      refuseOrdinaryProductTestCheck(
        { GOAL_WORKER_CHECK_BUDGET: 'off', GOAL_WORKER_CHECK_BUDGET_DIR: budget },
        ['bun', 'test', 'apps/web/tests/library.test.ts'],
        directory.path,
      ),
    ).not.toThrow();
    expect(() =>
      refuseOrdinaryProductTestCheck(
        { GOAL_WORKER_CHECK_BUDGET: '2', GOAL_WORKER_CHECK_BUDGET_DIR: budget },
        ['bun', 'test', 'apps/web/tests/library.test.ts'],
        directory.path,
      ),
    ).toThrow(WORKER_CHECK_TESTS_AFTER_LANDING);
  } finally {
    directory.close();
  }
});

test('the verifier reverts typecheck and payment-path failures and repairs other test failures', () => {
  expect(verifierFailureRevertsLanding({ command: ['bun', 'scripts/typecheck.ts'], closure: ['**'] })).toBe(true);
  expect(
    verifierFailureRevertsLanding({
      command: ['bun', 'test', 'services/kernel/test/commerce/work.test.ts'],
      closure: ['services/kernel/src/commerce/**'],
    }),
  ).toBe(true);
  expect(verifierFailureRevertsLanding({ command: ['affected-check'], closure: ['services/kernel/**'] })).toBe(false);
});
