import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  classifyRun,
  devVerificationState,
  placeInWorkspace,
  VERIFY_CONCURRENCY,
  verifyDev,
  withTreeBun,
} from './dev-verifier.ts';
import type { DevVerifierFinding, DevVerifierRun, Settings, Task } from './types.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'goal-dev-verifier-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(join(root, 'services', 'kernel'), { recursive: true });
  writeFileSync(join(root, 'services', 'kernel', 'base.ts'), 'export const base = true;\n');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'typecheck.ts'), 'process.exit(0);\n');
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
function setup(root: string, tasks: Task[] = []) {
  const stateDirectory = join(root, '.state'),
    worktreeRoot = join(root, '.trees');
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const updates: string[] = [];
  const runs = new Map<string, DevVerifierRun>();
  const findings: DevVerifierFinding[] = [];
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
    saveDevVerifierRun: (run: DevVerifierRun) => runs.set(run.key, run),
    devVerifierFindings: () => findings,
    saveDevVerifierFinding: (finding: DevVerifierFinding) => findings.push(finding),
  };
  const inboxEvents: any[] = [];
  const settings = {
    mainCheckout: root,
    stateDirectory,
    worktreeRoot,
    integrationBranch: 'dev',
    affectedTests: [{ paths: ['services/kernel/**'], command: ['affected-check'] }],
  } as unknown as Settings;
  return { settings, store, updates, inbox: { deliver: (event: any) => inboxEvents.push(event) }, inboxEvents };
}
function landedTask(from: string, commitHead: string, id = 'kernel-task'): Task {
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
      paths: ['services/kernel/**'],
      target: 'dev',
      acceptance: { command: ['acceptance', id], tests: [], failing: true },
    } as any,
  } as Task;
}

test('classifies check outcomes and runs Web tests from their workspace', () => {
  expect(classifyRun({ passed: true, timedOut: false, output: '' })).toBe('pass');
  expect(classifyRun({ passed: false, timedOut: false, output: 'assertion failed' })).toBe('fail');
  expect(classifyRun({ passed: false, timedOut: true, output: 'ETIMEDOUT' })).toBe('infrastructure');

  expect(
    placeInWorkspace(
      { command: ['env', 'NO_COLOR=1', 'bun', 'test', 'apps/web/tests/example.test.ts'], closure: ['apps/web/**'] },
      new Set(['apps/web/bunfig.toml']),
    ),
  ).toEqual({
    command: ['env', 'NO_COLOR=1', 'bun', 'test', 'tests/example.test.ts'],
    closure: ['apps/web/**'],
    cwd: 'apps/web',
  });
});

test('selects the repository Bun executable for verifier checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-pinned-bun-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.4-canary.test' }));
  writeFileSync(join(root, 'node_modules/.bin/bun'), '');

  const command = withTreeBun(['bun', 'test', 'tests/example.test.ts'], root);
  expect(command[0]).toBe('env');
  expect(command[2]).toBe(join(root, 'node_modules/.bin/bun'));
  expect(command[1]).toContain(`PATH=${join(root, 'node_modules/.bin')}:`);
});

