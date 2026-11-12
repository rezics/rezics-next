import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startWorkerCheck, workerCheckNeedsStack } from '../../../scripts/worker-check.ts';
import { openDb } from './db.ts';
import { STOPPED_TASK_LIMIT_MS, sweepBacklog } from './backlog.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { settle } from './settle.ts';
import { recoverWorkerTyping } from './typing-recovery.ts';
import { WorkerJob } from './job.ts';
import {
  beginTypingInputReceipt,
  readTypingInputReceipt,
  captureTypingInputs,
  typingInputCommand,
} from './worker-check-typing-inputs.ts';
import { WorkerStore } from './store.ts';
import { brief, harness, temporaryDirectory } from './test-support.ts';
import type { Attempt, Settings } from './types.ts';
import { runWorkerCommand } from './worker-commands.ts';
import type { WorkerTasks } from './tasks.ts';
import {
  isTypingSettlementResult,
  isTypingEvidenceUnavailableResult,
  TYPING_RECOVERY_ENV,
  recordWorkerCheckTypingInputs,
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
  workerCheckHostAttemptCheckCustody,
  workerCheckHostTypingCheckIds,
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

function recoveryProof(result: Awaited<ReturnType<typeof recoverWorkerTyping>>) {
  if (!('proof' in result)) throw new Error('Expected typing recovery to issue a compiler proof');
  return result.proof;
}

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

test('settlement distinguishes compiler failures from stale evidence; failing tests alone keep today handling', () => {
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
    if (stale.ok) throw new Error('expected pending typing evidence');
    expect(stale.kind).toBe('evidence-unavailable');
    expect(stale.result).toContain('Compiler input closure is unavailable');
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

const directKernelCompiler = ['bun', 'services/kernel/scripts/typecheck.ts'];

function prepareDirectKernelCompiler(worktree: string): void {
  mkdirSync(join(worktree, 'services/kernel/scripts'), { recursive: true });
  mkdirSync(join(worktree, 'services/kernel/src'), { recursive: true });
  writeFileSync(
    join(worktree, 'services/kernel/package.json'),
    JSON.stringify({ name: '@rezics/kernel', scripts: { typecheck: 'bun scripts/typecheck.ts' } }),
  );
  writeFileSync(join(worktree, 'services/kernel/tsconfig.json'), '{"include":["src/**/*.ts"]}');
  writeFileSync(join(worktree, 'services/kernel/scripts/typecheck.ts'), 'export {};');
  writeFileSync(join(worktree, 'services/kernel/src/index.ts'), 'export const ready = true;');
}

function writeDirectKernelStamp(budget: string, worktree: string, stamp: string, exitCode: number, log: string): void {
  const physicalRunId = randomUUID();
  const env = {
    REZICS_TYPING_INPUTS_PHYSICAL: physicalRunId,
    REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(directKernelCompiler)).toString('base64'),
  };
  const complete = beginTypingInputReceipt(worktree, env, directKernelCompiler);
  if (!complete) throw new Error('direct Kernel owner did not capture compiler inputs');
  complete(exitCode);
  const receipt = readTypingInputReceipt(worktree, physicalRunId, directKernelCompiler);
  if (!receipt) throw new Error('direct Kernel owner did not return its physical receipt');
  const file = join(budget, stamp);
  const previous = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({
      ...previous,
      exitCode,
      includedTypecheck: true,
      typecheckFailed: exitCode !== 0,
      log,
      typingRequest: { physicalRunId, command: directKernelCompiler, localPrepared: [], capture: 'physical-command' },
      typingInputs: receipt,
    }),
  );
}

function writeLaterCancelledCheck(
  worktree: string,
  authorizationDirectory: string,
  taskId: string,
  attempt: number,
  checkId: string,
  physicalRunId: string,
): { finishPhysicalCustody: (terminal: boolean) => void; authorizationPath: string; authorizationBytes: string } {
  const root = join(worktree, '.temp/goal/checks');
  const resultDirectory = join(root, 'results');
  const custody = join(root, 'custody');
  const historyDirectory = join(custody, 'history');
  const cancelledDirectory = join(custody, 'cancelled');
  mkdirSync(resultDirectory, { recursive: true });
  mkdirSync(historyDirectory, { recursive: true });
  mkdirSync(cancelledDirectory, { recursive: true });
  const result = JSON.stringify({
    id: checkId,
    cwd: worktree,
    argv: directKernelCompiler,
    ownership: { taskId, attempt },
    status: 'running',
    physicalRunId,
  });
  const authorizationPath = join(authorizationDirectory, `${checkId}.cancellation-authorization.json`);
  const authorizationBytes = JSON.stringify({
    records: [{ id: checkId, taskId, attempt, argv: directKernelCompiler }],
  });
  writeFileSync(authorizationPath, authorizationBytes);
  writeFileSync(join(resultDirectory, `${checkId}.json`), result);
  writeFileSync(
    join(cancelledDirectory, `${checkId}.json`),
    JSON.stringify({
      version: 1,
      checkId,
      ownership: { taskId, attempt },
      disposition: 'logically-cancelled-physical-cleanup-unknown',
      physicalRunId,
      recordSha256: createHash('sha256').update(result).digest('hex'),
      receiptReference: authorizationPath,
      receiptSha256: createHash('sha256').update(authorizationBytes).digest('hex'),
      createdAt: new Date().toISOString(),
    }),
  );
  return {
    authorizationPath,
    authorizationBytes,
    finishPhysicalCustody: (terminal) => {
      writeFileSync(
        join(historyDirectory, `${checkId}.${physicalRunId}.json`),
        JSON.stringify({
          version: 1,
          id: checkId,
          cwd: worktree,
          argv: directKernelCompiler,
          ownership: { taskId, attempt },
          physicalRunId,
          status: terminal ? 'unknown' : 'running',
          remoteExpected: false,
          ...(terminal
            ? { terminalProof: { local: true, remote: null, resultKnown: false, observedAt: new Date().toISOString() } }
            : {}),
        }),
      );
    },
  };
}

test('a retained Kernel pass waits for later cancellation custody and then reuses the original attempt without another run', async () => {
  const h = harness();
  try {
    const retained = await settleSuccessWithHostCheck(h, 'kernel typecheck completed', (_budget, worktree) => {
      prepareDirectKernelCompiler(worktree);
    });
    const budget = workerCheckBudgetDirectory(h.settings.stateDirectory, retained.task.id, 1);
    const successfulLog = join(h.settings.stateDirectory, 'retained-kernel-typecheck.log');
    writeFileSync(successfulLog, '');
    writeDirectKernelStamp(budget, retained.task.worktree, '1', 0, successfulLog);
    const firstStampPath = join(budget, '1');
    const firstStamp = JSON.parse(readFileSync(firstStampPath, 'utf8')) as Record<string, unknown>;
    const retainedReceipt = firstStamp.typingInputs as Record<string, unknown>;
    const settlement = () =>
      workerCheckHostTypingSettlement({ directory: budget, worktree: retained.task.worktree, limit: 2 });
    firstStamp.typingInputs = { ...retainedReceipt, physicalRunId: randomUUID() };
    writeFileSync(firstStampPath, JSON.stringify(firstStamp));
    expect(settlement()).toMatchObject({
      ok: false,
      kind: 'evidence-unavailable',
    });
    firstStamp.typingInputs = retainedReceipt;
    writeFileSync(firstStampPath, JSON.stringify(firstStamp));
    expect(settlement()).toEqual({ ok: true });

    const later = admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree: retained.task.worktree });
    expect(later).toMatchObject({ ok: true, used: 2, stamp: '2' });
    const laterPhysical = randomUUID();
    const checkId = randomUUID();
    const laterStampPath = join(budget, '2');
    const laterStamp = JSON.parse(readFileSync(laterStampPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      laterStampPath,
      JSON.stringify({
        ...laterStamp,
        includedTypecheck: true,
        typingRequest: {
          physicalRunId: laterPhysical,
          command: directKernelCompiler,
          localPrepared: [],
          capture: 'physical-command',
        },
        typingRecovery: { token: randomUUID(), checkId, physicalRunId: laterPhysical },
      }),
    );
    const laterCustody = writeLaterCancelledCheck(
      retained.task.worktree,
      h.settings.stateDirectory,
      retained.task.id,
      retained.ref.attempt,
      checkId,
      laterPhysical,
    );
    h.store.updateAttempt(retained.ref, (attempt) => {
      attempt.checks = [];
    });
    laterCustody.finishPhysicalCustody(false);
    expect(
      workerCheckHostAttemptCheckCustody(
        retained.task.worktree,
        retained.task.id,
        1,
        workerCheckHostTypingCheckIds(budget, []),
      ),
    ).toBe('unknown');
    const waiting = await recoverWorkerTyping(h.tasks, { enqueue: () => {} }, retained.ref);
    expect(waiting).toMatchObject({
      status: 'pending',
      result: expect.stringContaining('no additional compiler run was authorized'),
    });
    expect(workerCheckHostRunsUsed(budget)).toBe(2);
    expect(existsSync(join(budget, 'typing-recovery'))).toBe(false);

    laterCustody.finishPhysicalCustody(true);
    expect(
      workerCheckHostAttemptCheckCustody(
        retained.task.worktree,
        retained.task.id,
        1,
        workerCheckHostTypingCheckIds(budget, []),
      ),
    ).toBe('terminal');
    writeFileSync(laterCustody.authorizationPath, `${laterCustody.authorizationBytes} `);
    expect(
      workerCheckHostAttemptCheckCustody(
        retained.task.worktree,
        retained.task.id,
        1,
        workerCheckHostTypingCheckIds(budget, []),
      ),
    ).toBe('unknown');
    writeFileSync(laterCustody.authorizationPath, laterCustody.authorizationBytes);
    const landings: unknown[] = [];
    const recovered = await recoverWorkerTyping(h.tasks, { enqueue: (value) => landings.push(value) }, retained.ref);
    expect(recovered.status).toBe('landing');
    expect(landings).toHaveLength(1);
    expect(workerCheckHostRunsUsed(budget)).toBe(2);
    expect(existsSync(join(budget, 'typing-recovery'))).toBe(false);
    expect(h.store.task(retained.task.id).currentAttempt).toBe(1);
  } finally {
    await h.disposeAsync();
  }
}, 20_000);

