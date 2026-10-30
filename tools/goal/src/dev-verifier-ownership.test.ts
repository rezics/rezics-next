import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyDev } from './dev-verifier.ts';
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

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'goal-dev-verifier-owner-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(join(root, 'services', 'kernel'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'services', 'kernel', 'base.ts'), 'export const base = true;\n');
  writeFileSync(join(root, 'scripts', 'typecheck.ts'), 'process.exit(0);\n');
  writeFileSync(join(root, 'scripts', 'acceptance.ts'), 'process.exit(0);\n');
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

function setup(root: string, tasks: Task[]) {
  const stateDirectory = join(root, '.state');
  const worktreeRoot = join(root, '.trees');
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
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

function landedTask(from: string, commitHead: string, id: string): Task {
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
      acceptance: { command: ['bun', 'scripts/acceptance.ts'], tests: [], failing: true },
    } as any,
  } as Task;
}

test('Post integration affected verifier catches wrong owner resolution and returns a fix to exact owner', async () => {
  const root = repo();
  const behavior = 'services/kernel/behavior.ts';
  writeFileSync(join(root, behavior), "export const mode = 'base';\n");
  git(root, 'add', behavior);
  git(root, 'commit', '-m', 'add behavior base');
  const verifiedBase = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', '-f', 'dev-verified', verifiedBase);
  git(root, 'branch', '-f', 'dev', verifiedBase);

  mkdirSync(join(root, '.state'), { recursive: true });
  const ownerTree = join(root, '.state', 'owner-worktree');
  git(root, 'worktree', 'add', '-b', 'worker-owner', ownerTree, verifiedBase);
  const ownerCommit = commit(ownerTree, behavior, "export const mode = 'right';\n", 'owner source');
  git(root, 'update-ref', 'refs/heads/dev', ownerCommit, verifiedBase);

  const resolutionTree = join(root, '.state', 'resolution-worktree');
  git(root, 'worktree', 'add', '-b', 'worker-resolution', resolutionTree, verifiedBase);
  commit(resolutionTree, behavior, "export const mode = 'wrong';\n", 'conflicting worker source');
  const conflict = spawnSync('git', ['rebase', 'dev'], { cwd: resolutionTree, encoding: 'utf8' });
  expect(conflict.status).not.toBe(0);
  git(resolutionTree, 'checkout', '--theirs', '--', behavior);
  git(resolutionTree, 'add', '--', behavior);
  const continued = spawnSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], {
    cwd: resolutionTree,
    encoding: 'utf8',
  });
  expect(continued.status).toBe(0);
  const resolutionCommit = git(resolutionTree, 'rev-parse', 'HEAD');
  expect(git(root, 'rev-parse', `${resolutionCommit}^`)).toBe(ownerCommit);
  git(root, 'update-ref', 'refs/heads/dev', resolutionCommit, ownerCommit);

  const docsTree = join(root, '.state', 'docs-worktree');
  git(root, 'worktree', 'add', '--detach', docsTree, resolutionCommit);
  const docsCommit = commit(docsTree, 'docs/unrelated.md', 'unrelated documentation\n', 'unrelated task');
  git(root, 'update-ref', 'refs/heads/dev', docsCommit, resolutionCommit);

  const checkScript = join(root, '.state', 'affected-check.ts');
  writeFileSync(
    checkScript,
    `import { readFileSync } from 'node:fs';\n` +
      `const content = readFileSync('${behavior}', 'utf8');\n` +
      `if (!content.includes("mode = 'right'")) {\n` +
      `  console.error('AssertionError: integrated behavior must remain right');\n` +
      `  process.exitCode = 1;\n` +
      `}\n`,
  );
  const tasks = [
    {
      ...landedTask(verifiedBase, ownerCommit, 'owner-source'),
      branch: 'worker-owner',
      worktree: ownerTree,
      brief: { ...landedTask(verifiedBase, ownerCommit, 'owner-source').brief, manager: 'source-manager' },
    },
    {
      ...landedTask(verifiedBase, resolutionCommit, 'wrong-resolution'),
      branch: 'worker-resolution',
      worktree: resolutionTree,
      brief: { ...landedTask(verifiedBase, resolutionCommit, 'wrong-resolution').brief, manager: 'resolution-manager' },
    },
    {
      ...landedTask(verifiedBase, docsCommit, 'unrelated-docs'),
      branch: 'main',
      worktree: root,
      brief: {
        ...landedTask(verifiedBase, docsCommit, 'unrelated-docs').brief,
        manager: 'docs-manager',
        paths: ['docs/**'],
      },
    },
  ];
  const ctx = setup(root, tasks);
  ctx.settings.affectedTests = [{ paths: ['services/kernel/**'], command: ['bun', checkScript] }];
  await verifyDev(ctx);

  const revertedHead = git(root, 'rev-parse', 'dev');
  expect(revertedHead).toBe(git(root, 'rev-parse', 'dev-verified'));
  expect(git(root, 'show', `dev:${behavior}`)).toContain("mode = 'right'");
  expect(git(root, 'show', 'dev:docs/unrelated.md')).toContain('unrelated documentation');
  expect(ctx.updates).toEqual(['wrong-resolution']);
  expect(ctx.inboxEvents).toHaveLength(1);
  expect(ctx.inboxEvents[0].managerId).toBe('resolution-manager');
  expect(ctx.inboxEvents[0].taskId).toBe('wrong-resolution');
  expect(ctx.inboxEvents[0].evidencePath).toBeTruthy();
  expect(readFileSync(ctx.inboxEvents[0].evidencePath, 'utf8')).toContain(
    'AssertionError: integrated behavior must remain right',
  );
  expect(ctx.inboxEvents[0].summary).toContain('AssertionError: integrated behavior must remain right');
  expect(git(resolutionTree, 'rev-parse', 'HEAD')).toBe(resolutionCommit);
  expect(readFileSync(join(resolutionTree, behavior), 'utf8')).toContain("mode = 'wrong'");

  git(resolutionTree, 'reset', '--hard', revertedHead);
  writeFileSync(join(resolutionTree, behavior), "export const mode = 'right';\nexport const ownerFix = true;\n");
  git(resolutionTree, 'add', '--', behavior);
  git(resolutionTree, 'commit', '-m', 'owner fixes integrated resolution');
  const fixedCommit = git(resolutionTree, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/heads/dev', fixedCommit, revertedHead);
  const resolutionTask = tasks.find((task) => task.id === 'wrong-resolution')!;
  Object.assign(resolutionTask, {
    state: 'integrated',
    integratedBase: revertedHead,
    integratedCommit: fixedCommit,
    integratedCommits: [fixedCommit],
  });
  await verifyDev(ctx);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(fixedCommit);
  expect(ctx.inboxEvents).toHaveLength(1);
  expect(readFileSync(join(resolutionTree, behavior), 'utf8')).toContain('ownerFix = true');
});

