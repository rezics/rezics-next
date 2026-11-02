import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareInitialDispatch } from './dispatch-preparation.ts';

const temporary = join(import.meta.dir, '../../../.temp');
mkdirSync(temporary, { recursive: true });

test('failed initial preparation keeps the cause and cleans its own worktree, branch, and brief', () => {
  const root = mkdtempSync(join(temporary, 'goal-dispatch-preparation-'));
  const worktree = join(root, 'worktree');
  const briefPath = join(root, 'state', 'briefs', 'task.md');
  const calls: string[] = [];
  try {
    mkdirSync(join(root, 'state', 'briefs'), { recursive: true });
    expect(() =>
      prepareInitialDispatch({
        briefPath,
        briefText: 'acceptance bytes',
        branch: 'goal/task',
        worktree,
        createWorktree: () => calls.push('add'),
        installDependencies: () => {
          calls.push('install');
          throw new Error('bun install failed: lockfile unavailable');
        },
        freezeFiles: () => calls.push('freeze'),
        removeWorktree: () => calls.push('remove'),
        deleteBranch: () => calls.push('delete-branch'),
      }),
    ).toThrow(/Initial dispatch preparation failed: bun install failed: lockfile unavailable/);
    expect(calls).toEqual(['add', 'install', 'remove', 'delete-branch']);
    expect(existsSync(briefPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing worktree is named and left untouched', () => {
  const root = mkdtempSync(join(temporary, 'goal-dispatch-preparation-'));
  const worktree = join(root, 'shared-worktree');
  const briefPath = join(root, 'state', 'briefs', 'task.md');
  const sentinel = join(worktree, 'keep.txt');
  try {
    mkdirSync(worktree, { recursive: true });
    writeFileSync(sentinel, 'shared');
    expect(() =>
      prepareInitialDispatch({
        briefPath,
        briefText: 'acceptance bytes',
        branch: 'goal/task',
        worktree,
        createWorktree: () => {
          throw new Error('must not run');
        },
        freezeFiles: () => undefined,
        removeWorktree: () => {
          throw new Error('must not run');
        },
        deleteBranch: () => {
          throw new Error('must not run');
        },
      }),
    ).toThrow(`Initial dispatch preparation failed: task worktree path already exists: ${worktree}`);
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(briefPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retained preparation artifacts are named when Git cleanup fails', () => {
  const root = mkdtempSync(join(temporary, 'goal-dispatch-preparation-'));
  const worktree = join(root, 'worktree');
  const briefPath = join(root, 'state', 'briefs', 'task.md');
  const calls: string[] = [];
  let failure: unknown;
  try {
    mkdirSync(join(root, 'state', 'briefs'), { recursive: true });
    try {
      prepareInitialDispatch({
        briefPath,
        briefText: 'acceptance bytes',
        branch: 'goal/task',
        worktree,
        createWorktree: () => calls.push('add'),
        installDependencies: () => {
          calls.push('install');
          throw new Error('dependency install failed');
        },
        freezeFiles: () => undefined,
        removeWorktree: () => {
          calls.push('remove');
          throw new Error('worktree is busy');
        },
        deleteBranch: () => calls.push('delete-branch'),
      });
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('Initial dispatch preparation failed: dependency install failed');
    expect(message).toContain(`worktree ${worktree} and branch goal/task`);
    expect(message).toContain(`dispatch brief ${briefPath}`);
    expect((failure as Error & { cause?: Error }).cause?.message).toBe('dependency install failed');
    expect(calls).toEqual(['add', 'install', 'remove']);
    expect(existsSync(briefPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['success', 'freeze', 'existing branch'])('real Git preparation: %s', (stage) => {
  const root = mkdtempSync(join(temporary, 'goal-dispatch-git-'));
  const source = join(root, 'source');
  const worktree = join(root, 'worker');
  const briefPath = join(root, 'brief.md');
  const bytes = 'frozen acceptance\r\n';
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    mkdirSync(source);
    git('init');
    git('-c', 'user.name=Goal test', '-c', 'user.email=goal@example.test', 'commit', '--allow-empty', '-m', 'source');
    const head = git('rev-parse', 'HEAD');
    if (stage === 'existing branch') git('branch', 'worker');
    const prepare = () =>
      prepareInitialDispatch({
        briefPath,
        briefText: bytes,
        branch: 'worker',
        worktree,
        createWorktree: () => git('worktree', 'add', '-b', 'worker', worktree, head),
        freezeFiles: () => {
          writeFileSync(join(worktree, 'acceptance.test.ts'), bytes);
          if (stage === 'freeze') throw new Error('freeze failed');
          return 'frozen';
        },
        removeWorktree: () => git('worktree', 'remove', '--force', worktree),
        deleteBranch: () => git('branch', '-D', 'worker'),
      });
    if (stage === 'success') {
      expect(prepare()).toBe('frozen');
      expect(readFileSync(join(worktree, 'acceptance.test.ts'), 'utf8')).toBe(bytes);
      expect(readFileSync(briefPath, 'utf8')).toBe(bytes);
      git('worktree', 'remove', '--force', worktree);
    } else {
      expect(prepare).toThrow(
        stage === 'freeze' ? 'Initial dispatch preparation failed: freeze failed' : /Recovery:.*worker/,
      );
      expect(existsSync(worktree)).toBe(false);
      expect(existsSync(briefPath)).toBe(stage === 'existing branch');
      expect(git('branch', '--list', 'worker')).toBe(stage === 'existing branch' ? 'worker' : '');
    }
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe('');
    expect(git('worktree', 'list', '--porcelain')).not.toContain(worktree);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
