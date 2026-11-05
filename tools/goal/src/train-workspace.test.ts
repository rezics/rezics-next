import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { repository } from './test-support.ts';
import { openTrainWorkspace, type TrainWorkspaceGit } from './train-workspace.ts';

function checkout() {
  const repo = repository();
  const worktreeRoot = join(repo.path, 'trees');
  const revision = git(repo.main, 'rev-parse', 'HEAD');
  const recorded: string[][] = [];
  const gitCalls: TrainWorkspaceGit = (cwd, ...args) => {
    recorded.push(args);
    return git(cwd, ...args);
  };
  return { repo, worktreeRoot, revision, recorded, gitCalls };
}

test('successful candidate removal unregisters the detached tree', () => {
  const h = checkout();
  try {
    const tree = join(h.worktreeRoot, 'train-candidate');
    const workspace = openTrainWorkspace({
      checkout: h.repo.main,
      worktreeRoot: h.worktreeRoot,
      tree,
      revision: h.revision,
      git: h.gitCalls,
      profile: { abort: ['rebase', 'merge'], capture: 'create', cleanup: { onError: 'throw' } },
    });
    expect(existsSync(tree)).toBe(true);
    expect(git(h.repo.main, 'worktree', 'list', '--porcelain')).toContain(tree);
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(h.revision);
    workspace.release();
    expect(existsSync(tree)).toBe(false);
    expect(git(h.repo.main, 'worktree', 'list', '--porcelain')).not.toContain(tree);
  } finally {
    h.repo.close();
  }
});

test('creation failure leaves an unrelated directory in place', () => {
  const h = checkout();
  try {
    const unrelated = join(h.worktreeRoot, 'keep-me');
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, 'sentinel'), 'keep');
    expect(() =>
      openTrainWorkspace({
        checkout: h.repo.main,
        worktreeRoot: h.worktreeRoot,
        tree: join(h.worktreeRoot, 'train-missing'),
        revision: 'not-a-commit',
        git: h.gitCalls,
        profile: { cleanup: { onError: 'throw' } },
      }),
    ).toThrow();
    expect(existsSync(unrelated)).toBe(true);
    expect(readFileSync(join(unrelated, 'sentinel'), 'utf8')).toBe('keep');
    expect(existsSync(join(h.worktreeRoot, 'train-missing'))).toBe(false);
    expect(git(h.repo.main, 'worktree', 'list', '--porcelain')).not.toContain('train-missing');
  } finally {
    h.repo.close();
  }
});

test('a generator exception keeps its original result when cleanup also fails', () => {
  const h = checkout();
  try {
    const tree = join(h.worktreeRoot, 'train-generator');
    const reports: unknown[] = [];
    const workspace = openTrainWorkspace({
      checkout: h.repo.main,
      worktreeRoot: h.worktreeRoot,
      tree,
      revision: h.revision,
      git: (cwd, ...args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('cleanup blocked');
        return h.gitCalls(cwd, ...args);
      },
      profile: {
        abort: ['rebase', 'merge'],
        capture: 'create',
        cleanup: { onError: 'report', report: (error) => reports.push(error) },
      },
    });
    const original = new Error('generator failed');
    try {
      throw original;
    } catch (error) {
      workspace.release();
      expect(error).toBe(original);
    }
    expect(String(reports[0])).toContain('cleanup blocked');
    expect(existsSync(tree)).toBe(true);
    expect(git(h.repo.main, 'rev-parse', 'HEAD')).toBe(h.revision);
  } finally {
    h.repo.close();
  }
});

