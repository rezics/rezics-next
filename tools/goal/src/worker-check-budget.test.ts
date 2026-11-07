import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startWorkerCheck, workerCheckNeedsStack } from '../../../scripts/worker-check.ts';
import { openDb } from './db.ts';
import { settle } from './settle.ts';
import { recoverWorkerTyping } from './typing-recovery.ts';
import { WorkerJob } from './job.ts';
import { captureTypingInputs } from './worker-check-typing-inputs.ts';
import { readFileSync } from 'node:fs';
import { WorkerStore } from './store.ts';
import { brief, harness, temporaryDirectory } from './test-support.ts';
import type { Attempt, Settings } from './types.ts';
import { runWorkerCommand } from './worker-commands.ts';
import type { WorkerTasks } from './tasks.ts';
import {
  checkCommandIncludesTypecheck,
  admitWorkerCheckHostRun,
  readWorkerCheckHostStamp,
  classifyOrdinaryProductCommand,
  ordinaryProductCheckRefusal,
  refuseExcessWorkerCheckHostRun,
  refuseOrdinaryProductTestCheck,
  settleWorkerCheckHostBudget,
  workerCheckBudgetDirectory,
  workerCheckHostBudgetLimit,
  workerCheckHostCommandReached,
  workerCheckHostContentTree,
  workerCheckHostRunsUsed,
  workerCheckHostTypecheckFailed,
  workerCheckHostTypingSettlement,
  WORKER_CHECK_HOST_BUDGET_REFUSAL,
  WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT,
  WORKER_CHECK_HOST_RUN_LIMIT,
  WORKER_CHECK_HOST_TYPECHECK_REFUSAL,
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
  const previousRegistry = process.env.GOAL_CHECK_REGISTRY;
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
    process.env.GOAL_CHECK_REGISTRY = join(directory.path, 'missing-registry');
    expect(() => startWorkerCheck(command, directory.path)).toThrow(WORKER_CHECK_HOST_BUDGET_REFUSAL);
    expect(existsSync(join(directory.path, '.temp/goal/checks'))).toBe(false);
    expect(() => refuseExcessWorkerCheckHostRun({ GOAL_WORKER_CHECK_BUDGET_DIR: budget }, false)).not.toThrow();
  } finally {
    if (previousBudget === undefined) delete process.env.GOAL_WORKER_CHECK_BUDGET;
    else process.env.GOAL_WORKER_CHECK_BUDGET = previousBudget;
    if (previousDirectory === undefined) delete process.env.GOAL_WORKER_CHECK_BUDGET_DIR;
    else process.env.GOAL_WORKER_CHECK_BUDGET_DIR = previousDirectory;
    if (previousRegistry === undefined) delete process.env.GOAL_CHECK_REGISTRY;
    else process.env.GOAL_CHECK_REGISTRY = previousRegistry;
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

const combinedArgv = ['sh', '-c', 'bun run --cwd tools/goal typecheck; s=$?; bun test a.test.ts || s=1; exit $s'];
const typecheckLog =
  "src.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\nerror: script \"typecheck\" exited with code 1\n";
const testsOnlyLog = '$ bun run --cwd tools/goal typecheck\n$ bun test a.test.ts\n(fail) a\nerror: bun test failed\n';

function git(path: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: path, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')}`);
}

function gitWorktree(path: string): void {
  git(path, ['init', '-b', 'main']);
  git(path, ['config', 'user.email', 'test@example.invalid']);
  git(path, ['config', 'user.name', 'Test']);
  writeFileSync(join(path, '.gitignore'), '.temp/\n');
  writeFileSync(join(path, 'src.ts'), 'export {}\n');
  git(path, ['add', '.']);
  git(path, ['commit', '-m', 'init']);
}

function countedFailure(env: NodeJS.ProcessEnv, logPath: string, log: string, exitCode = 1): void {
  writeFileSync(logPath, log);
  settleWorkerCheckHostBudget(env, exitCode, true, { log: logPath, argv: combinedArgv });
}

test('after two failed runs, one final verification run is admitted when the worktree changed; a second final or unchanged content is refused as today', () => {
  const controller = temporaryDirectory();
  const worktree = temporaryDirectory();
  try {
    gitWorktree(worktree.path);
    const budget = workerCheckBudgetDirectory(controller.path, 'task', 1);
    const env: NodeJS.ProcessEnv = {
      GOAL_WORKER_CHECK_BUDGET: '2',
      GOAL_WORKER_CHECK_BUDGET_DIR: budget,
    };
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: worktree.path })).toEqual({
      ok: true,
      used: 1,
      stamp: '1',
    });
    env.GOAL_WORKER_CHECK_BUDGET_STAMP = '1';
    countedFailure(env, join(controller.path, '1.log'), testsOnlyLog);
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: worktree.path })).toEqual({
      ok: true,
      used: 2,
      stamp: '2',
    });
    env.GOAL_WORKER_CHECK_BUDGET_STAMP = '2';
    countedFailure(env, join(controller.path, '2.log'), testsOnlyLog);
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: worktree.path })).toEqual({
      ok: false,
      used: 2,
      message: WORKER_CHECK_HOST_BUDGET_REFUSAL,
    });
    writeFileSync(join(worktree.path, 'src.ts'), 'export const fixed = 1;\n');
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: worktree.path })).toEqual({
      ok: true,
      used: 3,
      stamp: '3',
    });
    expect(readWorkerCheckHostStamp(budget, '3').final).toBe(true);
    env.GOAL_WORKER_CHECK_BUDGET_STAMP = '3';
    countedFailure(env, join(controller.path, '3.log'), testsOnlyLog);
    writeFileSync(join(worktree.path, 'src.ts'), 'export const again = 2;\n');
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: worktree.path })).toEqual({
      ok: false,
      used: 3,
      message: WORKER_CHECK_HOST_BUDGET_REFUSAL,
    });
  } finally {
    controller.close();
    worktree.close();
  }
});