test.each([false, true])('bootstraps a fresh pinned tree (install fails: %s)', async (fails) => {
  const root = repo(),
    base = git(root, 'rev-parse', 'dev-verified');
  mkdirSync(join(root, 'toolchain'));
  writeFileSync(
    join(root, 'toolchain/package.json'),
    JSON.stringify({ name: 'bun', version: Bun.version, bin: './bun' }),
  );
  writeFileSync(join(root, 'toolchain/bun'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: `bun@${Bun.version}`, dependencies: { bun: 'file:./toolchain' } }),
  );
  const lock = spawnSync(process.execPath, ['install', '--lockfile-only', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(lock.status, lock.stderr).toBe(0);
  if (fails) writeFileSync(join(root, 'bun.lock'), 'invalid lockfile');
  git(root, 'add', 'package.json', 'bun.lock', 'toolchain');
  git(root, 'commit', '-m', 'pin Bun on dev');
  const landing = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', '-f', 'dev', landing);
  git(root, 'checkout', '--detach', base);
  expect(existsSync(join(root, 'node_modules/.bin/bun'))).toBe(false);
  const ctx = setup(root);
  let checks = 0;
  const runGate = async (command: readonly string[], cwd: string) => {
    expect(command).toContain(join(cwd, 'node_modules/.bin/bun'));
    const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: 'utf8' });
    checks++;
    return { passed: result.status === 0, output: result.stdout + result.stderr, timedOut: false };
  };
  // Keep successful setup evidence across a restart, but request the check again in a new tree.
  const store = {
    ...ctx.store,
    devVerifierRun: (key: string) => {
      const run = ctx.store.devVerifierRun(key);
      return run?.evidence.command.includes('install') ? run : undefined;
    },
  };
  for (let restart = 0; restart < 2; restart++) {
    git(root, 'branch', '-f', 'dev-verified', base);
    await verifyDev({ ...ctx, store, runGate });
  }
  expect(checks).toBe(fails ? 0 : 2);
  const findings = ctx.store.devVerifierFindings();
  if (fails) {
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.result === 'infrastructure')).toBe(true);
  } else expect(findings).toEqual([]);
  const logs = readdirSync(ctx.settings.stateDirectory).filter((name) => name.startsWith('dev-verify-install-'));
  expect(logs).toHaveLength(2);
  for (const log of logs) {
    expect(readFileSync(join(ctx.settings.stateDirectory, log), 'utf8')).toContain(
      `$ ${process.execPath} install --frozen-lockfile`,
    );
  }
});

test('reuses a failed verifier check while its workspace inputs stay unchanged', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev-verified');
  const landing = commit(root, 'services/kernel/change.ts', 'export const changed = true;\n', 'landing');
  git(root, 'branch', '-f', 'dev', landing);
  const ctx = setup(root);
  let failedCalls = 0;
  const runGate = async (command: readonly string[], cwd: string) => {
    if (command.includes('affected-check')) {
      const hasChange = git(cwd, 'ls-files').includes('services/kernel/change.ts');
      if (hasChange) failedCalls++;
      return hasChange
        ? { passed: false, output: 'assertion failed', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    }
    return { passed: true, output: '', timedOut: false };
  };

  await verifyDev({ ...ctx, runGate });
  expect(ctx.store.devVerifierFindings?.().some((finding) => finding.result === 'fail')).toBe(true);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(base);

  const docs = commit(root, 'docs/readme.md', 'Updated.\n', 'docs');
  git(root, 'branch', '-f', 'dev', docs);
  await verifyDev({ ...ctx, runGate });
  expect(failedCalls).toBe(1);
});