test('batch and resolver profiles abort only their operations and then remove the tree', () => {
  const h = checkout();
  try {
    const batchTree = join(h.worktreeRoot, 'train-batch');
    const batch = openTrainWorkspace({
      checkout: h.repo.main,
      worktreeRoot: h.worktreeRoot,
      tree: batchTree,
      revision: h.revision,
      git: h.gitCalls,
      profile: { abort: ['rebase', 'merge'], capture: 'create', cleanup: { onError: 'throw' } },
    });
    h.recorded.length = 0;
    batch.release();
    expect(h.recorded).toEqual([
      ['rebase', '--abort'],
      ['merge', '--abort'],
      ['worktree', 'remove', '--force', batchTree],
    ]);
    expect(existsSync(batchTree)).toBe(false);

    const resolverTree = join(h.worktreeRoot, 'train-resolver-dev');
    const resolver = openTrainWorkspace({
      checkout: h.repo.main,
      worktreeRoot: h.worktreeRoot,
      tree: resolverTree,
      revision: h.revision,
      git: h.gitCalls,
      profile: { abort: ['merge'], capture: 'release', cleanup: { onError: 'throw' } },
    });
    h.recorded.length = 0;
    resolver.release();
    expect(h.recorded[0]).toEqual(['merge', '--abort']);
    expect(h.recorded.some((args) => args[0] === 'rebase')).toBe(false);
    expect(h.recorded.at(-1)).toEqual(['worktree', 'remove', '--force', resolverTree]);
    expect(existsSync(resolverTree)).toBe(false);
  } finally {
    h.repo.close();
  }
});

test('a retained cleanup failure reports the exact error and leaves the tree', () => {
  const h = checkout();
  try {
    const tree = join(h.worktreeRoot, 'train-retained');
    const reports: string[] = [];
    const workspace = openTrainWorkspace({
      checkout: h.repo.main,
      worktreeRoot: h.worktreeRoot,
      tree,
      revision: h.revision,
      git: (cwd, ...args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') throw new Error(`locked ${tree}`);
        return h.gitCalls(cwd, ...args);
      },
      profile: {
        capture: 'create',
        cleanup: {
          onError: 'report',
          report: (error) => reports.push(`Train tree cleanup deferred: ${tree}: ${error}`),
        },
      },
    });
    workspace.release();
    expect(reports).toEqual([`Train tree cleanup deferred: ${tree}: Error: locked ${tree}`]);
    expect(existsSync(tree)).toBe(true);
  } finally {
    h.repo.close();
  }
});

test('prepared-merge cleanup deletes the tree when git remove fails', () => {
  const h = checkout();
  try {
    const tree = join(h.worktreeRoot, 'control-plane-merge');
    const workspace = openTrainWorkspace({
      checkout: h.repo.main,
      worktreeRoot: h.worktreeRoot,
      tree,
      revision: h.revision,
      git: (cwd, ...args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('git remove failed');
        return h.gitCalls(cwd, ...args);
      },
      profile: { cleanup: { onError: 'rm' } },
    });
    workspace.release();
    expect(existsSync(tree)).toBe(false);
  } finally {
    h.repo.close();
  }
});

test('awaited sibling work finishes before the owning caller releases the workspace', async () => {
  const h = checkout();
  try {
    const tree = join(h.worktreeRoot, 'train-siblings');
    const sibling = Promise.withResolvers<void>();
    let removed = false;
    const workspace = openTrainWorkspace({
      checkout: h.repo.main,
      worktreeRoot: h.worktreeRoot,
      tree,
      revision: h.revision,
      git: (cwd, ...args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') removed = true;
        return h.gitCalls(cwd, ...args);
      },
      profile: { cleanup: { onError: 'throw' } },
    });
    const reason = new Error('check rejected');
    let settled = false;
    const work = Promise.allSettled([Promise.reject(reason), sibling.promise]).then((results) => {
      expect(results[0]).toMatchObject({ status: 'rejected', reason });
      expect(settled).toBe(true);
      expect(removed).toBe(false);
      expect(existsSync(tree)).toBe(true);
      workspace.release();
    });
    await Bun.sleep(10);
    expect(removed).toBe(false);
    settled = true;
    sibling.resolve();
    await work;
    expect(removed).toBe(true);
    expect(existsSync(tree)).toBe(false);
  } finally {
    h.repo.close();
  }
});