test('a final verification typecheck failure keeps its stamp and the next refusal tells the worker to return a blocker naming those type errors, not success', () => {
  const controller = temporaryDirectory();
  const worktree = temporaryDirectory();
  try {
    gitWorktree(worktree.path);
    const budget = workerCheckBudgetDirectory(controller.path, 'task', 1);
    const env: NodeJS.ProcessEnv = {
      GOAL_WORKER_CHECK_BUDGET: '2',
      GOAL_WORKER_CHECK_BUDGET_DIR: budget,
    };
    expect(workerCheckHostTypecheckFailed(typecheckLog, combinedArgv)).toBe(true);
    expect(workerCheckHostTypecheckFailed(testsOnlyLog, combinedArgv)).toBe(false);
    for (const stamp of ['1', '2'] as const) {
      expect(admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: worktree.path }).ok).toBe(true);
      env.GOAL_WORKER_CHECK_BUDGET_STAMP = stamp;
      countedFailure(env, join(controller.path, `${stamp}.log`), typecheckLog);
    }
    writeFileSync(join(worktree.path, 'src.ts'), 'export const fixed = 1;\n');
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: worktree.path })).toEqual({
      ok: true,
      used: 3,
      stamp: '3',
    });
    env.GOAL_WORKER_CHECK_BUDGET_STAMP = '3';
    countedFailure(env, join(controller.path, '3.log'), typecheckLog);
    expect(workerCheckHostRunsUsed(budget)).toBe(3);
    expect(readWorkerCheckHostStamp(budget, '3')).toMatchObject({
      final: true,
      exitCode: 1,
      typecheckFailed: true,
      includedTypecheck: true,
    });
    const refused = admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: worktree.path });
    expect(refused).toEqual({
      ok: false,
      used: 3,
      message: WORKER_CHECK_HOST_TYPECHECK_REFUSAL,
    });
    expect(refused.ok ? '' : refused.message).toContain('Return a blocker naming those type errors, not success.');
    expect(refused.ok ? '' : refused.message.split('\n')).toHaveLength(1);
  } finally {
    controller.close();
    worktree.close();
  }
});