test('worker-owned briefs keep affected verification without inventing an acceptance command', async () => {
  const root = repo(),
    base = git(root, 'rev-parse', 'dev-verified');
  const landing = commit(root, 'services/kernel/change.ts', 'export const changed = true;\n', 'outcome');
  git(root, 'branch', '-f', 'dev', landing);
  const task = landedTask(base, landing);
  task.brief.acceptance = { command: [], tests: [], failing: true, workerOwned: true };
  const ctx = setup(root, [task]);
  const commands: string[] = [];
  await verifyDev({
    ...ctx,
    runGate: async (command) => {
      commands.push(command.join(' '));
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(commands).toContain('affected-check');
  expect(commands).not.toContain('');
  expect(commands.some((command) => command.startsWith('acceptance'))).toBe(false);
  expect(devVerificationState(root).behind).toBe(0);
});

test('passes all work since dev-verified once and advances the ref to the captured dev head', async () => {
  const root = repo();
  const first = commit(root, 'services/kernel/one.ts', 'export const one = 1;\n', 'landing one');
  const second = commit(root, 'services/kernel/two.ts', 'export const two = 2;\n', 'landing two');
  git(root, 'branch', '-f', 'dev', second);
  const ctx = setup(root, [
    landedTask(git(root, 'rev-parse', 'dev-verified'), first),
    landedTask(git(root, 'rev-parse', 'dev-verified'), second, 'task-two'),
  ]);
  const commands: string[] = [];
  await verifyDev({
    ...ctx,
    runGate: async (command) => {
      commands.push(command.join(' '));
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(second);
  expect(commands.some((command) => command.includes('bun scripts/typecheck.ts'))).toBe(true);
  expect(commands).toContain('affected-check');
  expect(commands).toContain('acceptance kernel-task');
  expect(commands).toContain('acceptance task-two');
  expect(devVerificationState(root).behind).toBe(0);
});

import './dev-verifier-ownership.test.ts';

test('failure bisects workspace suspects, reverts only the culprit, returns its task with the log, and advances verified', async () => {
  const root = repo(),
    base = git(root, 'rev-parse', 'dev-verified');
  const good = commit(root, 'services/kernel/good.ts', 'export const good = true;\n', 'good landing');
  const bad = commit(root, 'services/kernel/bad.ts', 'export const bad = false;\n', 'bad landing');
  git(root, 'branch', '-f', 'dev', bad);
  const unrelatedCommit = commit(root, 'docs/readme.md', 'docs\n', 'unrelated landing');
  git(root, 'branch', '-f', 'dev', unrelatedCommit);
  const tasks = [
    landedTask(base, good, 'good'),
    landedTask(base, bad, 'bad'),
    {
      ...landedTask(base, unrelatedCommit, 'docs'),
      brief: { ...landedTask(base, unrelatedCommit, 'docs').brief, paths: ['docs/**'] },
    } as Task,
  ];
  const ctx = setup(root, tasks);
  const runGate = async (command: readonly string[], cwd: string, logPath: string) => {
    const files = git(cwd, 'ls-files');
    if (command.includes('affected-check') && files.includes('services/kernel/bad.ts')) {
      writeFileSync(logPath, 'assertion failed');
      return { passed: false, output: 'assertion failed', timedOut: false };
    }
    return { passed: true, output: '', timedOut: false };
  };
  await verifyDev({ ...ctx, runGate });
  expect(spawnSync('git', ['cat-file', '-e', `dev:${'services/kernel/bad.ts'}`], { cwd: root }).status).not.toBe(0);
  expect(git(root, 'show', `dev:${'services/kernel/good.ts'}`)).toContain('good');
  expect(ctx.updates).toEqual(['bad']);
  expect(ctx.inboxEvents[0].managerId).toBe('kernel-manager');
  expect(ctx.inboxEvents[0].evidencePath).toBeTruthy();
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(git(root, 'rev-parse', 'dev'));
});

test('promotion candidates use dev-verified while worker bases use the dev head', async () => {
  const taskSource = await Bun.file(new URL('./tasks.ts', import.meta.url)).text();
  const promotionSource = await Bun.file(new URL('./promotion.ts', import.meta.url)).text();
  expect(taskSource).not.toContain('existingVerifiedBranch');
  expect(promotionSource).toContain("'dev-verified'");
});

test('infrastructure failure reruns only that command and never reverts a landing', async () => {
  const root = repo(),
    base = git(root, 'rev-parse', 'dev-verified');
  const landing = commit(root, 'services/kernel/change.ts', 'export const change = true;\n', 'landing');
  git(root, 'branch', '-f', 'dev', landing);
  const ctx = setup(root, [landedTask(base, landing)]);
  const calls: string[] = [];
  await verifyDev({
    ...ctx,
    runGate: async (command, _cwd, logPath) => {
      calls.push(command.join(' '));
      if (calls.length === 1) writeFileSync(logPath, 'ETIMEDOUT');
      return calls.length === 1
        ? { passed: false, output: 'ETIMEDOUT', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    },
  });
  expect(calls.filter((command) => command.includes('bun scripts/typecheck.ts'))).toHaveLength(2);
  expect(calls.filter((command) => command === 'affected-check')).toHaveLength(1);
  expect(calls.filter((command) => command === 'acceptance kernel-task')).toHaveLength(1);
  expect(git(root, 'rev-parse', 'dev')).toBe(landing);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(landing);
});

test('runs at most VERIFY_CONCURRENCY checks at once and still runs every check', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev-verified');
  const tasks: Task[] = [];
  let head = base;
  for (let index = 0; index < 8; index++) {
    head = commit(root, `services/kernel/file-${index}.ts`, `export const value = ${index};\n`, `landing ${index}`);
    tasks.push(landedTask(base, head, `task-${index}`));
  }
  git(root, 'branch', '-f', 'dev', head);
  const ctx = setup(root, tasks);
  const commands: string[] = [];
  let running = 0,
    highest = 0;
  await verifyDev({
    ...ctx,
    runGate: async (command) => {
      running++;
      highest = Math.max(highest, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      commands.push(command.join(' '));
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(highest).toBe(VERIFY_CONCURRENCY);
  for (let index = 0; index < 8; index++) expect(commands).toContain(`acceptance task-${index}`);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(head);
});
