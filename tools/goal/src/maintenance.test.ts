import { expect, test } from 'bun:test';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from './config.ts';
import type { Settings } from './types.ts';
import { maintenanceCommand, runMaintenance } from './maintenance.ts';
import { git } from './merge.ts';
import { readControlPolicy } from './policy.ts';
import { regenerateDerivedHead } from './promotion.ts';
import { temporaryDirectory } from './test-support.ts';

test('a sweep expires on policy budget, reports skipped steps and releases its lease', async () => {
  const dir = temporaryDirectory();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  const runtime = {
    stateDirectory: dir.path,
    settings: { policy: readControlPolicy({ maintenance: { budgetMs: 30 } }) },
    store: { tasks: () => [] },
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
