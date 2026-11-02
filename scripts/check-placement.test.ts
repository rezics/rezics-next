import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { onCheckHost, stackRun } from './stack-run.ts';
import { classifyCheck, environmentPrefixIsSafe, performanceHosts } from './check-placement.ts';
import { RemoteTransportError } from './remote-check.ts';
import { runWorkerCheck, workerCheckNeedsStack } from './worker-check.ts';

const repository = resolve(import.meta.dir, '..');
const temporary: string[] = [];

test('explicit host-local and host-absolute environment overrides are refused', () => {
  expect(environmentPrefixIsSafe(['env', 'KERNEL_CHECK_AFFECTED=abc123', 'bun', 'test'])).toBe(true);
  for (const setting of [
    'NODE=/usr/bin/node',
    'NVM_INC=/usr/include/node',
    'npm_config_prefix=/home/worker/.npm',
    'DEBUGINFOD_IMA_CERT_PATH=none',
    'UNKNOWN_PATH=/etc/host.conf',
  ])
    expect(environmentPrefixIsSafe(['env', setting, 'bun', 'test'])).toBe(false);
});

function fixture(): string {
  const parent = join(repository, '.temp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, `placement-${randomUUID()}-`));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: { typecheck: 'bun scripts/typecheck.ts', unit: 'bun test test/unit.test.ts', heavy: 'bun test' },
    }),
  );
  mkdirSync(join(root, 'packages/util/test'), { recursive: true });
  writeFileSync(join(root, 'packages/util/add.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  writeFileSync(
    join(root, 'packages/util/test/unit.test.ts'),
    "import { test, expect } from 'bun:test';\nimport { add } from '../add.ts';\ntest('adds', () => expect(add(1, 2)).toBe(3));\n",
  );
  writeFileSync(
    join(root, 'packages/util/package.json'),
    JSON.stringify({ scripts: { unit: 'bun test test/unit.test.ts' } }),
  );
  mkdirSync(join(root, 'apps/web'), { recursive: true });
  writeFileSync(
    join(root, 'apps/web/package.json'),
    JSON.stringify({
      scripts: {
        typecheck: 'bun run generate && bun run generate:routes && bun check --no-script -p tsconfig.json',
        generate: 'bun scripts/generate.ts',
        'generate:routes': 'bun scripts/generate-routes.ts',
      },
    }),
  );
  mkdirSync(join(root, 'services/kernel'), { recursive: true });
  writeFileSync(join(root, 'services/kernel/package.json'), JSON.stringify({ scripts: { check: 'bun test' } }));
  return root;
}

function host(name: string) {
  return {
    name,
    address: `root@${name}.example`,
    identity: `/keys/${name}`,
    memoryMaxGiB: 16,
    cpuQuotaPercent: 800,
    slots: 8,
  };
}

function hostsFile(root: string, names: string[]): string {
  const file = join(root, 'hosts.json');
  writeFileSync(file, JSON.stringify({ hosts: names.map(host) }));
  return file;
}

afterAll(() => {
  for (const root of temporary) rmSync(root, { recursive: true, force: true });
});

test('pure root and web typechecks, compiler tools, and explicit small unit selections stay local', () => {
  const root = fixture();
  const cases: string[][] = [
    ['bun', 'run', 'typecheck'],
    ['bun', '--cwd', 'apps/web', 'run', 'typecheck'],
    ['bun', 'run', '--cwd', 'apps/web', 'typecheck'],
    ['bun', 'check', '--no-script', '-p', 'packages/util/tsconfig.json'],
    ['bun', 'test', 'packages/util/test/unit.test.ts'],
    ['bun', 'run', '--cwd', 'packages/util', 'unit'],
    ['env', 'MODE=small', 'bun', 'run', '--cwd', 'packages/util', 'unit'],
  ];
  for (const argv of cases) expect(classifyCheck(argv, root).placement, argv.join(' ')).toBe('local');
  expect(
    classifyCheck(['env', 'PATH=/tmp/untrusted', 'bun', 'test', 'packages/util/test/unit.test.ts'], root).placement,
  ).toBe('remote');
  expect(workerCheckNeedsStack(['bun', 'test'], root)).toBe(true);
});