test('a check-host transport failure during owner bisection is not assigned as an assertion', async () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'dev-verified');
  const good = commit(root, 'services/kernel/good.ts', 'export const good = true;\n', 'good landing');
  const bad = commit(root, 'services/kernel/bad.ts', 'export const bad = false;\n', 'bad landing');
  git(root, 'branch', '-f', 'dev', bad);
  const ctx = setup(root, [landedTask(base, good, 'good'), landedTask(base, bad, 'bad')]);
  let affectedCalls = 0;
  await verifyDev({
    ...ctx,
    runGate: async (command, cwd) => {
      if (command.includes('affected-check')) {
        affectedCalls++;
        if (git(cwd, 'rev-parse', 'HEAD') === bad)
          return { passed: false, output: 'AssertionError: affected behavior failed', timedOut: false };
        return { passed: false, output: 'RemoteTransportError: check host connection reset', timedOut: false };
      }
      return { passed: true, output: '', timedOut: false };
    },
  });
  expect(affectedCalls).toBe(4);
  expect(git(root, 'rev-parse', 'dev')).toBe(bad);
  expect(git(root, 'rev-parse', 'dev-verified')).toBe(base);
  expect(ctx.updates).toEqual([]);
  expect(ctx.inboxEvents).toEqual([]);
});