test('a newer genuine direct Kernel compiler failure supersedes an older retained pass', () => {
  const controller = temporaryDirectory();
  const worktree = temporaryDirectory();
  try {
    gitWorktree(worktree.path);
    prepareDirectKernelCompiler(worktree.path);
    const budget = workerCheckBudgetDirectory(controller.path, 'kernel-failure', 1);
    expect(admitWorkerCheckHostRun({ directory: budget, worktree: worktree.path, limit: 2 }).ok).toBe(true);
    const successLog = join(controller.path, 'kernel-success.log');
    writeFileSync(successLog, '');
    writeDirectKernelStamp(budget, worktree.path, '1', 0, successLog);

    expect(admitWorkerCheckHostRun({ directory: budget, worktree: worktree.path, limit: 2 }).ok).toBe(true);
    const failureLog = join(controller.path, 'kernel-failure.log');
    writeFileSync(failureLog, 'src/index.ts(1,1): error TS2322: real compiler failure\n');
    writeDirectKernelStamp(budget, worktree.path, '2', 1, failureLog);
    const result = workerCheckHostTypingSettlement({ directory: budget, worktree: worktree.path, limit: 2 });
    expect(result).toMatchObject({ ok: false, kind: 'typing-failure' });
    if (result.ok) throw new Error('a newer compiler failure must remain authoritative');
    expect(result.result).toContain('error TS2322: real compiler failure');
    expect(workerCheckHostRunsUsed(budget)).toBe(2);
  } finally {
    controller.close();
    worktree.close();
  }
});

