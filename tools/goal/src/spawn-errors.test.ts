import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { git as mergeGit } from './merge.ts';
import { changedPathsBetween, MergeTrain } from './merge-train.ts';
import { git as taskGit } from './tasks.ts';
import { temporaryDirectory } from './test-support.ts';

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

    expect(trainWithBranchMerge.mergeCommitIntoBranch('commit', 'source', 'target', join(temp.path, 'merge.log')).error)
      .toContain('ENOENT');
  } finally {
    temp.close();
  }
});
