import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTestCommandLanes } from '../scripts/isolated.ts';
import { resolveWebTestSelection } from '../scripts/selection.ts';

// Containers starting and stopping on the host add and remove network interfaces while tests run. Chromium aborts
// in-flight requests, even to 127.0.0.1, with net::ERR_NETWORK_CHANGED whenever an interface changes, so a page whose
// client script was in flight never hydrates. Browser tests therefore run in a private network namespace that holds
// only loopback, where the host's interface changes cannot reach them.
const root = join(import.meta.dir, '..', '..', '..');
const packages = ['apps/web', 'packages/ui'];
const bun = process.execPath;
const isolatable =
  process.platform === 'linux' &&
  Bun.spawnSync(['unshare', '--user', '--map-root-user', '--net', 'true'], { stderr: 'ignore' }).exitCode === 0;

const probe = `
const names = Object.keys(require('node:os').networkInterfaces()).sort();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
const body = await (await fetch(server.url)).text();
server.stop(true);
console.log(JSON.stringify({ names, body }));
`;

function run(pkg: string, command: string[], env: Record<string, string | undefined> = process.env) {
  const result = Bun.spawnSync([bun, 'scripts/isolated.ts', ...command], {
    cwd: join(root, pkg),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test('UI-only selections stay in the private lane with every CLI argument preserved', () => {
  const command = ['bun', 'test', '--timeout', '4000', 'tests/shell.test.ts'];
  expect(planTestCommandLanes(command, join(root, 'apps/web'))).toEqual([{ args: command, isolate: true }]);
});

test('native-only selections run in the host lane', () => {
  const command = ['bun', 'test', '--timeout', '4000', 'tests/native/stack.host.test.ts'];
  expect(planTestCommandLanes(command, join(root, 'apps/web'))).toEqual([
    {
      args: [
        'bun',
        'test',
        '--path-ignore-patterns=node_modules/**',
        '--timeout',
        '4000',
        'tests/native/stack.host.test.ts',
      ],
      isolate: false,
    },
  ]);
});

test('mixed UI and native selections preserve the original arguments in separate lanes', () => {
  const command = ['bun', 'test', '--timeout', '4000', 'tests/shell.test.ts', 'tests/native/stack.host.test.ts'];
  expect(planTestCommandLanes(command, join(root, 'apps/web'))).toEqual([
    { args: ['bun', 'test', '--timeout', '4000', 'tests/shell.test.ts'], isolate: true },
    {
      args: [
        'bun',
        'test',
        '--path-ignore-patterns=node_modules/**',
        '--timeout',
        '4000',
        'tests/native/stack.host.test.ts',
      ],
      isolate: false,
    },
  ]);
});

test('the recorder remains a host-lane exception in a mixed selection', () => {
  const command = ['bun', 'test', 'tests/search.test.ts', 'tests/record-script.test.ts'];
  expect(planTestCommandLanes(command, join(root, 'apps/web'))).toEqual([
    { args: ['bun', 'test', 'tests/search.test.ts'], isolate: true },
    { args: ['bun', 'test', 'tests/record-script.test.ts'], isolate: false },
  ]);
});

test('a default package selection routes all native receipts and the recorder to the host lane', () => {
  const lanes = planTestCommandLanes(['bun', 'test'], join(root, 'apps/web'));
  expect(lanes).toHaveLength(3);
  expect(lanes[0]!.isolate).toBe(true);
  expect(lanes[0]!.args.every((argument) => !argument.endsWith('.host.test.ts'))).toBe(true);
  expect(lanes[1]).toEqual({ args: ['bun', 'scripts/check.ts', '--auth-binding-host'], isolate: false });
  expect(lanes[2]!.isolate).toBe(false);
  expect(lanes[2]!.args).toContain('--path-ignore-patterns=node_modules/**');
  expect(lanes[2]!.args.some((argument) => argument.endsWith('native-site-foundation.host.test.ts'))).toBe(true);
  expect(lanes[2]!.args.some((argument) => argument.endsWith('record-script.test.ts'))).toBe(true);
});

test('repository selectors expand once, keep path-shaped option operands, and split host and UI argv', () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const fixtureRoot = mkdtempSync(join(root, '.temp/network-selection-'));
  const appDirectory = join(fixtureRoot, 'apps', 'web');
  const nativeDirectory = join(appDirectory, 'tests', 'native');
  mkdirSync(nativeDirectory, { recursive: true });
  mkdirSync(join(appDirectory, 'tests'), { recursive: true });
  writeFileSync(join(appDirectory, 'tests', 'auth-binding.host.test.ts'), '');
  for (const file of [
    join(nativeDirectory, 'native.host.test.ts'),
    join(nativeDirectory, 'native-sibling.host.test.ts'),
    join(appDirectory, 'tests', 'ui.test.ts'),
  ])
    writeFileSync(file, '');

  try {
    const command = [
      'bun',
      'test',
      '--timeout',
      '12345',
      '--preload',
      'apps/web/tests/native/option-value.test.ts',
      '--test-name-pattern',
      'binding',
      'apps/web/tests/auth-binding.host.test.ts',
      'apps/web/tests/native/native.host.test.ts',
      'tests/native/*.host.test.ts',
      'tests/ui.test.ts',
    ];
    const selection = resolveWebTestSelection(command, {
      rootDirectory: fixtureRoot,
      appDirectory,
      invocationDirectory: fixtureRoot,
      source: 'repository test entrypoint',
    });
    expect(selection.selectedFiles).toEqual([
      'tests/auth-binding.host.test.ts',
      'tests/native/native.host.test.ts',
      'tests/native/native-sibling.host.test.ts',
      'tests/ui.test.ts',
    ]);
    expect(selection.normalizedArgv).toEqual([
      'bun',
      'test',
      '--timeout',
      '12345',
      '--preload',
      'apps/web/tests/native/option-value.test.ts',
      '--test-name-pattern',
      'binding',
      'tests/auth-binding.host.test.ts',
      'tests/native/native.host.test.ts',
      'tests/native/native-sibling.host.test.ts',
      'tests/ui.test.ts',
    ]);
    const absoluteGlob = resolveWebTestSelection(['bun', 'test', join(nativeDirectory, '*.host.test.ts')], {
      rootDirectory: fixtureRoot,
      appDirectory,
      invocationDirectory: fixtureRoot,
      source: 'repository test entrypoint',
    });
    expect(absoluteGlob.selectedFiles).toEqual([
      'tests/native/native-sibling.host.test.ts',
      'tests/native/native.host.test.ts',
    ]);
    expect(planTestCommandLanes(selection.command, appDirectory, selection, fixtureRoot)).toEqual([
      {
        args: [
          'bun',
          'test',
          '--timeout',
          '12345',
          '--preload',
          'apps/web/tests/native/option-value.test.ts',
          '--test-name-pattern',
          'binding',
          'tests/ui.test.ts',
        ],
        isolate: true,
      },
      {
        args: [
          'bun',
          'scripts/check.ts',
          '--auth-binding-host',
          '--timeout',
          '12345',
          '--preload',
          'apps/web/tests/native/option-value.test.ts',
          '--test-name-pattern',
          'binding',
        ],
        isolate: false,
      },
      {
        args: [
          'bun',
          'test',
          '--path-ignore-patterns=node_modules/**',
          '--timeout',
          '12345',
          '--preload',
          'apps/web/tests/native/option-value.test.ts',
          '--test-name-pattern',
          'binding',
          'tests/native/native.host.test.ts',
          'tests/native/native-sibling.host.test.ts',
        ],
        isolate: false,
      },
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

for (const pkg of packages) {
  test.if(isolatable)(
    `${pkg} runs a command in a private network namespace where only loopback exists and works`,
    () => {
      const result = run(pkg, [bun, '-e', probe]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({ names: ['lo'], body: 'ok' });
    },
  );

  test.if(isolatable)(`${pkg} passes the command's exit code through`, () => {
    expect(run(pkg, [bun, '-e', 'process.exit(3)']).exitCode).toBe(3);
  });

  test.if(process.platform === 'linux')(
    `${pkg} runs the command on the host network, and says so, where it cannot isolate it`,
    () => {
      const bin = mkdtempSync(join(tmpdir(), 'no-unshare-'));
      try {
        symlinkSync(bun, join(bin, 'bun'));
        const env = { ...process.env, PATH: bin };
        const result = run(pkg, [bun, '-e', probe], env);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!).body).toBe('ok');
        expect(result.stderr.trim().split('\n').length).toBe(1);
        expect(run(pkg, [bun, '-e', 'process.exit(3)'], env).exitCode).toBe(3);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );

  test(`${pkg} runs its tests through the isolation script, in its check too`, async () => {
    const { scripts } = await Bun.file(join(root, pkg, 'package.json')).json();
    expect(scripts.test).toBe('bun scripts/isolated.ts bun test');
    expect(scripts.check).toContain('bun run test');
    expect(` ${scripts.check} `).not.toMatch(/[\s&;]bun test[\s&;]/);
  });
}

test('apps/web removes its owned state directory after the child exits', () => {
  const environment = { ...process.env };
  delete environment.WEB_TEST_STATE_DIR;
  const result = run(
    'apps/web',
    [bun, '-e', 'console.log(process.env.WEB_TEST_STATE_DIR); process.exit(7)'],
    environment,
  );
  expect(result.exitCode).toBe(7);
  const stateDirectory = result.stdout
    .trim()
    .split('\n')
    .find((line) => line.startsWith(join(tmpdir(), 'rezics-web-test-')));
  expect(stateDirectory).toBeDefined();
  expect(existsSync(join(stateDirectory!, '..'))).toBe(false);
});
