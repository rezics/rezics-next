import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright';
import {
  hasWebCheckCustody,
  placeWebCheck,
  routeWebCheck,
  trustedDriver,
  webCheckDriverCommand,
  webCheckEnvironment,
  workspacePath,
  type DriverExecution,
  type WebPlacementRuntime,
} from './check-placement.ts';
import { runBrowserWorker, runWebTestLanes } from './check.ts';
import { smokeStorybook } from './storybook-smoke.ts';
import { unavailableInteractiveCheck } from './storybook-dev.ts';

const root = resolve(import.meta.dir, '../../..');
const app = resolve(root, 'apps/web');
const revision = 'a'.repeat(40);
const forged = {
  KERNEL_CHECK_ON_REMOTE: '1',
  REZICS_STACK_REMOTE: 'off',
  REZICS_CHECK_LOCAL_ONLY: '1',
  REZICS_CHECK_MEMORY_LEASE: 'tiny',
  REZICS_STACK_SLOT: '1',
  REZICS_STACK_LEASE: 'local',
};

function fixture() {
  const calls: DriverExecution[] = [];
  const overlays: Record<string, string>[] = [];
  let closed = 0;
  const adapter: WebPlacementRuntime = {
    custody: hasWebCheckCustody,
    driver: () => '/trusted/producer',
    hosts: () => '/private/hosts.json',
    revision: () => revision,
    environment(values) {
      overlays.push(values);
      return {
        path: '/private/invocation/environment.json',
        close: () => {
          closed += 1;
        },
      };
    },
    execute: async (input) => {
      calls.push(input);
      return 0;
    },
  };
  return { adapter, calls, overlays, closed: () => closed };
}

function git(directory: string, args: string[]): string {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function commit(directory: string, message: string): string {
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-m', message]);
  return git(directory, ['rev-parse', 'HEAD']);
}

function createDriverGitFixture() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const temporaryRoot = mkdtempSync(join(root, '.temp', 'web-driver-git-'));
  const repository = join(temporaryRoot, 'repository');
  const candidateRoot = join(temporaryRoot, 'candidate');
  const integratedRoot = join(temporaryRoot, 'integrated-driver');
  const unintegratedRoot = join(temporaryRoot, 'unintegrated-driver');
  mkdirSync(repository, { recursive: true });
  git(repository, ['init', '--initial-branch=main']);
  git(repository, ['config', 'user.name', 'Web placement fixture']);
  git(repository, ['config', 'user.email', 'web-placement@example.invalid']);

  const scripts = join(repository, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'check-run.ts'), "import { run } from './driver-helper.ts';\nexport { run };\n");
  const helperPath = join(scripts, 'driver-helper.ts');
  writeFileSync(helperPath, 'export function run(): number { return 1; }\n');
  const mainRevision = commit(repository, 'base driver');

  git(repository, ['switch', '-c', 'dev']);
  writeFileSync(helperPath, 'export function run(): number { return 2; }\n');
  const integratedRevision = commit(repository, 'integrated driver');
  writeFileSync(join(repository, 'dev-marker.txt'), 'dev has advanced beyond the driver snapshot\n');
  const devRevision = commit(repository, 'advance canonical dev');
  git(repository, ['switch', 'main']);
  git(repository, ['worktree', 'add', '--detach', candidateRoot, mainRevision]);
  git(repository, ['worktree', 'add', '--detach', integratedRoot, integratedRevision]);

  git(repository, ['switch', '-c', 'unintegrated', mainRevision]);
  writeFileSync(helperPath, 'export function run(): number { return 3; }\n');
  const unintegratedRevision = commit(repository, 'unintegrated driver');
  git(repository, ['switch', 'dev']);
  git(repository, ['worktree', 'add', '--detach', unintegratedRoot, unintegratedRevision]);

  return {
    temporaryRoot,
    repository,
    candidateRoot,
    integratedRoot,
    unintegratedRoot,
    helperPath: join(integratedRoot, 'scripts', 'driver-helper.ts'),
    mainRevision,
    integratedRevision,
    devRevision,
  };
}