test('a later unresolved Kernel check cannot borrow an older legacy content-only pass', () => {
  const worktree = temporaryDirectory();
  const controller = temporaryDirectory();
  try {
    gitWorktree(worktree.path);
    prepareDirectKernelCompiler(worktree.path);
    const budget = join(controller.path, 'budget');
    mkdirSync(budget, { recursive: true });
    writeFileSync(
      join(budget, '1'),
      JSON.stringify({
        content: workerCheckHostContentTree(worktree.path),
        includedTypecheck: true,
        exitCode: 0,
      }),
    );
    writeFileSync(
      join(budget, '2'),
      JSON.stringify({
        includedTypecheck: true,
        typingRequest: {
          physicalRunId: randomUUID(),
          command: directKernelCompiler,
          localPrepared: [],
          capture: 'physical-command',
        },
      }),
    );

    expect(workerCheckHostTypingSettlement({ directory: budget, worktree: worktree.path, limit: 2 })).toMatchObject({
      ok: false,
      kind: 'evidence-unavailable',
    });
  } finally {
    worktree.close();
    controller.close();
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
    const now = Date.now();
    const old = new Date(now - STOPPED_TASK_LIMIT_MS - 1_000).toISOString();
    const originalCreatedAt = h.store.task(retained.task.id).createdAt;
    const originalEndedAt = h.store.attempt(retained.ref).endedAt!;
    h.store.updateTask(retained.ref, (current) => {
      current.createdAt = old;
    });
    h.store.updateAttempt(retained.ref, (current) => {
      current.endedAt = old;
    });
    h.store.db
      .query('UPDATE worker_events SET at=? WHERE task_id=? AND attempt=?')
      .run(old, retained.task.id, retained.ref.attempt);
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.stateDirectory, () => now);
    let recoveryCalls = 0;
    let sweepWriterCalls = 0;
    const backlogRuntime = {
      db: h.store.db,
      stateDirectory: h.settings.stateDirectory,
      inbox,
      now: () => now,
      workerCap: 0,
      async dispatch() {
        throw new Error('unexpected dispatch');
      },
      async continueTask() {},
      async cancel() {
        throw new Error('typing-only source must remain recoverable');
      },
      async recoverTyping(ref: typeof retained.ref) {
        recoveryCalls++;
        return recoverWorkerTyping(h.tasks, job.landing, ref);
      },
    };
    const originalSweepRetry = h.tasks.retry;
    h.tasks.retry = async () => {
      sweepWriterCalls++;
      throw new Error('expiry recovery must not invoke a source writer');
    };
    try {
      expect((await sweepBacklog(backlogRuntime)).expired).toEqual([]);
      expect(
        (await sweepBacklog({ ...backlogRuntime, now: () => now + STOPPED_TASK_LIMIT_MS + 1_000 })).expired,
      ).toEqual([]);
    } finally {
      h.tasks.retry = originalSweepRetry;
    }
    h.store.updateTask(retained.ref, (current) => {
      current.createdAt = originalCreatedAt;
    });
    h.store.updateAttempt(retained.ref, (current) => {
      current.endedAt = originalEndedAt;
    });
    expect(recoveryCalls).toBe(1);
    expect(sweepWriterCalls).toBe(0);
    expect(h.store.task(retained.task.id)).toMatchObject({ currentAttempt: 1, state: 'stopped' });
    expect(h.store.attempt(retained.ref).typingEvidencePending).toMatchObject({ command });
    const recoveryNotices = inbox.pending('fixture').filter(({ event }) => event.summary.includes('typing-recover'));
    expect(recoveryNotices).toHaveLength(1);
    expect(recoveryNotices[0]!.event.summary).toContain(
      `typing-recover ${retained.task.id} --expected-attempt ${retained.ref.attempt}`,
    );
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

test.each(['during', 'after'])(
  'zero-exit input drift %s compilation retains the same completed attempt without a writer',
  async (when) => {
    const h = harness();
    try {
      const command = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
      const physical = 'b2b2b2b2-2222-4222-8222-222222222222';
      const retained = await settleSuccessWithHostCheck(h, 'kernel typecheck completed', (budget, worktree) => {
        const env = {
          REZICS_TYPING_INPUTS_PHYSICAL: physical,
          REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(command)).toString('base64'),
        };
        const complete = beginTypingInputReceipt(worktree, env, command)!;
        const change = () => writeFileSync(join(worktree, 'drift.ts'), 'export const changed = true;');
        if (when === 'during') change();
        complete(0);
        if (when === 'after') change();
        const file = join(budget, '1');
        const stamp = JSON.parse(readFileSync(file, 'utf8'));
        stamp.exitCode = 0;
        stamp.typingRequest = {
          physicalRunId: physical,
          command,
          capture: 'physical-command',
          localPrepared: [],
        };
        stamp.typingInputs = readTypingInputReceipt(worktree, physical, command);
        writeFileSync(file, JSON.stringify(stamp));
      });
      expect(retained.landings).toEqual([]);
      expect(h.store.attempt(retained.ref)).toMatchObject({
        failureKind: null,
        result: 'RESULT: success',
        typingEvidencePending: { command },
      });
      const job = new WorkerJob(
        h.tasks,
        {
          enqueue: () => {
            throw new Error('unverified source cannot land');
          },
        },
        { deliver: () => {} },
      );
      h.store.saveRetryIntent(retained.ref, {});
      h.tasks.retry = async () => {
        throw new Error('unverified evidence cannot start a source writer');
      };
      job.resumePendingRetries();
      await job.drain();
      expect(h.store.retryIntent(retained.ref)?.status).toBe('abandoned');
      expect(h.store.task(retained.task.id).currentAttempt).toBe(1);
      expect(await recoverWorkerTyping(h.tasks, job.landing, retained.ref)).toMatchObject({ status: 'pending' });
    } finally {
      await h.disposeAsync();
    }
  },
  15_000,
);

test('historical drift settlement recovers compiler evidence while genuine compiler errors retain source repair', () => {
  const stale = 'Worktree content changed after the last check-host typecheck. retained log';
  expect(isTypingSettlementResult(stale)).toBe(true);
  expect(isTypingEvidenceUnavailableResult(stale)).toBe(true);
  const failed = 'Last check-host run failed its typecheck. error TS2322';
  expect(isTypingSettlementResult(failed)).toBe(true);
  expect(isTypingEvidenceUnavailableResult(failed)).toBe(false);
});

test.each([0, 1])(
  'authenticated exhausted-budget compiler recovery records work and settles its same attempt (compiler exit %s)',
  async (compilerExit) => {
    const h = harness();
    const command = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
    try {
      const retained = await settleSuccessWithHostCheck(h, 'kernel typecheck completed', (budget, worktree) => {
        mkdirSync(join(worktree, 'services/kernel/scripts'), { recursive: true });
        writeFileSync(
          join(worktree, 'services/kernel/package.json'),
          JSON.stringify({ scripts: { typecheck: 'bun scripts/typecheck.ts' } }),
        );
        writeFileSync(join(worktree, 'services/kernel/tsconfig.json'), '{"include":["scripts"]}');
        writeFileSync(
          join(worktree, 'services/kernel/scripts/typecheck.ts'),
          compilerExit === 0
            ? 'process.exit(0);'
            : 'console.error("error TS2322: actual compiler error");process.exit(1);',
        );
        expect(admitWorkerCheckHostRun({ directory: budget, worktree, limit: 2 }).ok).toBe(true);
        for (const stamp of ['1', '2']) {
          const file = join(budget, stamp);
          const record = JSON.parse(readFileSync(file, 'utf8'));
          writeFileSync(
            file,
            JSON.stringify({
              ...record,
              exitCode: 0,
              includedTypecheck: true,
              typingRequest: {
                physicalRunId: 'a1a1a1a1-1111-4111-8111-111111111111',
                command,
                capture: 'physical-command',
                localPrepared: [],
              },
            }),
          );
        }
      });
      const budget = workerCheckBudgetDirectory(h.settings.stateDirectory, retained.task.id, retained.ref.attempt);
      const old = ['1', '2'].map((stamp) => readFileSync(join(budget, stamp), 'utf8'));
      expect(admitWorkerCheckHostRun({ directory: budget, worktree: retained.task.worktree, limit: 2 }).ok).toBe(false);
      h.settings.integration.operationsManager = 'operations';
      h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY,state TEXT NOT NULL)');
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
      const recover = async () => {
        output.length = 0;
        expect(
          await runWorkerCommand('typing-recover', [retained.task.id, '--expected-attempt', '1'], {
            tasks: h.tasks,
            landing: { enqueue: () => {} },
            env: { CLAUDE_CODE_SESSION_ID: 'operations-session' },
            print: (value) => output.push(value),
          }),
        ).toBe(0);
        return JSON.parse(output[0]!);
      };
      h.store.db.query('INSERT INTO manager_sessions VALUES (?,?)').run(
        'foreign',
        JSON.stringify({
          id: 'foreign',
          kind: 'resident-supermanager',
          provider: 'claude',
          status: 'running',
          threadId: 'foreign-session',
        }),
      );
      await expect(
        runWorkerCommand('typing-recover', [retained.task.id, '--expected-attempt', '1'], {
          tasks: h.tasks,
          env: { CLAUDE_CODE_SESSION_ID: 'foreign-session' },
        }),
      ).rejects.toThrow('authenticated owning or operations');
      const issued = await recover();
      expect(issued.status).toBe('pending');
      expect(issued.proof.env.GOAL_WORKER_CHECK_BUDGET).toBe('2');
      expect(issued.proof.env[TYPING_RECOVERY_ENV]).toMatch(/^[0-9a-f-]{36}$/);
      expect((await recover()).proof.env[TYPING_RECOVERY_ENV]).toBe(issued.proof.env[TYPING_RECOVERY_ENV]);
      expect(workerCheckHostRunsUsed(budget)).toBe(2);
      const env = issued.proof.env as NodeJS.ProcessEnv;
      for (const wrong of [
        ['bun', 'test', 'services/kernel/test/commerce/payment.test.ts'],
        ['bun', 'apps/web/scripts/library-browser.ts'],
        ['bun', 'custom-typecheck.ts'],
        ['sh', '-c', 'bun run --cwd services/kernel typecheck; bun test'],
      ])
        expect(() => refuseExcessWorkerCheckHostRun({ ...env }, true, retained.task.worktree, wrong)).toThrow(
          'does not match',
        );
      expect(() =>
        refuseExcessWorkerCheckHostRun({ ...env, GOAL_TASK_ID: 'foreign' }, true, retained.task.worktree, command),
      ).toThrow('does not match');
      expect(() =>
        refuseExcessWorkerCheckHostRun({ ...env, GOAL_ATTEMPT: '2' }, true, retained.task.worktree, command),
      ).toThrow('does not match');
      writeFileSync(join(retained.task.worktree, 'new-input.ts'), 'export const changed = true;');
      expect(() => refuseExcessWorkerCheckHostRun({ ...env }, true, retained.task.worktree, command)).toThrow(
        'inputs changed',
      );
      const renewed = await recover();
      expect(renewed.proof.env[TYPING_RECOVERY_ENV]).not.toBe(env[TYPING_RECOVERY_ENV]);
      // Return to the exact original compiler inputs before consuming its original finite grant.
      const { unlinkSync } = await import('node:fs');
      unlinkSync(join(retained.task.worktree, 'new-input.ts'));
      expect(() =>
        refuseExcessWorkerCheckHostRun({ ...renewed.proof.env }, true, retained.task.worktree, command),
      ).toThrow('inputs changed');
      const saved = { ...process.env };
      let starts = 0;
      let id = '';
      try {
        Object.assign(process.env, env);
        const argv = issued.proof.commands[0].slice(4) as string[];
        expect(argv).toEqual(command);
        const launch: Parameters<typeof startWorkerCheck>[2] = (record, childEnv) => {
          starts++;
          recordWorkerCheckTypingInputs(childEnv, record.cwd, record.physicalRunId!, command);
          const result = Bun.spawnSync([process.execPath, ...typingInputCommand(command).slice(1)], {
            cwd: record.cwd,
            env: {
              ...childEnv,
              REZICS_TYPING_INPUTS_PHYSICAL: record.physicalRunId,
              REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(command)).toString('base64'),
            },
          });
          expect(result.exitCode).toBe(compilerExit);
          const log = join(h.settings.stateDirectory, 'recovery-compiler.log');
          writeFileSync(log, new TextDecoder().decode(result.stderr));
          settleWorkerCheckHostBudget(childEnv, result.exitCode, true, {
            worktree: record.cwd,
            physicalRunId: record.physicalRunId!,
            argv: command,
            log,
          });
          writeFileSync(
            join(record.cwd, '.temp/goal/checks/results', record.id + '.json'),
            JSON.stringify({ ...record, status: 'finished', exitCode: result.exitCode }),
          );
        };
        id = startWorkerCheck(argv, retained.task.worktree, launch);
        expect(startWorkerCheck(argv, retained.task.worktree, launch)).toBe(id);
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
      }
      expect(starts).toBe(1);
      expect(workerCheckHostRunsUsed(budget)).toBe(3);
      expect(readWorkerCheckHostStamp(budget, '3')).toMatchObject({
        exitCode: compilerExit,
        typingRecovery: { checkId: id },
        typingInputs: { exitCode: compilerExit },
      });
      expect(['1', '2'].map((stamp) => readFileSync(join(budget, stamp), 'utf8'))).toEqual(old);
      expect(admitWorkerCheckHostRun({ directory: budget, worktree: retained.task.worktree, limit: 2 }).ok).toBe(false);
      const landings: unknown[] = [];
      const result = await recoverWorkerTyping(h.tasks, { enqueue: (value) => landings.push(value) }, retained.ref, {
        id: 'operations',
        sessionId: 'operations-session',
      });
      expect(result.status).toBe(compilerExit === 0 ? 'landing' : 'typing-failure');
      expect(landings).toHaveLength(compilerExit === 0 ? 1 : 0);
      expect(h.store.task(retained.task.id).currentAttempt).toBe(1);
      expect(h.store.attempt(retained.ref).typingEvidencePending).toBeUndefined();
      expect(h.store.attempt(retained.ref).failureKind).toBe(compilerExit === 0 ? null : 'tool');
      expect(() => refuseExcessWorkerCheckHostRun({ ...env }, true, retained.task.worktree, command)).toThrow(
        'no longer pending',
      );
    } finally {
      await h.disposeAsync();
    }
  },
  15_000,
);

