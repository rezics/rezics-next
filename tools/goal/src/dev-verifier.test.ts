import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireDirectoryLease } from './lease.ts';
import { readControlPolicy } from './policy.ts';
import { checkSignature, runCacheKey, selectionIdentity } from './dev-verifier-comparison.ts';
import {
  testFailureRepairBrief,
  classifyRun,
  devVerificationState,
  placeInWorkspace,
  verifyDev,
  type TestFailureRepair,
} from './dev-verifier.ts';
import { placeInWorkspaceChecks, trackedFilesAt } from './dev-verifier-plan.ts';
import type { DevVerifierRun, Settings, Task } from './types.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'goal-dev-verifier-round-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(join(root, 'services/kernel'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'toolchain/bin'), { recursive: true });
  writeFileSync(join(root, 'services/kernel/base.ts'), 'export const base = true;\n');
  writeFileSync(join(root, 'scripts/typecheck.ts'), 'process.exit(0);\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(
    join(root, 'toolchain/package.json'),
    JSON.stringify({ name: 'bun', version: Bun.version, bin: { bun: 'bin/bun.exe' } }),
  );
  writeFileSync(join(root, 'toolchain/bin/bun.exe'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'verifier-fixture',
      packageManager: `bun@${Bun.version}`,
      dependencies: { bun: 'file:./toolchain' },
    }),
  );
  const lock = spawnSync(process.execPath, ['install', '--lockfile-only', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (lock.status !== 0) throw new Error(lock.stderr);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'branch', 'dev');
  git(root, 'branch', 'dev-verified');
  return root;
}

