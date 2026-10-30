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

test('kernel schema dumps use the schema action of the derived generator', () => {
  const defaults = JSON.parse(readFileSync(join(import.meta.dir, '../defaults.json'), 'utf8'));
  expect(defaults.derivedFiles).toContainEqual({
    path: 'services/kernel/db/*/schema.sql',
    stage: 'integration',
    command: ['bun', 'run', '--cwd', 'services/kernel', 'derived', 'schema'],
  });
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

test('legacy affected and integration checks migrate to post-integration verifier settings', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.affectedTests = [];
    local.integrationChecks = [
      { paths: ['apps/**'], command: ['bun', 'install', '--frozen-lockfile'] },
      { paths: ['apps/**'], command: ['bun', 'scripts/typecheck.ts'] },
      { paths: ['apps/**'], command: ['bun', 'scripts/workspace-imports.ts'] },
      { paths: ['apps/widget/**'], command: ['bun', 'test', 'legacy-widget.test.ts'] },
    ];
    local.siblingTests = { command: ['bun', 'test', '--timeout', '30000'] };
    writeFileSync(h.settings.localFile, JSON.stringify(local));

    const settings = loadSettings({ cwd: h.root, env: {} });
    const selected = settings.verifierChecks ?? [];
    expect(selected).toContainEqual({ paths: ['apps/widget/**'], command: ['bun', 'test', 'legacy-widget.test.ts'] });
    expect(selected.some((check) => check.command.includes('scripts/typecheck.ts'))).toBe(false);
    expect(selected.some((check) => check.command.includes('install'))).toBe(false);
    expect(selected.some((check) => check.command.includes('apps/web/scripts/remote-browser.test.ts'))).toBe(true);
    expect(selected.some((check) => check.command.includes('page-stories.test.ts'))).toBe(true);
    expect(selected.some((check) => check.paths.includes('services/kernel/**'))).toBe(false);
    expect(selected.filter((check) => check.command.includes('scripts/workspace-imports.ts'))).toHaveLength(1);
    expect(settings.siblingTests).toEqual({ command: ['bun', 'test', '--timeout', '30000'] });
  } finally {
    h.dispose();
  }
});

test('an explicit verifierChecks setting is strict and replaces legacy validation selections', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.verifierChecks = [{ paths: ['packages/widget/**'], command: ['bun', 'test', 'widget.test.ts'] }];
    local.affectedTests = [{ paths: ['services/kernel/**'], command: ['legacy-kernel-check'] }];
    local.integrationChecks = [{ paths: ['apps/**'], command: ['bun', 'test', 'legacy-app.test.ts'] }];
    writeFileSync(h.settings.localFile, JSON.stringify(local));

    const settings = loadSettings({ cwd: h.root, env: {} });
    expect(settings.verifierChecks).toEqual(local.verifierChecks);
    expect(() => {
      writeFileSync(h.settings.localFile, JSON.stringify({ ...local, verifierChecks: [{ paths: [], command: ['true'] }] }));
      loadSettings({ cwd: h.root, env: {} });
    }).toThrow('paths must be a path list');
    expect(() => {
      writeFileSync(h.settings.localFile, JSON.stringify({ ...local, siblingTests: null }));
      loadSettings({ cwd: h.root, env: {} });
    }).toThrow('siblingTests must be an object');
  } finally {
    h.dispose();
  }
});
