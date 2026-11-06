import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as configEntry from './config.ts';
import { checkSettings, createRuntime, loadSettings, readDerivedFiles } from './config.ts';
import { routePageDataRepair as runtimePageDataRepair } from './runtime-repair-routing.ts';
import { configurationProblem } from './local-settings.ts';
import * as settingsEntry from './settings.ts';
import { run } from './cli.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { git } from './tasks.ts';
import { harness } from './test-support.ts';

test('promotion placement requires an explicit ordinary host source in untracked local settings', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.promotionPlacement = { ordinaryHostsFile: '.temp/goal/remote-check-hosts.json' };
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(loadSettings({ cwd: h.root, env: {} }).promotionPlacement).toEqual({
      ordinaryHostsFile: join(h.root, '.temp/goal/remote-check-hosts.json'),
    });

    local.promotionPlacement = {};
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(() => checkSettings({ cwd: h.root, env: {} })).toThrow('promotionPlacement.ordinaryHostsFile');

    local.promotionPlacement = {
      ordinaryHostsFile: '.temp/goal/remote-check-hosts.json',
      gateSlots: 3,
    };
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(checkSettings({ cwd: h.root, env: {} }).promotionPlacement).toEqual({
      ordinaryHostsFile: join(h.root, '.temp/goal/remote-check-hosts.json'),
    });
  } finally {
    h.dispose();
  }
});

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
    expect(() => checkSettings({ cwd: h.root, env: {} })).toThrow('unsupported pool');
  } finally {
    h.dispose();
  }
});

test('config and settings entries share resolution, strict validation, and recovery identity', () => {
  expect(configEntry.routePageDataRepair).toBe(runtimePageDataRepair);
  for (const name of [
    'mainCheckout',
    'settingsFile',
    'loadSettings',
    'checkSettings',
    'readDerivedFiles',
    'readIntegrationChecks',
    'readControlPolicy',
  ] as const)
    expect(configEntry[name]).toBe(settingsEntry[name]);

  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const env = { GOAL_LOCAL_CONFIG: h.settings.localFile, GOAL_STATE_DIRECTORY: '.temp/env-state' };
    const envOptions = { cwd: task.worktree, env };
    const localOptions = {
      cwd: task.worktree,
      env: { GOAL_STATE_DIRECTORY: '.temp/env-state' },
      localFile: h.settings.localFile,
    };
    expect(configEntry.mainCheckout(task.worktree)).toBe(h.root);
    expect(configEntry.settingsFile(envOptions)).toBe(settingsEntry.settingsFile(envOptions));
    expect(configEntry.settingsFile(localOptions)).toBe(settingsEntry.settingsFile(localOptions));
    expect(configEntry.loadSettings(envOptions)).toEqual(settingsEntry.loadSettings(localOptions));
    expect(configEntry.loadSettings(envOptions).stateDirectory).toBe(join(h.root, '.temp/env-state'));

    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.silenceMs = 12_345;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(settingsEntry.loadSettings(localOptions).silenceMs).toBe(12_345);

    local.silenceMs = 'invalid';
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(() => configEntry.checkSettings(localOptions)).toThrow('invalid silenceMs');
    expect(() => settingsEntry.checkSettings(localOptions)).toThrow('invalid silenceMs');
    const recovered = settingsEntry.loadSettings(localOptions);
    expect(recovered.silenceMs).toBe(12_345);
    expect(configurationProblem(recovered)?.reported).toBe(false);

    local.silenceMs = 23_456;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(configEntry.loadSettings(localOptions).silenceMs).toBe(23_456);
  } finally {
    h.dispose();
  }
});

test('createRuntime keeps landing, control-plane and compiler runner behavior observable on refresh', async () => {
  const h = harness();
  let runtime: ReturnType<typeof createRuntime> | undefined;
  const previousPriority = process.env.REMOTE_CHECK_PRIORITY;
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    Object.assign(local, {
      stateDirectory: '.temp/check-runtime-state',
      integration: { ...local.integration, gateTimeoutMs: 120, checkResultReuse: true },
    });
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const settings = loadSettings({ cwd: h.root, env: {} });
    mkdirSync(settings.stateDirectory, { recursive: true });
    writeFileSync(join(settings.stateDirectory, 'remote-check-hosts.json'), '[]');
    process.env.REMOTE_CHECK_PRIORITY = 'inherited';
    runtime = createRuntime({ settings });

    const snapshot = await runtime.refreshTrainConfiguration!();
    const capture = join(settings.stateDirectory, 'runner-environments.jsonl');
    const script = [
      `import { appendFileSync } from 'node:fs';`,
      `const value = { priority: process.env.REMOTE_CHECK_PRIORITY ?? null, remote: process.env.KERNEL_CHECK_REMOTE ?? null, cache: process.env.NODE_DISABLE_COMPILE_CACHE ?? null };`,
      `appendFileSync(${JSON.stringify(capture)}, JSON.stringify(value) + '\\n');`,
      `console.log(JSON.stringify(value));`,
    ].join('\n');
    const command = [process.execPath, '-e', script];
    const log = (name: string) => join(settings.stateDirectory, `${name}.log`);

    expect((await snapshot.runGate!(command, h.root, log('landing-first'))).passed).toBe(true);
    expect((await snapshot.runGate!(command, h.root, log('landing-reuse'))).output).toBe('reused check result');
    expect((await snapshot.runControlPlaneGate!(command, h.root, log('control-plane-first'))).passed).toBe(true);
    expect((await snapshot.runControlPlaneGate!(command, h.root, log('control-plane-second'))).passed).toBe(true);
    expect((await snapshot.runTypecheck!(command, h.root, log('compiler'))).passed).toBe(true);

    expect(
      readFileSync(capture, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { priority: 'landing', remote: join(settings.stateDirectory, 'remote-check-hosts.json'), cache: '1' },
      { priority: 'landing', remote: join(settings.stateDirectory, 'remote-check-hosts.json'), cache: '1' },
      { priority: 'landing', remote: join(settings.stateDirectory, 'remote-check-hosts.json'), cache: '1' },
      { priority: 'inherited', remote: join(settings.stateDirectory, 'remote-check-hosts.json'), cache: '1' },
    ]);

    const slowCommand = [process.execPath, '-e', 'await new Promise((resolve) => setTimeout(resolve, 1000))'];
    expect((await snapshot.runGate!(slowCommand, h.root, log('landing-timeout'))).timedOut).toBe(true);
    expect((await snapshot.runTypecheck!(slowCommand, h.root, log('compiler-timeout'))).timedOut).toBe(true);
  } finally {
    runtime?.close();
    if (previousPriority === undefined) delete process.env.REMOTE_CHECK_PRIORITY;
    else process.env.REMOTE_CHECK_PRIORITY = previousPriority;
    h.dispose();
  }
});