test('misordered compiler recovery uses its owner and replaces only a proven pre-compiler SIGTERM check once', async () => {
  const h = harness();
  try {
    const intent = ['bun', '--cwd', 'services/kernel', 'run', 'typecheck'];
    const compiler = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
    const retained = await settleSuccessWithHostCheck(h, 'kernel typecheck completed', (budget, worktree) => {
      mkdirSync(join(worktree, 'services/kernel/scripts'), { recursive: true });
      writeFileSync(
        join(worktree, 'services/kernel/package.json'),
        JSON.stringify({ scripts: { typecheck: 'bun scripts/typecheck.ts' } }),
      );
      writeFileSync(join(worktree, 'services/kernel/tsconfig.json'), '{"include":["scripts"]}');
      writeFileSync(join(worktree, 'services/kernel/scripts/typecheck.ts'), 'export {};');
      const file = join(budget, '1');
      const stamp = JSON.parse(readFileSync(file, 'utf8'));
      stamp.includedTypecheck = true;
      stamp.typingRequest = {
        physicalRunId: 'c3c3c3c3-3333-4333-8333-333333333333',
        command: intent,
        capture: 'physical-command',
        localPrepared: captureTypingInputs(worktree, ['bun', 'scripts/typecheck.ts']).prepared,
      };
      writeFileSync(file, JSON.stringify(stamp));
    });
    h.settings.integration.operationsManager = 'operations';
    h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY,state TEXT NOT NULL)');
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
    const actor = { id: 'operations', sessionId: 'operations-session' };
    const recover = () => recoverWorkerTyping(h.tasks, { enqueue: () => {} }, retained.ref, actor);
    const recoverProof = async () => recoveryProof(await recover());
    const issued = await recover();
    expect(issued.status).toBe('pending');
    const issuedProof = recoveryProof(issued);
    expect(issuedProof.commands[0]?.slice(-compiler.length)).toEqual(compiler);
    const budget = workerCheckBudgetDirectory(h.settings.stateDirectory, retained.task.id, 1);
    const env = issuedProof.env as NodeJS.ProcessEnv;
    const admitted = refuseExcessWorkerCheckHostRun({ ...env }, true, retained.task.worktree, compiler);
    if (!admitted?.ok || !('recovery' in admitted) || !admitted.recovery) throw new Error('recovery was not admitted');
    const original = admitted.recovery;
    const originalStamp = readFileSync(join(budget, '2'), 'utf8');
    const results = join(retained.task.worktree, '.temp/goal/checks/results');
    const history = join(retained.task.worktree, '.temp/goal/checks/custody/history');
    mkdirSync(results, { recursive: true });
    mkdirSync(history, { recursive: true });
    const writeEvidence = (status: string, commandStartedMonoMs: number | null, terminal: boolean) => {
      writeFileSync(
        join(results, `${original.checkId}.json`),
        JSON.stringify({
          id: original.checkId,
          cwd: retained.task.worktree,
          argv: compiler,
          ownership: { taskId: retained.task.id, attempt: 1 },
          status,
          exitCode: 143,
          physicalRunId: original.physicalRunId,
          physicalRun: { exitCode: 143, resources: { commandStartedMonoMs } },
        }),
      );
      writeFileSync(
        join(history, `${original.checkId}.${original.physicalRunId}.json`),
        JSON.stringify({
          version: 1,
          id: original.checkId,
          cwd: retained.task.worktree,
          physicalRunId: original.physicalRunId,
          status: terminal ? 'finished' : 'running',
          remoteExpected: true,
          exitCode: 143,
          ...(terminal
            ? { terminalProof: { local: true, remote: true, resultKnown: true, observedAt: new Date().toISOString() } }
            : {}),
        }),
      );
    };

    writeEvidence('running', null, false);
    expect((await recoverProof()).env[TYPING_RECOVERY_ENV]).toBe(env[TYPING_RECOVERY_ENV]);
    writeEvidence('finished', null, false);
    expect((await recoverProof()).env[TYPING_RECOVERY_ENV]).toBe(env[TYPING_RECOVERY_ENV]);
    writeEvidence('finished', 50, true);
    expect((await recoverProof()).env[TYPING_RECOVERY_ENV]).toBe(env[TYPING_RECOVERY_ENV]);
    writeEvidence('finished', null, true);
    const competingId = 'd4d4d4d4-4444-4444-8444-444444444444';
    writeFileSync(
      join(results, `${competingId}.json`),
      JSON.stringify({
        id: competingId,
        ownership: { taskId: retained.task.id, attempt: 1 },
        status: 'running',
      }),
    );
    expect((await recoverProof()).env[TYPING_RECOVERY_ENV]).toBe(env[TYPING_RECOVERY_ENV]);
    unlinkSync(join(results, `${competingId}.json`));
    mkdirSync(join(retained.task.worktree, '.temp/goal/checks/cancellations'), { recursive: true });
    const cancellation = join(retained.task.worktree, '.temp/goal/checks/cancellations', `${original.checkId}.json`);
    writeFileSync(cancellation, '{}');
    expect((await recoverProof()).env[TYPING_RECOVERY_ENV]).toBe(env[TYPING_RECOVERY_ENV]);
    unlinkSync(cancellation);

    const replacement = await recover();
    expect(replacement.status).toBe('pending');
    const replacementProof = recoveryProof(replacement);
    expect(replacementProof.env[TYPING_RECOVERY_ENV]).not.toBe(env[TYPING_RECOVERY_ENV]);
    expect(replacementProof.commands[0]?.slice(-compiler.length)).toEqual(compiler);
    expect(readFileSync(join(budget, '2'), 'utf8')).toBe(originalStamp);
    expect(workerCheckHostRunsUsed(budget)).toBe(2);
    expect((await recoverProof()).env[TYPING_RECOVERY_ENV]).toBe(replacementProof.env[TYPING_RECOVERY_ENV]);
    h.store.updateTask(retained.ref, (current) => {
      current.state = 'cancelled';
    });
    await expect(recover()).rejects.toThrow('completed ordinary source with pending compiler evidence');
  } finally {
    await h.disposeAsync();
  }
});

