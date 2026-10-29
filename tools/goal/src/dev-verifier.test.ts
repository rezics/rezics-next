import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { devVerificationState, verifyDev } from './dev-verifier.ts';
import type { Settings, Task } from './types.ts';

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
  mkdirSync(stateDirectory);
  mkdirSync(worktreeRoot);
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
