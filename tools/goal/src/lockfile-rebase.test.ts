import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptFence, GateOutcome } from './contracts.ts';
import { openDb } from './db.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { repository } from './test-support.ts';

const install = (cwd: string, ...flags: string[]) => spawnSync('bun', ['install', ...flags], { cwd, encoding: 'utf8' });

function workspace(cwd: string, name: string): void {
  mkdirSync(join(cwd, 'packages', name), { recursive: true });
  writeFileSync(join(cwd, 'packages', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', private: true }));
  expect(install(cwd).status).toBe(0);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', `Add workspace ${name}`);
}

test('a rebase whose only conflict is the lockfile regenerates it and lands both tasks', async () => {
  const repo = repository();
  const db = openDb(join(repo.path, 'state.sqlite'));
  try {
    writeFileSync(join(repo.main, '.gitignore'), 'node_modules/\n');
    writeFileSync(
      join(repo.main, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    );
    expect(install(repo.main).status).toBe(0);
    git(repo.main, 'add', '.');
    git(repo.main, 'commit', '-m', 'Add the workspace root');
    const requests = ['alpha', 'beta'].map((name) => {
      const worktree = join(repo.path, name);
      git(repo.main, 'worktree', 'add', '-b', name, worktree, 'main');
      workspace(worktree, name);
      return {
        taskId: name,
        attempt: 1,
        branch: name,
        worktree,
        declaredPaths: ['packages/**', 'bun.lock'],
        gate: ['bun', 'install', '--frozen-lockfile'],
      };
    });
    const fence: AttemptFence = {
      assertCurrent() {},
      commitMerge(ref, merge) {
        return db.transaction(() => merge()).immediate();
      },
    };
    const queue = new SqliteLandingQueue(db, fence);
    for (const request of requests) queue.enqueue(request);
    const outcomes: GateOutcome[] = [];
    await new MergeTrain({
      mainCheckout: repo.main,
      stateDirectory: join(repo.path, 'state'),
      worktreeRoot: join(repo.path, 'trees'),
      queue,
      fence,
      sink: {
        onGateOutcome(outcome) {
          outcomes.push(outcome);
        },
      },
      runGate: async (argv, cwd) => {
        const result = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
        return { passed: result.status === 0, output: `${result.stdout}${result.stderr}`, timedOut: false };
      },
    }).run();
    expect(outcomes.map((outcome) => [outcome.taskId, outcome.passed, outcome.stage])).toEqual([
      ['alpha', true, 'merge'],
      ['beta', true, 'merge'],
    ]);
    const lock = readFileSync(join(repo.main, 'bun.lock'), 'utf8');
    expect(lock).toContain('"packages/alpha"');
    expect(lock).toContain('"packages/beta"');
    expect(install(repo.main, '--frozen-lockfile').status).toBe(0);
  } finally {
    db.close();
    repo.close();
  }
});