function createForeignDriver(temporaryRoot: string): string {
  const repository = join(temporaryRoot, 'foreign-repository');
  mkdirSync(join(repository, 'scripts'), { recursive: true });
  git(repository, ['init', '--initial-branch=main']);
  git(repository, ['config', 'user.name', 'Web placement fixture']);
  git(repository, ['config', 'user.email', 'web-placement@example.invalid']);
  writeFileSync(join(repository, 'scripts', 'check-run.ts'), 'export {};\n');
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'foreign driver']);
  return repository;
}

function gitFixtureAdapter(candidateRoot: string) {
  const f = fixture();
  f.adapter.custody = () => false;
  f.adapter.driver = trustedDriver;
  f.adapter.revision = () => git(candidateRoot, ['rev-parse', 'HEAD']);
  return f;
}

async function routeWithGitDriver(candidateRoot: string, driverRoot: string, adapter: WebPlacementRuntime) {
  return routeWebCheck(
    {
      root: candidateRoot,
      cwd: candidateRoot,
      command: ['bun', 'test', 'tests/placement fixture.test.ts'],
    },
    { WEB_CHECK_DRIVER_ROOT: driverRoot },
    adapter,
  );
}

test('canonical dev accepts an integrated snapshot while main lags and keeps candidate argv identity', async () => {
  const gitFixture = createDriverGitFixture();
  try {
    expect(git(gitFixture.repository, ['rev-parse', 'main'])).toBe(gitFixture.mainRevision);
    expect(git(gitFixture.repository, ['rev-parse', 'dev'])).toBe(gitFixture.devRevision);
    expect(gitFixture.mainRevision).not.toBe(gitFixture.devRevision);
    expect(gitFixture.integratedRevision).not.toBe(gitFixture.devRevision);

    const f = gitFixtureAdapter(gitFixture.candidateRoot);
    const command = ['bun', 'test', 'tests/placement fixture.test.ts'];
    await routeWithGitDriver(gitFixture.candidateRoot, gitFixture.integratedRoot, f.adapter);

    expect(f.calls).toHaveLength(1);
    const argv = f.calls[0]!.command;
    expect(argv[1]).toBe(join(gitFixture.integratedRoot, 'scripts', 'check-run.ts'));
    expect(argv[argv.indexOf('--source-revision') + 1]).toBe(gitFixture.mainRevision);
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(command);
  } finally {
    rmSync(gitFixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('changed committed producer bytes are refused even when Git reports a clean snapshot', async () => {
  const gitFixture = createDriverGitFixture();
  try {
    git(gitFixture.repository, ['config', 'core.autocrlf', 'true']);
    const producerPath = join(gitFixture.integratedRoot, 'scripts', 'check-run.ts');
    const producer = readFileSync(producerPath, 'utf8');
    writeFileSync(producerPath, producer.replace(/\r?\n/g, '\r\n'));
    expect(git(gitFixture.integratedRoot, ['status', '--porcelain', '--untracked-files=normal'])).toBe('');

    const f = gitFixtureAdapter(gitFixture.candidateRoot);
    await expect(routeWithGitDriver(gitFixture.candidateRoot, gitFixture.integratedRoot, f.adapter)).rejects.toThrow(
      'differs from its committed source',
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    rmSync(gitFixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('unintegrated driver is refused before the trusted process starts', async () => {
  const gitFixture = createDriverGitFixture();
  try {
    const f = gitFixtureAdapter(gitFixture.candidateRoot);
    await expect(routeWithGitDriver(gitFixture.candidateRoot, gitFixture.unintegratedRoot, f.adapter)).rejects.toThrow(
      'not integrated into canonical dev',
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    rmSync(gitFixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('foreign common repository is refused before the trusted process starts', async () => {
  const gitFixture = createDriverGitFixture();
  try {
    const foreignDriver = createForeignDriver(gitFixture.temporaryRoot);
    const f = gitFixtureAdapter(gitFixture.candidateRoot);
    await expect(routeWithGitDriver(gitFixture.candidateRoot, foreignDriver, f.adapter)).rejects.toThrow(
      'share the candidate common Git repository',
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    rmSync(gitFixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('dirty helper source is refused before the trusted process starts', async () => {
  const gitFixture = createDriverGitFixture();
  try {
    writeFileSync(gitFixture.helperPath, `${readFileSync(gitFixture.helperPath, 'utf8')}\n// dirty\n`);
    const f = gitFixtureAdapter(gitFixture.candidateRoot);
    await expect(routeWithGitDriver(gitFixture.candidateRoot, gitFixture.integratedRoot, f.adapter)).rejects.toThrow(
      'checkout must be clean',
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    rmSync(gitFixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('missing canonical dev is refused before the trusted process starts', async () => {
  const gitFixture = createDriverGitFixture();
  try {
    git(gitFixture.repository, ['update-ref', '-d', 'refs/heads/dev']);
    const f = gitFixtureAdapter(gitFixture.candidateRoot);
    await expect(routeWithGitDriver(gitFixture.candidateRoot, gitFixture.integratedRoot, f.adapter)).rejects.toThrow(
      'canonical refs/heads/dev is absent',
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    rmSync(gitFixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('candidate cannot be selected as its own trusted driver', async () => {
  const gitFixture = createDriverGitFixture();
  try {
    const f = gitFixtureAdapter(gitFixture.candidateRoot);
    await expect(routeWithGitDriver(gitFixture.candidateRoot, gitFixture.candidateRoot, f.adapter)).rejects.toThrow(
      'separate from candidate source',
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    rmSync(gitFixture.temporaryRoot, { recursive: true, force: true });
  }
});

// These are logical check invocations, never spawned by this suite. Includes both composition builds and UI's
// slow-frame route, not just package wrappers. Production callers keep their native assertions and fixture cleanup.
const finiteRoutes = [
  {
    cwd: app,
    command: ['bun', 'scripts/check.ts', '--skip-format', '--test-command', 'bun run test'],
    returns: ['apps/web/.cache/check-timings.json'],
  },
  {
    cwd: app,
    command: ['bun', 'scripts/check.ts', '--browser', '--report', '.temp/report', 'tests/page-stories.test.ts'],
    returns: ['.temp/report'],
  },
  { cwd: app, command: ['bun', 'scripts/check.ts', '--host'], returns: [] },
  { cwd: app, command: ['bun', 'scripts/check.ts', '--personal-host'], returns: [] },
  { cwd: app, command: ['bun', 'scripts/check.ts', '--auth-binding-host'], returns: [] },
  {
    cwd: app,
    command: ['bun', 'scripts/focused.ts', '--private-network', '--', 'bun', 'test', 'tests/page-stories.test.ts'],
    returns: [],
  },
  { cwd: app, command: ['bun', 'scripts/storybook-build.ts'], returns: ['apps/web/storybook-static'] },
  {
    cwd: app,
    command: ['bun', 'scripts/storybook-deploy.ts', '--validate-only'],
    returns: ['apps/web/storybook-static'],
  },
  { cwd: app, command: ['bun', 'scripts/storybook-smoke.ts'], returns: [] },
  {
    cwd: app,
    command: ['bun', 'scripts/screenshots.ts', '--story', 'pages-*', '--out', '.temp/shots'],
    returns: ['.temp/shots'],
  },
  { cwd: app, command: ['bun', 'scripts/cards.ts'], returns: ['apps/web/public/cards'] },
  {
    cwd: app,
    command: ['vite', 'build', '--config', 'vite.config.ts'],
    returns: ['apps/web/dist', 'apps/web/.wrangler'],
  },
  { cwd: app, command: ['bun', 'scripts/isolated.ts', 'bun', 'test'], returns: [] },
  { cwd: resolve(root, 'packages/ui'), command: ['bun', 'scripts/isolated.ts', 'bun', 'test'], returns: [] },
  {
    cwd: resolve(root, 'packages/ui'),
    command: ['bun', 'scripts/isolated.ts', 'bun', 'x', 'vitest', 'run', '--config', 'vitest.slow-frames.config.ts'],
    returns: [],
  },
  {
    cwd: resolve(root, 'packages/ui'),
    command: ['./node_modules/.bin/storybook', 'build', '--quiet', '--config-dir', '.storybook'],
    returns: [],
  },
];

test('every finite heavy route crosses the exact driver with ordered argv, cwd, source and returns', async () => {
  for (const route of finiteRoutes) {
    const f = fixture();
    let nativeStarts = 0;
    expect(
      await placeWebCheck(
        { root, label: 'heavy route', ...route },
        async () => {
          nativeStarts += 1;
          return 0;
        },
        forged,
        f.adapter,
      ),
    ).toBe(0);
    expect(nativeStarts).toBe(0);
    expect(f.calls).toHaveLength(1);
    const args = f.calls[0]!.command;
    expect(args.slice(args.indexOf('--') + 1)).toEqual(route.command);
    expect(args.slice(0, 14)).toEqual([
      'bun',
      '/trusted/producer/scripts/check-run.ts',
      '--hosts',
      '/private/hosts.json',
      '--workspace',
      root,
      '--cwd',
      route.cwd === app ? 'apps/web' : 'packages/ui',
      '--source-revision',
      revision,
      '--env-file',
      '/private/invocation/environment.json',
      ...(route.returns.length ? ['--returns', route.returns[0]!] : ['--', route.command[0]!]),
    ]);
    expect(f.closed()).toBe(1);
  }
});

test('absent/invalid hosts or producer source never admit the native callback', async () => {
  for (const boundary of ['driver', 'hosts', 'revision'] as const) {
    const f = fixture();
    f.adapter[boundary] = () => {
      throw new Error(`${boundary} unavailable`);
    };
    let nativeStarts = 0;
    await expect(
      placeWebCheck(
        { root, cwd: app, label: 'heavy', command: ['bun', 'test', '--local'] },
        async () => {
          nativeStarts += 1;
          return 0;
        },
        forged,
        f.adapter,
      ),
    ).rejects.toThrow(`${boundary} unavailable`);
    expect(nativeStarts).toBe(0);
    expect(f.calls).toHaveLength(0);
  }
});

test('unreachable transport, timeout and native exits are returned without a local replay', async () => {
  for (const status of [75, 124, 1, 17, 130, 143]) {
    const f = fixture();
    f.adapter.execute = async (input) => {
      f.calls.push(input);
      return status;
    };
    expect(await routeWebCheck({ root, cwd: app, command: ['unknown', '--local'] }, forged, f.adapter)).toBe(status);
    expect(f.calls).toHaveLength(1);
    expect(f.closed()).toBe(1);
  }
  const f = fixture();
  const error = new AggregateError([new Error('native failed'), new Error('return/cleanup failed')]);
  f.adapter.execute = async () => {
    throw error;
  };
  await expect(routeWebCheck({ root, cwd: app, command: ['bun', 'test'] }, {}, f.adapter)).rejects.toBe(error);
  expect(f.closed()).toBe(1);
});

test('only actual remote custody admits the native continuation; forged markers are irrelevant', async () => {
  const f = fixture();
  expect(hasWebCheckCustody(root, app)).toBe(false);
  expect(await routeWebCheck({ root, cwd: app, command: ['bun', 'test'] }, forged, f.adapter)).toBe(0);
  f.adapter.custody = () => true; // Trusted physical-boundary fixture, not an environment override.
  expect(await routeWebCheck({ root, cwd: app, command: ['bun', 'test'] }, {}, f.adapter)).toBeNull();
  expect(f.calls).toHaveLength(1);
});

test('private environment cleanup cannot hide native or transport failure', async () => {
  for (const native of [true, false]) {
    const f = fixture();
    const cleanup = new Error('private environment cleanup failed');
    const transport = new Error('transport terminality unknown');
    f.adapter.environment = () => ({
      path: '/private/environment.json',
      close: () => {
        throw cleanup;
      },
    });
    f.adapter.execute = async () => {
      if (native) return 17;
      throw transport;
    };
    let failure: unknown;
    try {
      await routeWebCheck({ root, cwd: app, command: ['bun', 'test'] }, {}, f.adapter);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors[1]).toBe(cleanup);
    if (native) expect(errors[0].message).toContain('status 17');
    else expect(errors[0]).toBe(transport);
  }
});

test('semantic strings/newlines survive JSON while host controls and receipt authority stay at the driver', async () => {
  const f = fixture();
  const env = {
    ...forged,
    CI: '1',
    MESSAGE: 'a\nb "quoted" $literal',
    STORYBOOK_OUTPUT_DIR: resolve(app, 'storybook-static'),
    WEB_CHECK_EVENTS: resolve(root, '.temp/events'),
    GOAL_SESSION_SECRET: 'private',
    PATH: '/local/bin',
    HOME: '/local/home',
    REMOTE_CHECK_RECEIPT_FD: '3',
    REMOTE_CHECK_RECEIPT_NONCE: 'authenticated',
  };
  const command = ['env', 'NAME=value with spaces\nand newline', 'bun', 'test', '--test-name-pattern', 'a "quote"'];
  await routeWebCheck({ root, cwd: app, command }, env, f.adapter);
  expect(JSON.parse(JSON.stringify(f.overlays[0]))).toEqual({
    CI: '1',
    MESSAGE: env.MESSAGE,
    STORYBOOK_OUTPUT_DIR: 'storybook-static',
    WEB_CHECK_EVENTS: '../../.temp/events',
  });
  expect(f.calls[0]!.env.REMOTE_CHECK_RECEIPT_NONCE).toBe('authenticated');
  expect(f.calls[0]!.command.slice(-command.length)).toEqual(command);
  expect(f.calls[0]!.command).toContain('.temp/events');
});

test('ambient Nix trust path stays out of the remote overlay while semantics, argv and returns survive', async () => {
  const f = fixture();
  const certificatePath = '/nix/store/host-cacerts/etc/ssl/certs/ca-bundle.crt';
  const env = {
    NIX_SSL_CERT_FILE: certificatePath,
    CI: '1',
    MESSAGE: 'a\nb "quoted" $literal',
    STORYBOOK_OUTPUT_DIR: resolve(app, 'storybook-static'),
    GROWTH_PROFILE: resolve(app, '.temp/growth-profile.json'),
    WEB_TEST_STATE_DIR: resolve(app, '.temp/web-test-state'),
    WEB_CHECK_EVENTS: resolve(root, '.temp/web-check-events'),
  };
  const originalEnvironment = { ...env };
  const command = ['bun', 'test', 'tests/check placement.test.ts', '--test-name-pattern', 'a "quote"'];

  await routeWebCheck({ root, cwd: app, command, returns: ['apps/web/reports/check.json'] }, env, f.adapter);

  expect(f.overlays).toHaveLength(1);
  expect(f.overlays[0]).toEqual({
    CI: '1',
    MESSAGE: env.MESSAGE,
    STORYBOOK_OUTPUT_DIR: 'storybook-static',
    GROWTH_PROFILE: '.temp/growth-profile.json',
    WEB_TEST_STATE_DIR: '.temp/web-test-state',
    WEB_CHECK_EVENTS: '../../.temp/web-check-events',
  });
  expect(f.overlays[0]).not.toHaveProperty('NIX_SSL_CERT_FILE');
  expect(JSON.stringify(f.overlays[0])).not.toContain(certificatePath);
  expect(env).toEqual(originalEnvironment);
  expect(f.calls[0]!.env).toBe(env);

  const argv = f.calls[0]!.command;
  const returns: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--returns') returns.push(argv[index + 1]!);
  }
  expect(returns).toEqual([
    'apps/web/reports/check.json',
    'apps/web/.temp/growth-profile.json',
    'apps/web/.temp/web-test-state',
    '.temp/web-check-events',
  ]);
  expect(argv.slice(argv.indexOf('--') + 1)).toEqual(command);
});

test('Nix certificate classification leaves unrelated absolute settings and option refusals intact', async () => {
  const certificatePath = '/nix/store/host-cacerts/etc/ssl/certs/ca-bundle.crt';
  const unsupported = [
    ['SSL_CERT_FILE', '/nix/store/another-cacerts/etc/ssl/certs/ca-bundle.crt'],
    ['APP_CONFIG_PATH', '/nix/store/app-config/config.json'],
    ['NODE_OPTIONS', '--require=/nix/store/node-hook/register.cjs'],
    ['BUN_OPTIONS', '--preload=/nix/store/bun-hook/register.ts'],
  ] as const;

  for (const [name, value] of unsupported) {
    const f = fixture();
    await expect(
      routeWebCheck(
        { root, cwd: app, command: ['bun', 'test'] },
        { NIX_SSL_CERT_FILE: certificatePath, [name]: value },
        f.adapter,
      ),
    ).rejects.toThrow(`unsupported host-path environment setting ${name}`);
    expect(f.overlays).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  }
});

test('unsupported host dependencies and destinations fail before a driver or native process starts', async () => {
  expect(() => workspacePath(root, '/outside/screenshots')).toThrow('inside the candidate workspace');
  expect(() => webCheckEnvironment({ WEB_TEST_STATE_DIR: '/outside/state' }, root, app)).toThrow();
  expect(() => webCheckEnvironment({ NATIVE_CONFIG_FILE: '/outside/config' }, root, app)).toThrow('NATIVE_CONFIG_FILE');
  const f = fixture();
  await expect(
    routeWebCheck({ root, cwd: app, command: ['bun', 'test', '/outside/test.ts'] }, {}, f.adapter),
  ).rejects.toThrow('host-absolute');
  expect(f.calls).toHaveLength(0);
  expect(() =>
    webCheckDriverCommand({
      driverRoot: '/trusted',
      hosts: '/private/hosts',
      workspace: root,
      cwd: 'apps/web',
      revision: 'short',
      environmentFile: '/private/env',
      command: ['bun', 'test'],
      returns: [],
    }),
  ).toThrow('full candidate revision');
  expect(() =>
    webCheckDriverCommand({
      driverRoot: root,
      hosts: '/private/hosts',
      workspace: root,
      cwd: 'apps/web',
      revision,
      environmentFile: '/private/env',
      command: ['bun', 'test'],
      returns: [],
    }),
  ).toThrow('separate from candidate');
});

test('cancellation before dispatch cannot start queued work and the driver observes in-flight abort', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  expect(await routeWebCheck({ root, cwd: app, command: ['bun', 'test'] }, {}, f.adapter, controller.signal)).toBe(143);
  expect(f.calls).toHaveLength(0);
  const active = new AbortController();
  f.adapter.execute = async (input) => {
    expect(input.signal).toBe(active.signal);
    active.abort();
    return input.signal!.aborted ? 143 : 0;
  };
  expect(await routeWebCheck({ root, cwd: app, command: ['bun', 'test'] }, {}, f.adapter, active.signal)).toBe(143);
  expect(f.closed()).toBe(1);
});

test('callable workers and a supplied browser cannot bypass physical placement', async () => {
  const browser = {
    newPage: () => {
      throw new Error('browser must not be used');
    },
  } as unknown as Browser;
  await expect(smokeStorybook('https://example.invalid/', browser)).rejects.toThrow('actual remote run directory');
  await expect(runBrowserWorker({ files: [], report: '.temp/report', env: forged })).rejects.toThrow(
    'actual remote run directory',
  );
  await expect(runWebTestLanes({ files: [], env: forged })).rejects.toThrow('actual remote run directory');
  expect(() => unavailableInteractiveCheck()).toThrow('remote access/tunnel');
});
