import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { git as mergeGit } from './merge.ts';
import { changedPathsBetween, MergeTrain } from './merge-train.ts';
import { git as taskGit } from './tasks.ts';
import { repository, temporaryDirectory } from './test-support.ts';

test('task git reports a spawn error when git cannot start', () => {
  const temp = temporaryDirectory();
  try {
    expect(() => taskGit(join(temp.path, 'missing'), ['status'])).toThrow(/ENOENT/);
  } finally {
    temp.close();
  }
});

test('merge git reports a spawn error when git cannot start', () => {
  const temp = temporaryDirectory();
  try {
    expect(() => mergeGit(join(temp.path, 'missing'), 'status')).toThrow(/ENOENT/);
  } finally {
    temp.close();
  }
});

test('merge train change inspection reports a spawn error when git cannot start', () => {
  const temp = temporaryDirectory();
  try {
    expect(() => changedPathsBetween(join(temp.path, 'missing'), 'base', 'head')).toThrow(/ENOENT/);
  } finally {
    temp.close();
  }
});

test('merge train branch lookup reports a spawn error when git cannot start', () => {
  const temp = temporaryDirectory();
  try {
    const checkout = join(temp.path, 'missing');
    const train = new MergeTrain({
      mainCheckout: checkout,
      stateDirectory: temp.path,
      worktreeRoot: join(temp.path, 'worktrees'),
      queue: {} as never,
      fence: {} as never,
      sink: {} as never,
    });
    const trainWithBranchMerge = train as unknown as {
      mergeCommitIntoBranch(
        sourceCommit: string,
        sourceBranch: string,
        targetBranch: string,
        logPath: string,
      ): { error?: string };
    };

    expect(
      trainWithBranchMerge.mergeCommitIntoBranch('commit', 'source', 'target', join(temp.path, 'merge.log')).error,
    ).toContain('ENOENT');
  } finally {
    temp.close();
  }
});

test('merge train reports the spawn error when its merge process cannot start', () => {
  const repo = repository();
  try {
    const source = repo.branch('source', 'source.txt');
    repo.branch('target', 'target.txt');
    const sourceCommit = mergeGit(source.worktree, 'rev-parse', 'HEAD');
    const train = new MergeTrain({
      mainCheckout: repo.main,
      stateDirectory: join(repo.path, 'state'),
      worktreeRoot: join(repo.path, 'worktrees'),
      queue: {} as never,
      fence: {} as never,
      sink: {} as never,
    });
    const trainWithBranchMerge = train as unknown as {
      mergeCommitIntoBranch(
        sourceCommit: string,
        sourceBranch: string,
        targetBranch: string,
        logPath: string,
        runSync: (
          command: string,
          args: string[],
          options: { cwd: string; encoding: 'utf8' },
        ) => { status: number | null; stdout: string | null; stderr: string | null; error?: Error },
      ): { error?: string };
    };
    const runSync = (command: string, args: string[], options: { cwd: string; encoding: 'utf8' }) => {
      if (args[0] === 'merge')
        return { status: null, stdout: null, stderr: null, error: new Error('spawn ENOENT: git merge') };
      const result = spawnSync(command, args, { cwd: options.cwd, encoding: options.encoding });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.error ? { error: result.error } : {}),
      };
    };

    const result = trainWithBranchMerge.mergeCommitIntoBranch(
      sourceCommit,
      'source',
      'target',
      join(repo.path, 'merge.log'),
      runSync,
    );

    expect(result.error).toContain('spawn ENOENT: git merge');
  } finally {
    repo.close();
  }
});
