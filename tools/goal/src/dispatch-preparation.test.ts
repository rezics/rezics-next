import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareInitialDispatch } from './dispatch-preparation.ts';

test('failed initial preparation keeps the cause and cleans its own worktree, branch, and brief', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-dispatch-preparation-'));
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
  const root = mkdtempSync(join(tmpdir(), 'goal-dispatch-preparation-'));
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
  const root = mkdtempSync(join(tmpdir(), 'goal-dispatch-preparation-'));
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
