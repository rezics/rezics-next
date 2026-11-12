import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from './config.ts';
import type { Settings } from './types.ts';
import { maintenanceCommand, runMaintenance, runResidentVerifier } from './maintenance.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { git } from './merge.ts';
import { readControlPolicy } from './policy.ts';
import { stageCheckGit, releaseCheckGit, CHECK_GIT_RELEASE_RETRY_MS } from '../../../scripts/check-git.ts';
import { regenerateDerivedHead } from './promotion.ts';
import { harness, temporaryDirectory } from './test-support.ts';

test('a sweep expires on policy budget, reports skipped steps and releases its lease', async () => {
  const dir = temporaryDirectory();
  const db = openDb(join(dir.path, 'goal.sqlite'));
  const store = new WorkerStore(db);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  const settings = {
    stateDirectory: dir.path,
    mainCheckout: dir.path,
    worktreeRoot: join(dir.path, 'worktrees'),
    policy: readControlPolicy({ maintenance: { budgetMs: 30 } }),
  } as Settings;
  const runtime = {
    stateDirectory: dir.path,
    settings,
    store,
    evaluateFlow: () => new Promise(() => {}),
  } as unknown as Runtime;
  try {
    const start = performance.now();
    expect(await runMaintenance('all', runtime)).toBe(1);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(errors.join('\n')).toContain('budget exhausted (30ms)');
    expect(errors.join('\n')).toContain('maintenance detect:');
    let detected = false;
    runtime.deliverReminders = async () => {
      detected = true;
      return 0;
    };
    expect(await runMaintenance('detect', runtime)).toBe(0);
    expect(detected).toBe(true);
  } finally {
    console.error = original;
    db.close();
    dir.close();
  }
});

test('a maintenance subprocess that blocks its event loop is killed at its deadline', async () => {
  const dir = temporaryDirectory();
  try {
    const start = performance.now();
    await expect(
      maintenanceCommand([process.execPath, '-e', 'while (true) {}'], dir.path, AbortSignal.timeout(50)),
    ).rejects.toThrow();
    expect(performance.now() - start).toBeLessThan(1000);
  } finally {
    dir.close();
  }
});

test('process cleanup stays queued until the recorded worktree is physically gone', async () => {
  const dir = temporaryDirectory();
  const db = openDb(join(dir.path, 'goal.sqlite'));
  const store = new WorkerStore(db);
  const worktreeRoot = join(dir.path, 'worktrees');
  const worktree = join(worktreeRoot, 'running-task');
  mkdirSync(worktree, { recursive: true });
  const settings = { stateDirectory: dir.path, mainCheckout: dir.path, worktreeRoot } as Settings;
  const runtime = { stateDirectory: dir.path, mainCheckout: dir.path, settings, store } as Runtime;
  try {
    db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, 1, 1, ?)').run(
      'running-task',
      JSON.stringify({
        id: 'running-task',
        state: 'running',
        currentAttempt: 1,
        worktree,
        brief: { after: [] },
      }),
    );
    db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, 1, ?)').run(
      'running-task',
      JSON.stringify({
        taskId: 'running-task',
        attempt: 1,
        state: 'running',
        process: { pid: 2_147_483_647, start: 'dead', boot: 'dead', group: 2_147_483_647 },
      }),
    );

    expect(await runMaintenance('reap', runtime)).toBe(0);
    expect(db.query("SELECT 1 FROM worker_maintenance_candidates WHERE kind='reap'").get()).not.toBeNull();

    rmSync(worktree, { recursive: true, force: true });
    expect(await runMaintenance('reap', runtime)).toBe(0);
    expect(db.query("SELECT 1 FROM worker_maintenance_candidates WHERE kind='reap'").get()).toBeNull();
  } finally {
    db.close();
    dir.close();
  }
});