test('a withdrawn Web interface retry gets one exact terminal compiler receipt and lands the same stopped attempt', async () => {
  const h = harness();
  try {
    const retained = await settleSuccessWithHostCheck(h, testsOnlyLog);
    const task = h.store.task(retained.task.id);
    const attempt = h.store.attempt(retained.ref);
    h.store.db
      .query("DELETE FROM worker_events WHERE task_id=? AND attempt=? AND kind='landing-requested'")
      .run(retained.ref.taskId, retained.ref.attempt);
    h.store.updateTask(retained.ref, (current) => {
      current.state = 'stopped';
      current.brief.goal = 'web';
      current.brief.kind = 'interface';
    });

    const worktree = task.worktree;
    const compiler = ['bun', 'run', '--cwd', 'apps/web', 'typecheck'];
    mkdirSync(join(worktree, 'apps/web/scripts'), { recursive: true });
    mkdirSync(join(worktree, 'apps/web/src'), { recursive: true });
    writeFileSync(
      join(worktree, 'apps/web/package.json'),
      JSON.stringify({ scripts: { typecheck: 'bun scripts/typecheck.ts' } }),
    );
    writeFileSync(join(worktree, 'apps/web/tsconfig.json'), '{"include":["src/**/*.ts"]}');
    writeFileSync(join(worktree, 'apps/web/scripts/typecheck.ts'), 'export {};\n');
    writeFileSync(join(worktree, 'apps/web/src/baseline.ts'), 'export const baseline = true;\n');
    git(worktree, ['add', 'apps/web']);
    git(worktree, ['commit', '-m', 'Prepare Web compiler fixture']);

    const budget = workerCheckBudgetDirectory(h.settings.stateDirectory, task.id, 1);
    const second = admitWorkerCheckHostRun({ directory: budget, limit: 2, worktree });
    expect(second).toMatchObject({ ok: true, used: 2, stamp: '2' });
    const priorEnv: NodeJS.ProcessEnv = {
      GOAL_WORKER_CHECK_BUDGET: '2',
      GOAL_WORKER_CHECK_BUDGET_DIR: budget,
      GOAL_WORKER_CHECK_BUDGET_STAMP: '2',
    };
    const priorLog = join(h.settings.stateDirectory, 'prior-web-typecheck.log');
    writeFileSync(priorLog, '');
    settleWorkerCheckHostBudget(priorEnv, 0, true, { argv: compiler, log: priorLog, worktree });
    const priorStamps = ['1', '2'].map((stamp) => readFileSync(join(budget, stamp), 'utf8'));

    writeFileSync(join(worktree, 'apps/web/src/reader.ts'), 'export const mountedReader = true;\n');
    git(worktree, ['add', 'apps/web/src/reader.ts']);
    git(worktree, ['commit', '-m', 'Complete mounted reader']);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).stdout.trim();
    const stoppedProcess = { pid: 2_000_000_001, start: '1', boot: 'fixture-boot', group: 2_000_000_001 };
    const endedAt = new Date(Math.max(Date.now(), Date.parse(attempt.startedAt)) + 1_000).toISOString();
    const requestedAt = new Date(Date.parse(endedAt) + 1_000).toISOString();
    const settledAt = new Date(Date.parse(requestedAt) + 5).toISOString();
    const refusal = JSON.stringify({
      status: 'blocked',
      summary: 'Completed Web source; the final compiler could not start.',
      blocker: {
        kind: 'tool',
        detail: `${WORKER_CHECK_HOST_BUDGET_REFUSAL}\nRepeated on two retries; the final Web typecheck could not start.`,
      },
      checks: [],
      approaches: [],
    });
    const previousCheckId = 'a7a7a7a7-7777-4777-8777-777777777777';
    const previousPhysicalId = 'b8b8b8b8-8888-4888-8888-888888888888';
    const checkRoot = join(worktree, '.temp/goal/checks');
    const results = join(checkRoot, 'results');
    const history = join(checkRoot, 'custody/history');
    mkdirSync(results, { recursive: true });
    mkdirSync(history, { recursive: true });
    writeFileSync(
      join(results, `${previousCheckId}.json`),
      JSON.stringify({
        id: previousCheckId,
        cwd: worktree,
        argv: compiler,
        ownership: { taskId: task.id, attempt: 1 },
        status: 'finished',
        exitCode: 0,
        physicalRunId: previousPhysicalId,
      }),
    );
    writeFileSync(
      join(history, `${previousCheckId}.${previousPhysicalId}.json`),
      JSON.stringify({
        version: 1,
        id: previousCheckId,
        cwd: worktree,
        physicalRunId: previousPhysicalId,
        status: 'finished',
        remoteExpected: false,
        exitCode: 0,
        terminalProof: { local: true, remote: null, resultKnown: true, observedAt: new Date().toISOString() },
      }),
    );
    writeFileSync(
      attempt.logPath,
      [
        { type: 'thread.started', thread_id: 'typing-session' },
        { type: 'item.completed', item: { type: 'agent_message', text: refusal } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    );
    h.store.saveRetryIntent(retained.ref, { escalation: 'environment' });
    h.store.updateRetryIntent(retained.ref, (retry) => {
      retry.status = 'abandoned';
      retry.abandonedBy = 'stop';
    });
    h.store.event(retained.ref, 'attempt-progress', {
      startHead: head,
      endHead: head,
      uncommitted: false,
      progress: false,
    });
    h.store.event(retained.ref, 'termination-requested', { operation: 'stop', processIdentity: 'known' });
    h.store.event(retained.ref, 'stopped', {});
    h.settings.integration.operationsManager = 'operations';
    h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY,state TEXT NOT NULL)');
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
    const actor = { id: 'operations', sessionId: 'operations-session' };
    const landings: unknown[] = [];
    const landing = { enqueue: (value: unknown) => landings.push(value) };
    const recover = () => recoverWorkerTyping(h.tasks, landing, retained.ref, actor);
    h.store.updateTask(retained.ref, (current) => {
      current.state = 'cancelled';
    });
    await expect(recover()).rejects.toThrow();
    h.store.updateTask(retained.ref, (current) => {
      current.state = 'stopped';
    });
    h.store.updateAttempt(retained.ref, (current) => {
      current.state = 'stopped';
      current.endedAt = endedAt;
      current.exitCode = 0;
      current.failureKind = 'tool';
      current.result = refusal;
      current.checks = [previousCheckId];
      current.process = stoppedProcess;
      current.terminationIntent = {
        operation: 'stop',
        requestedAt,
        state: 'complete',
        processIdentity: 'known',
        process: stoppedProcess,
        auxiliaryProcesses: [],
        settledAt,
      };
    });

    const beforeStop = JSON.stringify(h.store.attempt(retained.ref).terminationIntent);
    const beforeRetry = JSON.stringify(h.store.retryIntent(retained.ref));

    const issued = await recover();
    expect(issued.status).toBe('pending');
    const issuedProof = recoveryProof(issued);
    expect(issuedProof.commands).toHaveLength(1);
    expect(issuedProof.commands[0]?.slice(-compiler.length)).toEqual(compiler);
    expect(issuedProof.env[TYPING_RECOVERY_ENV]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.store.attempt(retained.ref).typingEvidencePending?.command).toEqual(compiler);
    expect(JSON.stringify(h.store.attempt(retained.ref).terminationIntent)).toBe(beforeStop);
    expect(JSON.stringify(h.store.retryIntent(retained.ref))).toBe(beforeRetry);

    const savedEnvironment = { ...process.env };
    let physicalRunId = '';
    let checkId = '';
    let launchEnvironment: NodeJS.ProcessEnv | undefined;
    try {
      Object.assign(process.env, issuedProof.env);
      checkId = startWorkerCheck(compiler, worktree, (record, childEnv) => {
        physicalRunId = record.physicalRunId!;
        launchEnvironment = { ...childEnv };
      });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
      Object.assign(process.env, savedEnvironment);
    }
    const currentResult = join(results, `${checkId}.json`);
    expect(JSON.parse(readFileSync(currentResult, 'utf8'))).toMatchObject({ status: 'running', physicalRunId });
    await expect(recover()).rejects.toThrow('completed ordinary source with pending compiler evidence');

    if (!launchEnvironment) throw new Error('recovery check did not receive its admitted environment');
    const receiptEnv = {
      ...launchEnvironment,
      REZICS_TYPING_INPUTS_PHYSICAL: physicalRunId,
      REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(compiler)).toString('base64'),
    };
    recordWorkerCheckTypingInputs(launchEnvironment, worktree, physicalRunId, compiler);
    const completeReceipt = beginTypingInputReceipt(worktree, receiptEnv, compiler);
    if (!completeReceipt) throw new Error('recovery compiler did not begin a physical input receipt');
    completeReceipt(0);
    const compilerLog = join(h.settings.stateDirectory, 'reader-web-typecheck.log');
    writeFileSync(compilerLog, '');
    settleWorkerCheckHostBudget(launchEnvironment, 0, true, {
      argv: compiler,
      log: compilerLog,
      worktree,
      physicalRunId,
    });
    const completed = JSON.parse(readFileSync(currentResult, 'utf8')) as Record<string, unknown>;
    writeFileSync(currentResult, JSON.stringify({ ...completed, status: 'finished', exitCode: 0 }));
    writeFileSync(
      join(history, `${checkId}.${physicalRunId}.json`),
      JSON.stringify({
        version: 1,
        id: checkId,
        cwd: worktree,
        physicalRunId,
        status: 'finished',
        remoteExpected: false,
        exitCode: 0,
        terminalProof: { local: true, remote: null, resultKnown: true, observedAt: new Date().toISOString() },
      }),
    );

    const landed = await recover();
    expect(landed.status).toBe('landing');
    expect(landings).toHaveLength(1);
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.attempt(retained.ref).typingEvidencePending).toBeUndefined();
    expect(h.store.attempt(retained.ref).result).toContain('installed owning Web typecheck');
    expect(h.store.attempt(retained.ref).terminationIntent).toEqual(JSON.parse(beforeStop));
    expect(h.store.retryIntent(retained.ref)).toEqual(JSON.parse(beforeRetry));
    expect(readWorkerCheckHostStamp(budget, '3')).toMatchObject({
      exitCode: 0,
      typingRecovery: { checkId, physicalRunId },
      typingInputs: { exitCode: 0 },
    });
    expect(['1', '2'].map((stamp) => readFileSync(join(budget, stamp), 'utf8'))).toEqual(priorStamps);
    expect(readdirSync(join(budget, 'typing-recovery')).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  } finally {
    await h.disposeAsync();
  }
}, 20_000);