test('an invalid live local file keeps its last valid settings, is reported once, and config check stays strict', async () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    Object.assign(local, { note: 'root', $comment: 'root', silenceMs: 11_111 });
    local.integration = { operationsManager: 'operations', note: 'nested' };
    local.pools[0].note = 'pool';
    local.pools[0].policy.$comment = 'policy';
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const load = () => loadSettings({ cwd: h.root, env: {} });
    expect(load().silenceMs).toBe(11_111);
    expect(load().pools[0]!.policy).not.toHaveProperty('$comment');

    local.silenceMs = 22_222;
    local.pools[0].policy.typo = 1;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(checkSettings({ cwd: h.root, env: {} }).silenceMs).toBe(22_222);
    expect(checkSettings({ cwd: h.root, env: {} }).pools[0]!.policy).not.toHaveProperty('typo');
    expect(load().silenceMs).toBe(22_222);
    expect(await run(['config', 'check', h.settings.localFile])).toBe(0);

    local.silenceMs = 'invalid';
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(() => checkSettings({ cwd: h.root, env: {} })).toThrow('invalid silenceMs');
    for (let process = 0; process < 2; process++) {
      const settings = load();
      expect(settings.silenceMs).toBe(22_222);
      createRuntime({ settings }).close();
    }
    const inbox = new SqliteManagerInbox(openDb(join(h.settings.stateDirectory, 'goal.sqlite')), h.root);
    for (const manager of ['operations', 'supermanager']) {
      const events = inbox.read(manager).filter((entry) => entry.event.summary.includes('Local settings'));
      expect(events).toHaveLength(1);
      expect(events[0]!.deliveries).toBeUndefined();
      expect(events[0]!.event.summary).toContain('invalid silenceMs');
    }
    expect(await run(['config', 'check', h.settings.localFile])).toBe(1);

    local.silenceMs = 33_333;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(load().silenceMs).toBe(33_333);
    expect(await run(['config', 'check', h.settings.localFile])).toBe(0);
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
    expect(defaults.policy).toBeDefined();
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

test('hourly report notifier is optional and its command and timeout are bounded', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    const defaults = loadSettings({ cwd: h.root, env: {} });
    expect(defaults.integration.hourlyReportNotifier).toBeUndefined();
    expect(defaults.integration.hourlyReportTimeoutMs).toBe(20_000);

    local.integration = {
      ...local.integration,
      hourlyReportNotifier: ['/usr/local/bin/notify-delivery', '--room', 'delivery-ops'],
      hourlyReportTimeoutMs: 120_000,
    };
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(loadSettings({ cwd: h.root, env: {} }).integration).toMatchObject({
      hourlyReportNotifier: ['/usr/local/bin/notify-delivery', '--room', 'delivery-ops'],
      hourlyReportTimeoutMs: 120_000,
    });

    local.integration.hourlyReportTimeoutMs = 120_001;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(() => checkSettings({ cwd: h.root, env: {} })).toThrow('at most 120000');
    local.integration.hourlyReportTimeoutMs = 20_000;
    local.integration.hourlyReportNotifier = ['notify', ''];
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(() => checkSettings({ cwd: h.root, env: {} })).toThrow('hourlyReportNotifier');
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
    expect(selected.some((check) => check.command.some((part) => part.includes('page-stories.test.ts')))).toBe(true);
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
      writeFileSync(
        h.settings.localFile,
        JSON.stringify({ ...local, verifierChecks: [{ paths: [], command: ['true'] }] }),
      );
      checkSettings({ cwd: h.root, env: {} });
    }).toThrow('paths must be a path list');
    expect(() => {
      writeFileSync(h.settings.localFile, JSON.stringify({ ...local, siblingTests: null }));
      checkSettings({ cwd: h.root, env: {} });
    }).toThrow('siblingTests must be an object');
  } finally {
    h.dispose();
  }
});