test('derived worktree cleanup removes generator leftovers and preserves a generator failure', async () => {
  const dir = temporaryDirectory();
  try {
    git(dir.path, 'init', '-q', '-b', 'dev');
    git(dir.path, 'config', 'user.name', 'Test');
    git(dir.path, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(dir.path, 'generated.txt'), 'base');
    git(dir.path, 'add', '.');
    git(dir.path, 'commit', '-qm', 'Initial');
    const settings = {
      mainCheckout: dir.path,
      integrationBranch: 'dev',
      stateDirectory: join(dir.path, '.temp'),
      worktreeRoot: join(dir.path, '.temp/worktrees'),
    } as Settings;
    mkdirSync(settings.stateDirectory);
    const derivedFiles = [
      {
        path: 'generated.txt',
        stage: 'promotion' as const,
        command: [
          process.execPath,
          '-e',
          "const fs = require('node:fs'); fs.mkdirSync('leftovers/nested/.git', {recursive:true}); fs.writeFileSync('leftovers/nested/.git/HEAD', 'fixture'); throw new Error('generator failed');",
        ],
      },
    ];
    await expect(regenerateDerivedHead({ settings, derivedFiles }, git(dir.path, 'rev-parse', 'HEAD'))).rejects.toThrow(
      'generator failed',
    );
    expect(git(dir.path, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(readdirSync(settings.worktreeRoot)).toEqual([]);
  } finally {
    dir.close();
  }
});

test.each(['integrated', 'cancelled'] as const)(
  'existing maintenance reap revisits a completed %s owner without another check and preserves unresolved custody/native success',
  async (state) => {
    const h = harness();
    try {
      const task = h.tasks.dispatch(h.briefFile);
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (row) => {
        row.state = state;
      });
      const origin = join(h.settings.stateDirectory, 'origin.git');
      git(h.root, 'init', '--bare', '-q', origin);
      git(task.worktree, 'remote', 'add', 'origin', origin);
      git(task.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/dev');
      const staging = join(h.settings.stateDirectory, 'git-fixture');
      mkdirSync(staging, { recursive: true });
      const manifest = await stageCheckGit(task.worktree, join(staging, 'due'), { ref: 'refs/checks/due-owner' });
      await stageCheckGit(task.worktree, join(staging, 'frozen'), { ref: 'refs/checks/frozen-owner', retain: true });
      await stageCheckGit(task.worktree, join(staging, 'active'), { ref: 'refs/checks/active-owner' });
      const hook = join(origin, 'hooks/pre-receive');
      writeFileSync(hook, '#!/bin/sh\ncat >/dev/null\necho "release fixture rejected" >&2\nexit 1\n');
      chmodSync(hook, 0o755);
      await releaseCheckGit(task.worktree, manifest);
      const directory = join(task.worktree, '.temp/check-git-publications');
      const due = join(directory, 'due-owner.json');
      expect(JSON.parse(readFileSync(due, 'utf8')).ownership.state).toBe('releasable');
      writeFileSync(join(directory, 'unknown.json'), 'unknown custody');
      const native = join(task.worktree, '.temp/goal/checks/results/native-success.json');
      mkdirSync(join(native, '..'), { recursive: true });
      const result = JSON.stringify({
        status: 'finished',
        exitCode: 0,
        physicalRunId: '11111111-1111-4111-8111-111111111111',
      });
      writeFileSync(native, result);
      writeFileSync(hook, '#!/bin/sh\ncat >/dev/null\nexit 0\n');
      const runtime = {
        stateDirectory: h.settings.stateDirectory,
        mainCheckout: h.settings.mainCheckout,
        settings: h.settings,
        store: h.store,
      } as Runtime;
      expect(
        await runMaintenance('reap', runtime, undefined, {
          pressure: () => null,
          sleep: async () => {},
          command: () => {
            throw new Error('unresolved Git custody cannot discard its workspace');
          },
          now: () => Date.now() + CHECK_GIT_RELEASE_RETRY_MS + 1,
        }),
      ).toBe(0);
      expect(existsSync(due)).toBe(false);
      expect(git(task.worktree, 'ls-remote', '--refs', 'origin', 'refs/checks/due-owner')).toBe('');
      expect(git(task.worktree, 'ls-remote', '--refs', 'origin', 'refs/checks/frozen-owner')).toContain(
        'refs/checks/frozen-owner',
      );
      expect(git(task.worktree, 'ls-remote', '--refs', 'origin', 'refs/checks/active-owner')).toContain(
        'refs/checks/active-owner',
      );
      expect(existsSync(task.worktree)).toBe(true);
      expect(readFileSync(join(directory, 'unknown.json'), 'utf8')).toBe('unknown custody');
      expect(readFileSync(native, 'utf8')).toBe(result);
      expect(h.store.task(task.id).state).toBe(state);
      expect(h.store.hasPendingWorktreeCandidates()).toBe(true);
    } finally {
      await h.disposeAsync();
    }
  },
  10_000,
);

test('a resident verifier finishes its owned cycle and exits before checking with stale code', async () => {
  const settings = { mainCheckout: '/control-plane' } as Settings;
  let published: string | undefined;
  const events: string[] = [];
  const verify = async () => {
    events.push('cycle started');
    published = 'new';
    await Promise.resolve();
    events.push('cycle finished');
  };
  const readVersion = async (checkout: string) => {
    expect(checkout).toBe(settings.mainCheckout);
    return published;
  };
  expect(await runResidentVerifier({ settings, verify, loadedCodeVersion: 'old' }, readVersion)).toBe(0);
  expect(events).toEqual(['cycle started', 'cycle finished']);
  expect(await runResidentVerifier({ settings, verify, loadedCodeVersion: 'old' }, readVersion)).toBe(0);
  expect(events).toHaveLength(2);
});