test('settlement records a typing failure after a failed or stale host typecheck; failing tests alone keep today handling', () => {
  const controller = temporaryDirectory();
  const worktree = temporaryDirectory();
  try {
    gitWorktree(worktree.path);
    const budget = workerCheckBudgetDirectory(controller.path, 'task', 1);
    const env: NodeJS.ProcessEnv = {
      GOAL_WORKER_CHECK_BUDGET: '2',
      GOAL_WORKER_CHECK_BUDGET_DIR: budget,
    };
    expect(admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: worktree.path })).toEqual({
      ok: true,
      used: 1,
      stamp: '1',
    });
    env.GOAL_WORKER_CHECK_BUDGET_STAMP = '1';
    countedFailure(env, join(controller.path, 'failed.log'), typecheckLog);
    const failed = workerCheckHostTypingSettlement({
      directory: budget,
      worktree: worktree.path,
      limit: 2,
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('expected typing failure');
    expect(failed.result).toContain('Last check-host run failed its typecheck.');
    expect(failed.result).toContain('error TS2322');
    expect(
      workerCheckHostTypingSettlement({
        directory: budget,
        worktree: worktree.path,
        limit: 'off',
      }),
    ).toEqual({ ok: true });

    const tests = temporaryDirectory();
    gitWorktree(tests.path);
    const testsBudget = workerCheckBudgetDirectory(controller.path, 'tests', 1);
    const testsEnv: NodeJS.ProcessEnv = {
      GOAL_WORKER_CHECK_BUDGET: '2',
      GOAL_WORKER_CHECK_BUDGET_DIR: testsBudget,
    };
    expect(admitWorkerCheckHostRun({ directory: testsBudget, limit: 2, worktree: tests.path })).toEqual({
      ok: true,
      used: 1,
      stamp: '1',
    });
    testsEnv.GOAL_WORKER_CHECK_BUDGET_STAMP = '1';
    countedFailure(testsEnv, join(controller.path, 'tests.log'), testsOnlyLog);
    expect(workerCheckHostTypingSettlement({ directory: testsBudget, worktree: tests.path, limit: 2 })).toEqual({
      ok: true,
    });

    const passed = temporaryDirectory();
    gitWorktree(passed.path);
    const passedBudget = workerCheckBudgetDirectory(controller.path, 'passed', 1);
    const passedEnv: NodeJS.ProcessEnv = {
      GOAL_WORKER_CHECK_BUDGET: '2',
      GOAL_WORKER_CHECK_BUDGET_DIR: passedBudget,
    };
    writeFileSync(join(passed.path, 'extra.ts'), 'export const extra = 1;\n');
    expect(admitWorkerCheckHostRun({ directory: passedBudget, limit: 2, worktree: passed.path })).toEqual({
      ok: true,
      used: 1,
      stamp: '1',
    });
    passedEnv.GOAL_WORKER_CHECK_BUDGET_STAMP = '1';
    countedFailure(passedEnv, join(controller.path, 'passed.log'), testsOnlyLog, 0);
    const beforeCommit = workerCheckHostContentTree(passed.path);
    git(passed.path, ['add', 'extra.ts']);
    git(passed.path, ['commit', '-m', 'same tree']);
    expect(workerCheckHostContentTree(passed.path)).toBe(beforeCommit);
    expect(workerCheckHostTypingSettlement({ directory: passedBudget, worktree: passed.path, limit: 2 })).toEqual({
      ok: true,
    });
    writeFileSync(join(passed.path, 'extra.ts'), 'export const extra = 2;\n');
    const stale = workerCheckHostTypingSettlement({
      directory: passedBudget,
      worktree: passed.path,
      limit: 2,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('expected stale typing failure');
    expect(stale.result).toContain('Worktree content changed after the last check-host typecheck.');
    expect(stale.result).toContain('Legacy evidence has no retained compiler-input closure');
    tests.close();
    passed.close();
  } finally {
    controller.close();
    worktree.close();
  }
});

test('settlement of a success report after a failed host typecheck retries instead of landing', async () => {
  const h = harness();
  try {
    const failed = await settleSuccessWithHostCheck(h, typecheckLog);
    expect(failed.landings).toEqual([]);
    expect(h.store.attempt(failed.ref).failureKind).toBe('tool');
    expect(h.store.attempt(failed.ref).result).toContain('Last check-host run failed its typecheck.');
    expect(h.store.attempt(failed.ref).result).toContain('error TS2322');
    expect(h.store.task(failed.task.id).state).not.toBe('landing');
  } finally {
    await h.disposeAsync();
  }
}, 15_000);

async function settleSuccessWithHostCheck(
  h: ReturnType<typeof harness>,
  log: string,
  beforeSettle?: (budget: string, worktree: string) => void,
) {
  const task = h.tasks.dispatch(h.briefFile);
  const startedAt = new Date().toISOString();
  const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n): Attempt => ({
    taskId: task.id,
    attempt: n,
    state: 'pending',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt,
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${n}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(n)),
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
  }));
  mkdirSync(join(attempt.logPath, '..'), { recursive: true });
  writeFileSync(
    attempt.logPath,
    [
      { type: 'thread.started', thread_id: 'typing-session' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'RESULT: success' },
      },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  h.store.updateAttempt(attempt, (current) => {
    current.state = 'running';
  });
  h.store.updateTask(attempt, (current) => {
    current.state = 'running';
  });
  const budget = workerCheckBudgetDirectory(h.settings.stateDirectory, task.id, attempt.attempt);
  const env: NodeJS.ProcessEnv = {
    GOAL_WORKER_CHECK_BUDGET: '2',
    GOAL_WORKER_CHECK_BUDGET_DIR: budget,
  };
  expect(admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: task.worktree })).toEqual({
    ok: true,
    used: 1,
    stamp: '1',
  });
  env.GOAL_WORKER_CHECK_BUDGET_STAMP = '1';
  countedFailure(env, join(h.settings.stateDirectory, `${task.id}.log`), log);
  beforeSettle?.(budget, task.worktree);
  const landings: unknown[] = [];
  await settle(
    h.tasks,
    { attempt, exited: Promise.resolve({ code: 0, signal: null }) },
    { enqueue: (request) => landings.push(request) },
  );
  return { task, ref: { taskId: task.id, attempt: attempt.attempt }, landings };
}

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
  expect(
    ordinaryProductCheckRefusal(
      [
        'sh',
        '-c',
        'bun run --cwd services/kernel typecheck; s=$?; bun run --cwd services/auth typecheck || s=1; bun run --cwd apps/web typecheck || s=1; exit $s',
      ],
      false,
    ),
  ).toBeUndefined();
  expect(ordinaryProductCheckRefusal(['bun', 'test', 'apps/web/tests/library.test.ts'], false)).toBe(
    WORKER_CHECK_TESTS_AFTER_LANDING,
  );
  expect(ordinaryProductCheckRefusal(['bun', 'scripts/check-startup.ts'], false)).toBe(
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

// Regression commands containing a compiler test filename are tests, not owning compiler invocations.
test('typing evidence is requested only for a compiler command, not its regression filename', () => {
  expect(checkCommandIncludesTypecheck(['bun', 'test', 'scripts/typecheck.test.ts'])).toBe(false);
  expect(checkCommandIncludesTypecheck(['bun', 'scripts/typecheck.ts', '--selection={}'])).toBe(true);
  expect(checkCommandIncludesTypecheck(['bun', 'run', '--cwd', 'tools/goal', 'typecheck'])).toBe(true);
});

test('missing compiler evidence parks completed source without a model retry, then native reconciliation lands its same attempt', async () => {
  const h = harness();
  try {
    const command = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
    const retained = await settleSuccessWithHostCheck(h, 'kernel typecheck completed', (budget, worktree) => {
      const file = join(budget, '1');
      const stamp = JSON.parse(readFileSync(file, 'utf8'));
      stamp.exitCode = 0;
      stamp.typingRequest = {
        physicalRunId: 'a1a1a1a1-1111-4111-8111-111111111111',
        command,
        capture: 'physical-command',
        localPrepared: captureTypingInputs(worktree, ['bun', 'scripts/typecheck.ts']).prepared,
      };
      writeFileSync(file, JSON.stringify(stamp));
    });
    expect(retained.landings).toEqual([]);
    expect(h.store.attempt(retained.ref)).toMatchObject({
      failureKind: null,
      result: 'RESULT: success',
      typingEvidencePending: { command },
    });
    const notices: unknown[] = [];
    const landing: unknown[] = [];
    const job = new WorkerJob(
      h.tasks,
      { enqueue: (request) => landing.push(request) },
      { deliver: (event) => notices.push(event) },
    );
    job.onAttemptExit(retained.ref);
    await job.drain();
    expect(h.store.retryIntent(retained.ref)).toBeUndefined();
    expect(h.store.task(retained.task.id)).toMatchObject({ currentAttempt: 1, state: 'stopped' });
    expect(notices).toHaveLength(1);
    h.store.saveRetryIntent(retained.ref, {});
    const originalRetry = h.tasks.retry;
    let sourceStarts = 0;
    h.tasks.retry = async () => {
      sourceStarts++;
      throw new Error('missing evidence must not invoke a source writer');
    };
    try {
      job.resumePendingRetries();
      await job.drain();
    } finally {
      h.tasks.retry = originalRetry;
    }
    expect(sourceStarts).toBe(0);
    expect(h.store.retryIntent(retained.ref)?.status).toBe('abandoned');
    const pending = await recoverWorkerTyping(h.tasks, job.landing, retained.ref);
    expect(pending).toMatchObject({
      status: 'pending',
      proof: {
        commands: [['bun', join(h.settings.mainCheckout, 'scripts/worker-check.ts'), '--run', '--', ...command]],
      },
    });
    expect(landing).toEqual([]);
    await expect(
      runWorkerCommand('typing-recover', [retained.task.id, '--expected-attempt', '1'], { tasks: h.tasks, env: {} }),
    ).rejects.toThrow('authenticated owning or operations');
    await expect(
      runWorkerCommand('typing-recover', [retained.task.id, '--expected-attempt', '2'], { tasks: h.tasks, env: {} }),
    ).rejects.toThrow('stale');
    // Captured legacy workspace producer: exact full-tree evidence is available, but no compiler could emit the new artifact.
    const file = join(workerCheckBudgetDirectory(h.settings.stateDirectory, retained.task.id, 1), '1');
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    delete legacy.typingRequest.capture;
    writeFileSync(file, JSON.stringify(legacy));
    h.settings.integration.operationsManager = 'operations';
    h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    h.store.db.query('INSERT INTO manager_sessions VALUES (?,?)').run(
      'operations',
      JSON.stringify({
        id: 'operations',
        kind: 'resident-supermanager',
        provider: 'claude',
        status: 'running',
        threadId: 'operations-session',
      }),
    );
    const output: string[] = [];
    expect(
      await runWorkerCommand('typing-recover', [retained.task.id, '--expected-attempt', '1'], {
        tasks: h.tasks,
        landing: job.landing,
        env: { CLAUDE_CODE_SESSION_ID: 'operations-session' },
        print: (value) => output.push(value),
      }),
    ).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: 'landing', attempt: 1 });
    expect(landing).toHaveLength(1);
    expect(h.store.task(retained.task.id).currentAttempt).toBe(1);
    expect(h.store.attempt(retained.ref).typingEvidencePending).toBeUndefined();
    expect(h.store.retryIntent(retained.ref)?.status).toBe('abandoned');
  } finally {
    await h.disposeAsync();
  }
});
