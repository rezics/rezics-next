import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings, readDerivedFiles } from './config.ts';
import { git } from './tasks.ts';
import { harness } from './test-support.ts';

test('derived file input globs load with the declared generator', () => {
  expect(
    readDerivedFiles([
      {
        path: 'packages/client/src/kernel/**',
        stage: 'promotion',
        command: ['bun', 'run', '--cwd', 'services/kernel', 'derived'],
        inputs: ['services/kernel/**'],
      },
    ]),
  ).toEqual([
    {
      path: 'packages/client/src/kernel/**',
      stage: 'promotion',
      command: ['bun', 'run', '--cwd', 'services/kernel', 'derived'],
      inputs: ['services/kernel/**'],
    },
  ]);
  expect(() =>
    readDerivedFiles([{ path: 'out.txt', stage: 'promotion', command: ['true'], inputs: ['../secret'] }]),
  ).toThrow();
});

test('settings anchor to the main checkout from a linked worktree; local settings and environment override defaults', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile),
      initial = loadSettings({ cwd: task.worktree, env: {} });
    expect(initial.mainCheckout).toBe(h.root);
    expect(initial.stateDirectory).toBe(join(h.root, '.temp/goal'));
    expect(initial.worktreeRoot).toBe(join(h.root, '.temp/worktrees'));
    expect(initial.silenceMs).toBe(40 * 60_000);
    const local = JSON.parse(readFileSync(initial.localFile, 'utf8'));
    local.stateDirectory = '.temp/local-state';
    local.silenceMs = 12_345;
    local.integration = { gateConcurrency: 3, inboxDirectory: '.temp/incoming' };
    writeFileSync(initial.localFile, JSON.stringify(local));
    const settings = loadSettings({ cwd: task.worktree, env: { GOAL_STATE_DIRECTORY: '.temp/override' } });
    expect(settings.silenceMs).toBe(12_345);
    expect(settings.stateDirectory).toBe(join(h.root, '.temp/override'));
    expect(settings.integration.gateConcurrency).toBe(3);
    expect(settings.integration.inboxDirectory).toBe(join(h.root, '.temp/incoming'));
    expect(settings.pools[0]!.configDirectory).toBe(join(h.root, '.temp/goal/account'));
    local.pools[0].cli = 'unofficial';
    writeFileSync(initial.localFile, JSON.stringify(local));
    expect(() => loadSettings({ cwd: h.root, env: {} })).toThrow('unsupported pool');
  } finally {
    h.dispose();
  }
});
test('account configuration cannot be tracked, and an environment-selected untracked file is accepted', () => {
  const h = harness();
  try {
    const local = readFileSync(h.settings.localFile, 'utf8'),
      path = join(h.root, 'tracked.json');
    writeFileSync(path, local);
    git(h.root, ['add', 'tracked.json']);
    expect(() => loadSettings({ cwd: h.root, env: { GOAL_LOCAL_CONFIG: path } })).toThrow('untracked');
    const other = join(h.root, '.temp/private/local.json');
    mkdirSync(join(h.root, '.temp/private'), { recursive: true });
    writeFileSync(other, local);
    expect(loadSettings({ cwd: h.root, env: { GOAL_LOCAL_CONFIG: other } }).localFile).toBe(other);
    const defaults = JSON.parse(readFileSync(join(import.meta.dir, '../defaults.json'), 'utf8'));
    expect(defaults.pools).toBeUndefined();
    expect(defaults.policy).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('manager-only Claude pool configuration remains available while worker profiles exclude it', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.pools[0].cli = 'claude';
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const settings = loadSettings({ cwd: h.root, env: {} });
    expect(settings.pools[0]!.cli).toBe('claude');
  } finally {
    h.dispose();
  }
});