function commit(root: string, path: string, content: string, message: string): string {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  git(root, 'add', path);
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function landedTask(from: string, commitHead: string, id = 'kernel-task', paths = ['services/kernel/**']): Task {
  return {
    id,
    sequence: 1,
    state: 'integrated',
    worktree: '',
    branch: 'worker/task',
    base: from,
    taskClass: 'mechanical',
    currentAttempt: 1,
    createdAt: '',
    integratedBase: from,
    integratedCommit: commitHead,
    integratedCommits: [commitHead],
    brief: {
      id,
      goal: 'kernel',
      manager: 'kernel-manager',
      kind: 'implementation',
      paths,
      target: 'dev',
      riskAreas: [],
      acceptance: { command: ['acceptance', id], tests: [], failing: true },
    },
  } as unknown as Task;
}

function setup(root: string, tasks: Task[] = []) {
  const stateDirectory = join(root, '.state');
  const worktreeRoot = join(root, '.trees');
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const runs = new Map<string, DevVerifierRun>();
  const findings = new Map<string, any>();
  const updates: string[] = [];
  const store = {
    tasks: () => tasks,
    task: (id: string) => tasks.find((task) => task.id === id)!,
    updateTask: ({ taskId }: { taskId: string }, update: (task: Task) => void) => {
      const task = tasks.find((item) => item.id === taskId)!;
      update(task);
      updates.push(taskId);
      return task;
    },
    devVerifierRun: (key: string) => runs.get(key),
    devVerifierLatestRound: () => [...runs.values()].reverse().find((run) => run.round),
    saveDevVerifierRun: (run: DevVerifierRun) => runs.set(run.key, run),
    devVerifierFindings: () => [...findings.values()],
    saveDevVerifierFinding: (finding: any) => findings.set(finding.rangeKey, finding),
  };
  const settings = {
    mainCheckout: root,
    stateDirectory,
    worktreeRoot,
    integrationBranch: 'dev',
    affectedTests: [{ paths: ['services/kernel/**'], command: ['affected-check'] }],
  } as unknown as Settings;
  return {
    settings,
    store,
    runs,
    findings,
    updates,
    options: {
      settings,
      store,
    },
  };
}

function seedRound(ctx: ReturnType<typeof setup>, head: string, completedAt = Date.now() - 4_000_000): void {
  const ended = new Date(completedAt).toISOString();
  ctx.store.saveDevVerifierRun({
    key: 'dev-verifier-round:seed',
    createdAt: ended,
    evidence: {
      commit: head,
      command: ['dev-verifier-round'],
      passed: true,
      timedOut: false,
      output: '{}',
      logPath: '',
      result: 'pass',
    },
    round: {
      baseCommit: head,
      headCommit: head,
      startedAt: ended,
      completedAt: ended,
      durationMs: 0,
      testsRun: 0,
      passed: 0,
      failed: 0,
      unknown: 0,
      fullSuite: true,
      pendingChecks: [],
    },
  });
}

function makeRoundDue(ctx: ReturnType<typeof setup>): void {
  const previous = ctx.store.devVerifierLatestRound()!;
  previous.round!.completedAt = new Date(Date.now() - 4_000_000).toISOString();
}

test('the first round runs boot smoke then the full suite, batches current-head failures, records a summary and advances', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev-verified');
  commit(root, 'services/kernel/test/boot.test.ts', 'test("boot", () => {});\n', 'boot test');
  commit(root, 'services/kernel/test/a.test.ts', 'test("a", () => {});\n', 'test a');
  commit(root, 'services/kernel/test/b.test.ts', 'test("b", () => {});\n', 'test b');
  const target = commit(root, 'services/kernel/change.ts', 'export const changed = true;\n', 'landing');
  git(root, 'branch', '-f', 'dev', target);
  const ctx = setup(root, [landedTask(base, target, 'owner')]);
  ctx.settings.verifierChecks = [
    {
      paths: ['services/kernel/**'],
      command: ['bun', 'test', 'services/kernel/test/a.test.ts', 'services/kernel/test/b.test.ts'],
    },
    { paths: ['services/kernel/**'], command: ['unknown-check'] },
    { paths: ['services/kernel/**'], command: ['duplicate-a-check'] },
  ];
  ctx.settings.bootSmoke = { tests: ['services/kernel/test/boot.test.ts'] };
  const commands: string[][] = [];
  const checkedHeads: string[] = [];
  const repairs: TestFailureRepair[] = [];
  await verifyDev({
    ...ctx.options,
    runGate: async (command, cwd) => {
      commands.push([...command]);
      checkedHeads.push(git(cwd, 'rev-parse', 'HEAD'));
      if (command.includes('unknown-check'))
        return { passed: false, output: 'remote-check: no check host answered', timedOut: false };
      if (command.includes('duplicate-a-check'))
        return {
          passed: false,
          output: 'AssertionError: expected an additional value\nat services/kernel/test/a.test.ts:30',
          timedOut: false,
        };
      if (command.includes('services/kernel/test/a.test.ts'))
        return {
          passed: false,
          output:
            'AssertionError: expected one\nat services/kernel/test/a.test.ts:10\n' +
            'AssertionError: expected two\nat services/kernel/test/b.test.ts:20',
          timedOut: false,
        };
      return { passed: true, output: '', timedOut: false };
    },
    dispatchTestRepair: (repair) => repairs.push(repair),
  });

  const round = ctx.store.devVerifierLatestRound()!.round!;
  expect(commands[0]!.at(-1)).toBe('services/kernel/test/boot.test.ts');
  expect(commands.some((command) => command.includes('scripts/typecheck.ts'))).toBe(true);
  expect(commands).toContainEqual(
    expect.arrayContaining(['services/kernel/test/a.test.ts', 'services/kernel/test/b.test.ts']),
  );
  expect(checkedHeads.every((checkedHead) => checkedHead === target)).toBe(true);
  expect(round).toMatchObject({
    baseCommit: base,
    headCommit: target,
    fullSuite: true,
    testsRun: 5,
    passed: 2,
    failed: 2,
    unknown: 1,
    pendingChecks: [],
  });
  expect(round.durationMs).toBeGreaterThanOrEqual(0);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(target);
  expect(ctx.findings.size).toBe(3);
  expect(
    [...ctx.findings.values()].filter((finding) => finding.test === 'services/kernel/test/a.test.ts'),
  ).toHaveLength(1);
  expect(
    [...ctx.findings.values()].filter(
      (finding) => finding.test?.endsWith('a.test.ts') || finding.test?.endsWith('b.test.ts'),
    ),
  ).toHaveLength(2);
  expect(repairs).toHaveLength(1);
  expect(repairs[0]).toMatchObject({ goal: 'kernel', manager: 'kernel-manager', commit: target });
  expect(repairs[0]!.failures.map((failure) => failure.test).sort()).toEqual([
    'services/kernel/test/a.test.ts',
    'services/kernel/test/b.test.ts',
  ]);
  expect(repairs[0]!.failures.flatMap((failure) => failure.assertions)).toContain('AssertionError: expected one');
  expect(repairs[0]!.failures.find((failure) => failure.test?.endsWith('a.test.ts'))!.assertions).toContain(
    'AssertionError: expected an additional value',
  );
  expect(ctx.runs.size).toBeGreaterThan(4);

  let extraRuns = 0;
  await verifyDev({
    ...ctx.options,
    runGate: async () => (extraRuns++, { passed: true, output: '', timedOut: false }),
  });
  expect(extraRuns).toBe(0);
  expect([...ctx.runs.values()].filter((run) => run.round)).toHaveLength(1);
});

