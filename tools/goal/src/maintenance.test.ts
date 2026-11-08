import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from './config.ts';
import type { Settings } from './types.ts';
import { maintenanceCommand, runMaintenance } from './maintenance.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { git } from './merge.ts';
import { readControlPolicy } from './policy.ts';
import { regenerateDerivedHead } from './promotion.ts';
import { temporaryDirectory } from './test-support.ts';

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
