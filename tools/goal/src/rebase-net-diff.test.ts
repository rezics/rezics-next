import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rebaseOnto } from './merge-train.ts';
import { git } from './merge.ts';
import { repository } from './test-support.ts';

test('a branch whose later commit reverts an earlier conflicting change rebases through its net diff', () => {
  const repo = repository();
  const worker = join(repo.path, 'worker');
  try {
    const originalBase = git(repo.main, 'rev-parse', 'HEAD');
    git(repo.main, 'worktree', 'add', '-b', 'worker', worker, originalBase);

    writeFileSync(join(worker, 'conflict.txt'), 'worker version\n');
    git(worker, 'add', 'conflict.txt');
    git(worker, 'commit', '-m', 'Introduce conflicting worker change');
    rmSync(join(worker, 'conflict.txt'));
    writeFileSync(join(worker, 'worker.txt'), 'independent net change\n');
    git(worker, 'add', '-A');
    git(worker, 'commit', '-m', 'Revert conflict and add independent change');

    writeFileSync(join(repo.main, 'conflict.txt'), 'dev version\n');
    git(repo.main, 'add', 'conflict.txt');
    git(repo.main, 'commit', '-m', 'Change conflict on dev');
    const base = git(repo.main, 'rev-parse', 'HEAD');

    rebaseOnto(worker, base, originalBase, join(repo.path, 'rebase.log'));

    expect(git(worker, 'rev-list', '--count', `${base}..HEAD`)).toBe('1');
    expect(git(worker, 'diff', '--name-only', base, 'HEAD')).toBe('worker.txt');
    expect(existsSync(join(worker, 'conflict.txt'))).toBe(true);
    expect(existsSync(join(worker, 'worker.txt'))).toBe(true);
    const message = git(worker, 'show', '-s', '--format=%B', 'HEAD');
    expect(message).toContain('Introduce conflicting worker change');
    expect(message).toContain('Revert conflict and add independent change');
    expect(git(worker, 'status', '--porcelain')).toBe('');
  } finally {
    repo.close();
  }
});

test('a branch whose net diff still conflicts leaves the conflict for its caller', () => {
  const repo = repository();
  const worker = join(repo.path, 'worker');
  try {
    const originalBase = git(repo.main, 'rev-parse', 'HEAD');
    git(repo.main, 'worktree', 'add', '-b', 'worker', worker, originalBase);
    writeFileSync(join(worker, 'base'), 'worker version\n');
    git(worker, 'add', 'base');
    git(worker, 'commit', '-m', 'Change shared file on worker');

    writeFileSync(join(repo.main, 'base'), 'dev version\n');
    git(repo.main, 'add', 'base');
    git(repo.main, 'commit', '-m', 'Change shared file on dev');
    const base = git(repo.main, 'rev-parse', 'HEAD');

    expect(() => rebaseOnto(worker, base, originalBase, join(repo.path, 'rebase.log'))).toThrow();
    expect(git(worker, 'diff', '--name-only', '--diff-filter=U')).toBe('base');
    expect(git(worker, 'status', '--porcelain')).toContain('UU base');
  } finally {
    repo.close();
  }
});