test('a due round selects changes since the last round head and skips intermediate dev heads', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev');
  const ctx = setup(root);
  seedRound(ctx, base);
  const first = commit(root, 'services/kernel/a.ts', 'export const a = true;\n', 'landing a');
  const second = commit(root, 'services/kernel/b.ts', 'export const b = true;\n', 'landing b');
  git(root, 'branch', '-f', 'dev', second);
  ctx.store.tasks().push(landedTask(base, first, 'task-a'), landedTask(base, second, 'task-b'));

  const firstCommands: { command: string[]; head: string }[] = [];
  let movedTo: string | undefined;
  await verifyDev({
    ...ctx.options,
    runGate: async (command, cwd) => {
      firstCommands.push({ command: [...command], head: git(cwd, 'rev-parse', 'HEAD') });
      if (!movedTo) {
        movedTo = commit(root, 'services/kernel/c.ts', 'export const c = true;\n', 'landing c');
        git(root, 'branch', '-f', 'dev', movedTo);
      }
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(firstCommands.length).toBeGreaterThan(1);
  expect(firstCommands.every(({ head: checked }) => checked === second)).toBe(true);
  expect(firstCommands.some(({ command }) => command.join(' ').includes('acceptance task-a'))).toBe(true);
  expect(firstCommands.some(({ command }) => command.join(' ').includes('acceptance task-b'))).toBe(true);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(second);
  expect(git(root, 'rev-parse', 'dev')).toBe(movedTo!);

  makeRoundDue(ctx);
  const secondCommands: { command: string[]; head: string }[] = [];
  await verifyDev({
    ...ctx.options,
    runGate: async (command, cwd) => {
      secondCommands.push({ command: [...command], head: git(cwd, 'rev-parse', 'HEAD') });
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(secondCommands.length).toBeGreaterThan(0);
  expect(secondCommands.every(({ head: checked }) => checked === movedTo)).toBe(true);
  expect(secondCommands.some(({ command }) => command.join(' ').includes('acceptance task-a'))).toBe(false);
  expect(secondCommands.some(({ command }) => command.join(' ').includes('acceptance task-b'))).toBe(false);
  expect(secondCommands.some(({ command }) => command.join(' ').includes('acceptance task-c'))).toBe(false);
  expect(secondCommands.some(({ command }) => command.some((part) => part.includes('services/kernel/c.ts')))).toBe(
    true,
  );
  expect(ctx.store.devVerifierLatestRound()!.round).toMatchObject({
    baseCommit: second,
    headCommit: movedTo,
    fullSuite: false,
  });
  expect(devVerificationState(root).behind).toBe(0);
});

test('dependency setup infrastructure is unknown but still advances the captured head', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev');
  git(root, 'rm', 'bun.lock');
  git(root, 'commit', '-m', 'remove fixture lock');
  const target = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', '-f', 'dev', target);
  const ctx = setup(root);
  ctx.settings.verifierChecks = [{ paths: ['services/kernel/**'], command: ['kernel-check'] }];
  let gateRuns = 0;

  await verifyDev({
    ...ctx.options,
    runGate: async () => (gateRuns++, { passed: true, output: '', timedOut: false }),
  });

  expect(gateRuns).toBe(0);
  expect(ctx.store.devVerifierLatestRound()!.round).toMatchObject({
    baseCommit: base,
    headCommit: target,
    testsRun: 2,
    passed: 0,
    failed: 0,
    unknown: 2,
    pendingChecks: expect.arrayContaining([expect.objectContaining({ command: ['kernel-check'] })]),
  });
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(target);
});

test('an oversized changed range runs every configured check and the complete sibling test set', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev');
  const testFile = 'apps/widget/tests/widget.test.ts';
  const testHead = commit(root, testFile, 'test("widget", () => {});\n', 'add widget test');
  const target = commit(root, 'services/kernel/change.ts', 'export const value = true;\n', 'kernel change');
  git(root, 'branch', '-f', 'dev', target);
  const ctx = setup(root);
  seedRound(ctx, base);
  ctx.settings.policy = readControlPolicy({ verifier: { maxSelectionCommits: 1 } });
  ctx.settings.verifierChecks = [
    { paths: ['services/kernel/**'], command: ['kernel-check'] },
    { paths: ['apps/web/**'], command: ['web-full-check'] },
  ];
  ctx.settings.siblingTests = { command: ['bun', 'test'] };
  const commands: string[][] = [];
  await verifyDev({
    ...ctx.options,
    runGate: async (command) => {
      commands.push([...command]);
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(commands.some((command) => command.includes('kernel-check'))).toBe(true);
  expect(commands.some((command) => command.includes('web-full-check'))).toBe(true);
  expect(commands.some((command) => command.includes(testFile))).toBe(true);
  expect(commands.some((command) => command.includes('scripts/typecheck.ts'))).toBe(true);
  expect(ctx.store.devVerifierLatestRound()!.round).toMatchObject({ headCommit: target, fullSuite: true });
  expect(testHead).not.toBe(target);
});

test('checks not reached at the round deadline carry into the next due round', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev');
  const target = commit(root, 'services/kernel/change.ts', 'export const value = true;\n', 'landing');
  git(root, 'branch', '-f', 'dev', target);
  const ctx = setup(root);
  seedRound(ctx, base);
  ctx.settings.policy = readControlPolicy({
    verifier: { roundDeadlineMs: 1000, roundIntervalMs: 60000, concurrency: 3 },
  });
  ctx.settings.verifierChecks = Array.from({ length: 5 }, (_, index) => ({
    paths: ['services/kernel/**'],
    command: ['check-' + index],
  }));
  const started: string[] = [];
  await verifyDev({
    ...ctx.options,
    runGate: async (command, _cwd, _logPath, options) => {
      started.push(command.at(-1)!);
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { passed: false, output: 'ETIMEDOUT at round deadline', timedOut: true };
    },
  });
  const first = ctx.store.devVerifierLatestRound()!.round!;
  expect(started).toHaveLength(3);
  expect(first).toMatchObject({ headCommit: target, testsRun: 3, unknown: 3 });
  expect(first.pendingChecks).toHaveLength(3);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(target);

  makeRoundDue(ctx);
  ctx.settings.policy = readControlPolicy({
    verifier: { roundDeadlineMs: 1000, roundIntervalMs: 60000, concurrency: 3 },
  });
  const carried = first.pendingChecks.map((check) => check.command.at(-1)!);
  const nextCommands: string[] = [];
  await verifyDev({
    ...ctx.options,
    runGate: async (command) => {
      nextCommands.push(command.at(-1)!);
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(nextCommands.sort()).toEqual(carried.sort());
  expect(ctx.store.devVerifierLatestRound()!.round).toMatchObject({
    testsRun: 3,
    passed: 3,
    failed: 0,
    unknown: 0,
    pendingChecks: [],
  });
});

test('a round started while another holds the lease is skipped', async () => {
  const root = repo();
  const ctx = setup(root);
  let pageDataRuns = 0;
  let checkRuns = 0;
  const lease = acquireDirectoryLease(join(ctx.settings.stateDirectory, 'dev-verifier.lease'));
  try {
    await verifyDev({
      ...ctx.options,
      runPageData: async () => void (pageDataRuns += 1),
      runGate: async () => ((checkRuns += 1), { passed: true, output: '', timedOut: false }),
    });
  } finally {
    lease.release();
  }
  expect(pageDataRuns).toBe(1);
  expect(checkRuns).toBe(0);
  expect(ctx.store.devVerifierLatestRound()).toBeUndefined();
});

for (const pageDataOutcome of ['success', 'failure'] as const) {
  test(`a pending page-data ${pageDataOutcome} permits an independent native round and retains both lifetimes`, async () => {
    const root = repo();
    const ctx = setup(root);
    ctx.settings.verifierChecks = [{ paths: ['services/kernel/**'], command: ['independent-native-check'] }];
    const pageData = Promise.withResolvers<void>();
    const roundFinished = Promise.withResolvers<void>();
    const originalSave = ctx.store.saveDevVerifierRun;
    ctx.store.saveDevVerifierRun = (run) => {
      const saved = originalSave(run);
      if (run.round) roundFinished.resolve();
      return saved;
    };
    const pageDataFailure = new Error('original page-data producer failure');
    let nativeRuns = 0;
    let invocationFinished = false;
    const invocation = verifyDev({
      ...ctx.options,
      runPageData: async () => {
        const lease = acquireDirectoryLease(join(ctx.settings.stateDirectory, 'page-data.lease'));
        try {
          await pageData.promise;
        } finally {
          lease.release();
        }
      },
      runGate: async () => {
        nativeRuns += 1;
        return { passed: true, output: '', timedOut: false };
      },
    }).then(
      () => {
        invocationFinished = true;
        return undefined;
      },
      (error: unknown) => {
        invocationFinished = true;
        return error;
      },
    );
    const timeout = setTimeout(() => roundFinished.reject(new Error('native round waited for page-data')), 2000);
    try {
      await roundFinished.promise;
      // The round record is saved before its awaiting owner releases the lease.
      await Promise.resolve();
      expect(nativeRuns).toBeGreaterThan(0);
      expect(ctx.store.devVerifierLatestRound()!.round!.failed).toBe(0);
      expect(invocationFinished).toBe(false);
      expect(existsSync(join(ctx.settings.stateDirectory, 'dev-verifier.lease'))).toBe(false);
      expect(existsSync(join(ctx.settings.stateDirectory, 'page-data.lease'))).toBe(true);
      if (pageDataOutcome === 'failure') pageData.reject(pageDataFailure);
      else pageData.resolve();
      expect(await invocation).toBe(pageDataOutcome === 'failure' ? pageDataFailure : undefined);
      expect(existsSync(join(ctx.settings.stateDirectory, 'page-data.lease'))).toBe(false);
    } finally {
      clearTimeout(timeout);
      pageData.resolve();
      await invocation;
    }
  });
}

test('classification and workspace placement preserve the existing verifier check contracts', () => {
  expect(classifyRun({ passed: true, timedOut: false, output: '' })).toBe('pass');
  expect(classifyRun({ passed: false, timedOut: false, output: 'AssertionError: expected value' })).toBe('fail');
  expect(classifyRun({ passed: false, timedOut: true, output: 'ETIMEDOUT' })).toBe('infrastructure');
  expect(classifyRun({ passed: false, timedOut: false, output: 'remote-check: no check host answered' })).toBe(
    'infrastructure',
  );
  expect(classifyRun({ passed: false, timedOut: false, output: 'cannot find module fixture' })).toBe('infrastructure');
  expect(
    classifyRun({
      passed: false,
      timedOut: false,
      output: 'Web check unavailable: this callable browser/check worker requires an actual remote run directory.',
    }),
  ).toBe('infrastructure');
  expect(classifyRun({ passed: false, timedOut: false, output: 'generate failed with status 1' })).toBe(
    'infrastructure',
  );
  expect(
    placeInWorkspace(
      { command: ['env', 'NO_COLOR=1', 'bun', 'test', 'apps/web/tests/example.test.ts'], closure: ['apps/web/**'] },
      new Set(['apps/web/bunfig.toml']),
    ),
  ).toEqual({
    command: [
      'env',
      'NO_COLOR=1',
      'WEB_BROWSER_CHECK_CONCURRENCY=1',
      'WEB_UNIT_CHECK_CONCURRENCY=1',
      'WEB_CHECK_SERIAL_LANES=1',
      'bun',
      'scripts/check.ts',
      '--skip-format',
      'tests/example.test.ts',
    ],
    closure: ['apps/web/**'],
    cwd: 'apps/web',
  });
  expect(
    placeInWorkspace(
      { command: ['env', 'NO_COLOR=1', 'bun', 'test', 'services/kernel/test/example.test.ts'], closure: ['**'] },
      new Set(['services/kernel/bunfig.toml']),
    ),
  ).toEqual({
    command: ['env', 'NO_COLOR=1', 'bun', 'test', 'test/example.test.ts'],
    closure: ['**'],
    cwd: 'services/kernel',
  });
});

test('Web verifier selections reach check.ts one file at a time with the captured candidate and original selectors', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev');
  commit(root, 'apps/web/bunfig.toml', '[test]\npathIgnorePatterns = ["**/*.host.test.ts"]\n', 'web test config');
  commit(root, 'apps/web/tests/boot/client-graph.test.ts', 'test("client graph", () => {});\n', 'web boot smoke');
  commit(root, 'apps/web/tests/unit/session-state.test.ts', 'test("session state", () => {});\n', 'web unit one');
  commit(root, 'apps/web/tests/unit/session-mocks.test.ts', 'test("session mocks", () => {});\n', 'web unit two');
  commit(
    root,
    'apps/web/tests/browser/server-regression.test.ts',
    'browser.launch();\ntest("server regression", () => {});\n',
    'web browser regression',
  );
  commit(root, 'apps/web/tests/native/auth-binding.host.test.ts', 'test("host fixture", () => {});\n', 'web host test');
  const target = commit(root, 'apps/web/src/current-head.ts', 'export const currentHead = true;\n', 'web landing');
  git(root, 'branch', '-f', 'dev', target);
  const fullSelection = placeInWorkspaceChecks(
    { command: ['bun', 'test'], closure: ['apps/web/**'] },
    trackedFilesAt(root, target),
    root,
  );
  expect(fullSelection.map((check) => check.command.at(-1))).toEqual([
    'tests/boot/client-graph.test.ts',
    'tests/browser/server-regression.test.ts',
    'tests/unit/session-mocks.test.ts',
    'tests/unit/session-state.test.ts',
  ]);
  const selectedHost = placeInWorkspaceChecks(
    {
      command: ['bun', 'test', 'apps/web/tests/native/auth-binding.host.test.ts'],
      closure: ['apps/web/**'],
    },
    trackedFilesAt(root, target),
    root,
  );
  expect(selectedHost).toHaveLength(1);
  expect(selectedHost[0]!.command).toContain('--host');
  expect(selectedHost[0]!.command).toContain('tests/native/auth-binding.host.test.ts');
  const owner = landedTask(base, target, 'web-owner', ['apps/web/**']);
  const ctx = setup(root, [owner]);
  ctx.settings.bootSmoke = { tests: ['apps/web/tests/boot/client-graph.test.ts'] };
  ctx.settings.verifierChecks = [
    {
      paths: ['apps/web/**'],
      command: [
        'env',
        '-C',
        'apps/web',
        'WEB_UNIT_CHECK_CONCURRENCY=9',
        'NO_COLOR=1',
        'bun',
        'test',
        'apps/web/tests/unit/session-state.test.ts',
        'tests/unit/session-mocks.test.ts',
        join(root, 'apps/web/tests/browser/server-regression.test.ts'),
        '-t',
        'current selection',
      ],
    },
  ];
  const calls: { command: string[]; cwd: string; head: string }[] = [];
  const repairs: TestFailureRepair[] = [];
  let browserRetry = false;

  await verifyDev({
    ...ctx.options,
    runGate: async (command, cwd) => {
      calls.push({ command: [...command], cwd, head: git(cwd, 'rev-parse', 'HEAD') });
      if (command.includes('tests/browser/server-regression.test.ts') && !browserRetry) {
        browserRetry = true;
        return {
          passed: false,
          output: 'remote-check: downloaded Bun does not match packageManager\nat apps/web/tests/unrelated.test.ts:10',
          timedOut: false,
        };
      }
      if (command.includes('tests/browser/server-regression.test.ts'))
        return {
          passed: false,
          output: 'AssertionError: expected the current server response\nat tests/browser/server-regression.test.ts:18',
          timedOut: false,
        };
      return { passed: true, output: '', timedOut: false };
    },
    dispatchTestRepair: (repair) => repairs.push(repair),
  });

  const boot = calls.find(({ command }) => command.includes('scripts/focused.ts'))!;
  expect(boot.command).toContain('--private-network');
  expect(boot.cwd.endsWith('/apps/web')).toBe(true);
  const webCalls = calls.filter(({ command }) => command.includes('scripts/check.ts'));
  expect(webCalls).toHaveLength(4);
  expect(webCalls.every(({ cwd, head }) => cwd.endsWith('/apps/web') && head === target)).toBe(true);
  expect(webCalls.every(({ command }) => !command.includes('--tests-only') && command.includes('--skip-format'))).toBe(
    true,
  );
  expect(webCalls.every(({ command }) => command.includes('WEB_BROWSER_CHECK_CONCURRENCY=1'))).toBe(true);
  expect(webCalls.every(({ command }) => command.includes('WEB_UNIT_CHECK_CONCURRENCY=1'))).toBe(true);
  expect(webCalls.every(({ command }) => command.includes('WEB_CHECK_SERIAL_LANES=1'))).toBe(true);
  expect(
    webCalls.every(
      ({ command }) => command.includes('NO_COLOR=1') && !command.includes('WEB_UNIT_CHECK_CONCURRENCY=9'),
    ),
  ).toBe(true);
  expect(webCalls.every(({ command }) => command.includes('-t') && command.includes('current selection'))).toBe(true);
  expect(new Set(webCalls.map(({ command }) => command.at(-1)))).toEqual(
    new Set([
      'tests/unit/session-state.test.ts',
      'tests/unit/session-mocks.test.ts',
      'tests/browser/server-regression.test.ts',
    ]),
  );
  expect(webCalls.filter(({ command }) => command.at(-1) === 'tests/browser/server-regression.test.ts')).toHaveLength(
    2,
  );

  const finding = [...ctx.findings.values()].find(
    (item) => item.test === 'apps/web/tests/browser/server-regression.test.ts',
  );
  expect(finding).toMatchObject({
    headCommit: target,
    assertion: 'AssertionError: expected the current server response',
    head: { commit: target, command: expect.arrayContaining(['tests/browser/server-regression.test.ts']) },
  });
  expect(finding?.head?.output).toContain('apps/web/tests/unrelated.test.ts');
  expect(finding?.head?.output).toContain('AssertionError: expected the current server response');
  expect(repairs).toHaveLength(1);
  expect(repairs[0]!.failures.map((failure) => failure.test)).toEqual([
    'apps/web/tests/browser/server-regression.test.ts',
  ]);
});

test('Web failure attribution keeps the selected file before trailing program arguments', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev');
  commit(root, 'apps/web/bunfig.toml', '[test]\n', 'web test config');
  const file = 'apps/web/tests/selected.test.ts';
  const target = commit(root, file, 'test("selected", () => {});\n', 'web selected test');
  git(root, 'branch', '-f', 'dev', target);
  const ctx = setup(root, [landedTask(base, target, 'web-owner', ['apps/web/**'])]);
  ctx.settings.verifierChecks = [{ paths: ['apps/web/**'], command: ['bun', 'test', file, '--', 'fixture.test.ts'] }];
  const commands: string[][] = [];
  await verifyDev({
    ...ctx.options,
    runGate: async (command) => {
      commands.push([...command]);
      if (!command.includes('scripts/check.ts')) return { passed: true, timedOut: false, output: '' };
      return {
        passed: false,
        timedOut: false,
        output: 'AssertionError: selected child failed\nat tests/unrelated.test.ts:18',
      };
    },
  });
  expect(commands.find((command) => command.includes('scripts/check.ts'))?.slice(-3)).toEqual([
    'tests/selected.test.ts',
    '--',
    'fixture.test.ts',
  ]);
  expect([...ctx.findings.values()].map((finding) => finding.test)).toEqual([file]);
});

test('deadline cancellation records the first cause and carries each unstarted Web file selection', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev');
  commit(root, 'apps/web/bunfig.toml', '[test]\n', 'web test config');
  const files = ['one', 'two', 'three', 'four', 'five'].map((name) => `apps/web/tests/${name}.test.ts`);
  for (const [index, file] of files.entries()) commit(root, file, `test("${index}", () => {});\n`, `web test ${index}`);
  const target = commit(root, 'apps/web/src/change.ts', 'export const changed = true;\n', 'web change');
  git(root, 'branch', '-f', 'dev', target);
  const ctx = setup(root);
  seedRound(ctx, base);
  ctx.settings.policy = readControlPolicy({
    verifier: { roundDeadlineMs: 1200, roundIntervalMs: 60000, concurrency: 1 },
  });
  ctx.settings.verifierChecks = [{ paths: ['apps/web/**'], command: ['bun', 'test', ...files] }];
  const started: { cwd: string; command: string[] }[] = [];
  let cleanupFinished = false;

  await verifyDev({
    ...ctx.options,
    runGate: async (command, cwd, _logPath, options) => {
      if (!command.includes('scripts/check.ts')) return { passed: true, output: '', timedOut: false };
      started.push({ cwd, command: [...command] });
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      cleanupFinished = true;
      return {
        passed: false,
        output: 'remote-check: candidate run cancelled\ncleanup: temporary run directory removed',
        timedOut: true,
      };
    },
  });

  const round = ctx.store.devVerifierLatestRound()!.round!;
  expect(started).toHaveLength(1);
  expect(cleanupFinished).toBe(true);
  expect(existsSync(started[0]!.cwd)).toBe(false);
  expect(round).toMatchObject({ testsRun: 2, passed: 1, unknown: 1 });
  expect(round.pendingChecks).toHaveLength(files.length - 1);
  expect(round.pendingChecks.every((check) => check.command.includes('scripts/check.ts'))).toBe(true);
  expect(round.pendingChecks.map((check) => check.command.at(-1))).toEqual(
    files.slice(1).map((file) => file.slice('apps/web/'.length)),
  );
  const unknown = [...ctx.findings.values()].find((item) => item.status === 'unknown');
  expect(unknown?.head?.output).toContain('cleanup: temporary run directory removed');
});

test('routed result identity includes the effective Web file and captured candidate', () => {
  const root = repo();
  const ctx = setup(root);
  const check = (file: string) => {
    const selected = {
      command: ['env', 'WEB_UNIT_CHECK_CONCURRENCY=1', 'bun', 'scripts/check.ts', '--skip-format', file],
      closure: ['apps/web/**'],
      cwd: 'apps/web',
    };
    return { ...selected, index: 0, signature: checkSignature(selected, 0) };
  };
  const one = check('tests/one.test.ts');
  const sameSelection = selectionIdentity([one]);
  const key = runCacheKey(ctx.settings, 'a'.repeat(40), one, sameSelection);

  expect(runCacheKey(ctx.settings, 'a'.repeat(40), one, sameSelection)).toBe(key);
  expect(runCacheKey(ctx.settings, 'b'.repeat(40), one, sameSelection)).not.toBe(key);
  const otherFile = check('tests/two.test.ts');
  expect(runCacheKey(ctx.settings, 'a'.repeat(40), otherFile, selectionIdentity([otherFile]))).not.toBe(key);
});

import './dev-verifier-ownership.test.ts';

test('command repair diagnostics preserve argv and never call an env assignment a test file', () => {
  const command = [
    'env',
    'TYPECHECK_CHANGED=apps/web/src/routes/a.ts apps/web/src/routes/b.ts',
    'bun',
    'scripts/typecheck.ts',
  ];
  const owner = { brief: { goal: 'web', riskAreas: [] } } as unknown as Task;
  const failure = {
    test: JSON.stringify(command),
    assertions: ['original compiler failure'],
    error: 'TS2322: original error',
    owner,
  };
  const markdown = testFailureRepairBrief({
    goal: 'web',
    manager: 'content',
    commit: 'retained-source',
    owner,
    failures: [failure],
    paths: ['apps/web'],
  });
  expect(markdown).toContain('- Command: `' + JSON.stringify(command) + '`');
  expect(markdown).not.toContain('- Test file:');
  expect(markdown).toContain('TS2322: original error');
  const file = testFailureRepairBrief({
    goal: 'web',
    manager: 'content',
    commit: 'retained-source',
    owner,
    failures: [{ ...failure, test: 'apps/web/tests/regression.test.ts' }],
    paths: ['apps/web'],
  });
  expect(file).toContain('- Test file: `apps/web/tests/regression.test.ts`');
});