test('discovery, preload, shell, native-stack, browser, server, database, and unknown commands stay remote', () => {
  const root = fixture();
  const badTests: Array<[string, string]> = [
    ['discovery.test.ts', 'export const value = 1;\n'],
    ['browser.test.ts', "import { chromium } from 'playwright';\nvoid chromium;\n"],
    ['server.test.ts', "import { serve } from '../../services/kernel/server.ts';\nvoid serve;\n"],
    ['database.test.ts', "import pg from 'pg';\nvoid pg;\n"],
  ];
  for (const [name, source] of badTests) {
    const file = join(root, 'packages/util/test', name);
    writeFileSync(file, source);
    expect(classifyCheck(['bun', 'test', `packages/util/test/${name}`], root).placement, name).toBe('remote');
  }
  const suspiciousTests: Array<[string, string]> = [
    ['server-call.test.ts', 'Bun.serve({ fetch() { return new Response(); } });\n'],
    ['dynamic-import.test.ts', 'const dependency = "playwright"; await import(dependency);\n'],
    ['process-test.test.ts', "import { spawnSync } from 'node:child_process';\nvoid spawnSync;\n"],
  ];
  for (const [name, source] of suspiciousTests) {
    const file = join(root, 'packages/util/test', name);
    writeFileSync(file, source);
    expect(classifyCheck(['bun', 'test', `packages/util/test/${name}`], root).placement, name).toBe('remote');
  }
  expect(classifyCheck(['bun', 'test'], root).placement).toBe('remote');
  expect(
    classifyCheck(['bun', 'test', '--preload', 'test/setup.ts', 'packages/util/test/unit.test.ts'], root).placement,
  ).toBe('remote');
  expect(classifyCheck(['sh', '-c', 'bun test'], root).placement).toBe('remote');
  expect(classifyCheck(['bun', 'run', '--cwd', 'services/kernel', 'check', 'test/a.test.ts'], root).placement).toBe(
    'remote',
  );
  expect(classifyCheck(['bun', 'run', 'heavy'], root).placement).toBe('remote');
  const large = join(root, 'packages/util/test/large.test.ts');
  writeFileSync(large, `// ${'x'.repeat(256 * 1024)}\n`);
  expect(classifyCheck(['bun', 'test', 'packages/util/test/large.test.ts'], root).placement).toBe('remote');
});

