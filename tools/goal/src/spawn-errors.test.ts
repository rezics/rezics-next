import { expect, test } from 'bun:test';
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

test('the release snapshot preserves Git spawn failures and refuses a missing main ref', () => {
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
      integrationBranch: 'dev',
      stabilizeBranch: 'stabilize',
    });
    const trainWithReleaseSnapshot = train as unknown as {
      controlPlaneSnapshot(mainBranch: string): unknown;
    };

    expect(() => trainWithReleaseSnapshot.controlPlaneSnapshot('main')).toThrow(/ENOENT/);

    const repo = repository();
    try {
      const configured = new MergeTrain({
        mainCheckout: repo.main,
        stateDirectory: join(repo.path, 'state'),
        worktreeRoot: join(repo.path, 'worktrees'),
        queue: {} as never,
        fence: {} as never,
        sink: {} as never,
        integrationBranch: 'dev',
      }) as unknown as { controlPlaneSnapshot(mainBranch: string): unknown };
      expect(() => configured.controlPlaneSnapshot('missing-main')).toThrow(
        'Control-plane release requires missing-main',
      );
    } finally {
      repo.close();
    }
  } finally {
    temp.close();
  }
});

test('prepared release merges preserve the exact merge-process spawn error', () => {
  const repo = repository();
  try {
    const source = repo.branch('source', 'source.txt');
    const target = repo.branch('target', 'target.txt');
    const sourceCommit = mergeGit(source.worktree, 'rev-parse', 'HEAD');
    const train = new MergeTrain({
      mainCheckout: repo.main,
      stateDirectory: join(repo.path, 'state'),
      worktreeRoot: join(repo.path, 'worktrees'),
      queue: {} as never,
      fence: {} as never,
      sink: {} as never,
      integrationBranch: 'dev',
      runCandidateGit: (_cwd, args) =>
        args[0] === 'merge'
          ? {
              status: null,
              signal: null,
              stdout: '',
              stderr: '',
              error: new Error('spawn ENOENT: git merge'),
            }
          : undefined,
    });
    const trainWithReleaseMerge = train as unknown as {
      mergeControlPlaneCandidate(
        sourceCommit: string,
        sourceBranch: string,
        targetBranch: string,
        targetHead: string,
        logPath: string,
      ): { commit?: string; conflicts?: string[]; cause?: string };
    };

    const result = trainWithReleaseMerge.mergeControlPlaneCandidate(
      sourceCommit,
      'source',
      'target',
      mergeGit(target.worktree, 'rev-parse', 'HEAD'),
      join(repo.path, 'merge.log'),
    );

    expect(result.commit).toBeUndefined();
    expect(result.cause).toContain('spawn ENOENT: git merge');
  } finally {
    repo.close();
  }
});