test('caller markers cannot convert heavy placement to local, and only hosts a and b survive filtering', () => {
  const root = fixture();
  const saved = Object.fromEntries(
    ['KERNEL_CHECK_ON_REMOTE', 'REZICS_STACK_REMOTE', 'REZICS_STACK_SLOT', 'REZICS_CHECK_LOCAL_ONLY'].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.KERNEL_CHECK_ON_REMOTE = '1';
  process.env.REZICS_STACK_REMOTE = 'off';
  process.env.REZICS_STACK_SLOT = '1';
  process.env.REZICS_CHECK_LOCAL_ONLY = '1';
  try {
    expect(classifyCheck(['bun', 'test'], root).placement).toBe('remote');
    expect(workerCheckNeedsStack(['bun', 'test'], root)).toBe(true);
    expect(performanceHosts([host('c'), host('a'), host('b')]).map(({ name }) => name)).toEqual(['a', 'b']);
    expect(onCheckHost(root)).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('worker --local with only host c returns unavailable without executing the command', async () => {
  const parent = join(repository, '.temp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, `worker-placement-${randomUUID()}-`));
  temporary.push(root);
  const gitInit = Bun.spawnSync(['git', 'init', '--quiet', root], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  expect(gitInit.exitCode).toBe(0);
  const config = hostsFile(root, ['c']);
  const sentinel = join(root, 'local-command-ran');
  const saved = Object.fromEntries(
    [
      'KERNEL_CHECK_REMOTE',
      'KERNEL_CHECK_ON_REMOTE',
      'REZICS_STACK_REMOTE',
      'REZICS_STACK_SLOT',
      'REZICS_CHECK_LOCAL_ONLY',
      'REZICS_CHECK_MEMORY',
      'REZICS_CHECK_MEMORY_LEASE',
      'GOAL_TASK_ID',
      'GOAL_ATTEMPT',
      'GOAL_CHECK_WAIT_FILE',
      'GOAL_CHECK_REGISTRY',
    ].map((key) => [key, process.env[key]]),
  );
  process.env.KERNEL_CHECK_REMOTE = config;
  process.env.KERNEL_CHECK_ON_REMOTE = '1';
  process.env.REZICS_STACK_REMOTE = 'off';
  process.env.REZICS_STACK_SLOT = '1';
  process.env.REZICS_CHECK_LOCAL_ONLY = '1';
  process.env.REZICS_CHECK_MEMORY = 'off';
  process.env.REZICS_CHECK_MEMORY_LEASE = '1';
  delete process.env.GOAL_TASK_ID;
  delete process.env.GOAL_ATTEMPT;
  delete process.env.GOAL_CHECK_WAIT_FILE;
  delete process.env.GOAL_CHECK_REGISTRY;
  try {
    const code = await runWorkerCheck(
      ['--local', 'bun', '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`],
      root,
      false,
      join(root, 'check.log'),
    );
    expect(code).toBe(75);
    expect(await Bun.file(sentinel).exists()).toBe(false);
    delete process.env.KERNEL_CHECK_REMOTE;
    const absentHostsCode = await runWorkerCheck(
      ['bun', '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`],
      root,
      false,
      join(root, 'check-no-hosts.log'),
    );
    expect(absentHostsCode).toBe(75);
    expect(await Bun.file(sentinel).exists()).toBe(false);

    const approvedHosts = hostsFile(root, ['a', 'b', 'c']);
    process.env.KERNEL_CHECK_REMOTE = approvedHosts;
    const fake = new EventEmitter() as EventEmitter & {
      stdio: [null, PassThrough, PassThrough, PassThrough];
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
      pid: number;
    };
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const receipt = new PassThrough();
    fake.stdio = [null, stdout, stderr, receipt];
    fake.stdout = stdout;
    fake.stderr = stderr;
    fake.kill = () => true;
    fake.pid = 1;
    const transportFailureCode = await runWorkerCheck(
      ['--local', 'bun', '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`],
      root,
      false,
      join(root, 'check-transport.log'),
      60_000,
      undefined,
      0,
      undefined,
      true,
      randomUUID(),
      async (_start) => {
        setTimeout(() => {
          stderr.write('remote-check: transport failure marker\n');
          fake.emit('close', 75, null);
          stdout.end();
          stderr.end();
          receipt.end();
        }, 0);
        return fake as unknown as ReturnType<typeof spawn>;
      },
    );
    expect(transportFailureCode).toBe(75);
    expect(await Bun.file(sentinel).exists()).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('stack-heavy work never calls its local callback with absent hosts, c-only hosts, local flags, or transport loss', async () => {
  const root = fixture();
  const run = { label: 'heavy test', root, cwd: root, command: ['bun', 'test'] };
  let localStarts = 0;
  const local = async () => {
    localStarts += 1;
    return 0;
  };
  const missingHosts = join(root, 'missing-hosts.json');
  expect(
    await stackRun(run, local, { KERNEL_CHECK_REMOTE: missingHosts, REZICS_STACK_REMOTE: 'off' }, async () => 0),
  ).toBe(75);

  const cOnly = hostsFile(root, ['c']);
  expect(await stackRun(run, local, { KERNEL_CHECK_REMOTE: cOnly }, async () => 0)).toBe(75);

  let selected: string[] = [];
  const exitCode = await stackRun(
    run,
    local,
    {
      KERNEL_CHECK_REMOTE: hostsFile(root, ['a', 'b', 'c']),
      REZICS_STACK_REMOTE: 'off',
      REZICS_STACK_SLOT: '1',
      REZICS_CHECK_LOCAL_ONLY: '1',
      REZICS_CHECK_MEMORY: 'off',
      GOAL_TASK_ID: 'worker',
    },
    async (options) => {
      selected = options.hosts.map(({ name }) => name);
      throw new RemoteTransportError('a', 'control probe', 75, false);
    },
  );
  expect(exitCode).toBe(75);
  expect(selected).toEqual(['a', 'b']);
  expect(localStarts).toBe(0);
});

test('the fixed held-child operation retains ordinary remote placement and grants no eval or local bypass', async () => {
  const { encodeLifecycleSpec, LIFECYCLE_CHILD } = await import('./check-lifecycle-child.ts');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'rezics-placement-lifecycle-'));
  try {
    const encoded = encodeLifecycleSpec({
      version: 1,
      checkId: randomUUID(),
      taskId: randomUUID(),
      attempt: 1,
      sourceCommit: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      nonce: 'c'.repeat(64),
      exitCode: 0,
      lifetimeMs: 1_000,
      runtime: { packageManager: 'bun@fixture', version: Bun.version, revision: Bun.revision },
      childSha256: 'd'.repeat(64),
    });
    const argv = ['bun', LIFECYCLE_CHILD, '--probe', encoded];
    expect(classifyCheck(argv, root)).toEqual({ placement: 'remote', reason: 'bounded held-child lifecycle probe' });
    expect(workerCheckNeedsStack(argv, root)).toBe(true);
    expect(classifyCheck(['bun', '-e', 'process.exit(0)'], root).placement).toBe('remote');
    expect(classifyCheck([...argv, '--local'], root).placement).toBe('remote');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
