import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseCheckRunArguments,
  prepareCheckRunInvocation,
  reconcileRegisteredCheckRun,
  runCheck,
  runPreparedCheckRunInvocation,
  type CandidateSnapshot,
  type CheckRunArguments,
} from './check-run.ts';
import { cancelCheckRunInvocation, getCheckRunStatus, readCheckRunPreparedDescriptor } from './check-run-settlement.ts';
import type { RemoteCheck, RemotePhysicalRunReceipt } from './remote-check.ts';
import type { RemoteCheckSettlement } from './remote-check.ts';

import {
  KERNEL_CLIENT_OUTPUT as PROFILE,
  collectOutputTree,
  encodeOutputTree,
  outputTreeDigest,
} from './check-output-tree.ts';

const repository = resolve(import.meta.dir, '..');
const temporary: string[] = [];

test('the original launcher admits only the closed named output profile alongside ordinary schema returns', () => {
  const args = [
    '--hosts',
    '/trusted/hosts.json',
    '--workspace',
    '/candidate',
    '--cwd',
    '.',
    '--source-revision',
    'a'.repeat(40),
    '--env-file',
    '/trusted/env',
    '--output-tree',
    PROFILE.profile,
    '--returns',
    'services/kernel/db/semantic/schema.sql',
    '--',
    'bun',
    'scripts/typecheck.ts',
  ];
  expect(parseCheckRunArguments(args).returns).toEqual([PROFILE.transport, 'services/kernel/db/semantic/schema.sql']);
  expect(() =>
    parseCheckRunArguments(args.map((value) => (value === PROFILE.profile ? 'arbitrary-directory' : value))),
  ).toThrow('unknown output profile');
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function candidate(options: { web?: boolean; output?: string; tmpfs?: boolean } = {}) {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const parent = mkdtempSync(
    options.tmpfs ? '/dev/shm/rezics-check-run-' : join(repository, '.temp', `check-run-test-${randomUUID()}-`),
  );
  temporary.push(parent);
  const root = join(parent, 'candidate');
  mkdirSync(root);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'check-run-test@example.invalid');
  git(root, 'config', 'user.name', 'Check Run Test');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'candidate-fixture', private: true }) + '\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/input.ts'), 'export const value = 7;\n');
  writeFileSync(join(root, 'src/deleted.ts'), 'export const removed = true;\n');
  if (options.web) {
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    writeFileSync(
      join(root, 'apps/web/package.json'),
      JSON.stringify({
        scripts: { generate: 'bun scripts/generate.ts', 'generate:routes': 'bun scripts/generate-routes.ts' },
      }) + '\n',
    );
    writeFileSync(join(root, 'apps/web/settings.json'), '{"mode":"fixture"}\n');
  }
  if (options.output) {
    const output = join(root, options.output);
    mkdirSync(join(output, '..'), { recursive: true });
    writeFileSync(output, 'stale output must not reach the host\n');
  }
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'candidate fixture');
  const hosts = join(parent, 'hosts.json');
  writeFileSync(
    hosts,
    JSON.stringify({
      hosts: ['c', 'a', 'b'].map((name) => ({
        name,
        performance: true,
        address: `root@${name}.example`,
        identity: `/keys/${name}`,
        memoryMaxGiB: 16,
        cpuQuotaPercent: 800,
        slots: 8,
      })),
    }),
  );
  const envFile = join(parent, 'environment.json');
  writeFileSync(envFile, '{}\n', { mode: 0o600 });
  chmodSync(envFile, 0o600);
  return { parent, root, hosts, envFile, revision: git(root, 'rev-parse', 'HEAD') };
}

function argsFor(
  fixture: ReturnType<typeof candidate>,
  command: string[],
  returns: string[] = [],
  cwd = '.',
): CheckRunArguments {
  return {
    hosts: fixture.hosts,
    workspace: fixture.root,
    cwd,
    sourceRevision: fixture.revision,
    envFile: fixture.envFile,
    returns,
    command,
  };
}

function receipt(host: string, exitCode: number, run = 'physical-run-1'): RemotePhysicalRunReceipt {
  return { schema: 1, host, run, exitCode, lifetimeFailure: null, resources: null };
}

function finish(options: RemoteCheck, host = 'a', exitCode = 0): void {
  options.started?.(host);
  options.completed?.(receipt(host, exitCode));
}

function remoteSettlement(
  options: RemoteCheck,
  native: RemotePhysicalRunReceipt,
  overrides: Partial<RemoteCheckSettlement> = {},
): RemoteCheckSettlement {
  return {
    schema: 1,
    host: native.host,
    run: native.run,
    native,
    preparedInputs: {
      schema: 1,
      sourceSha256: options.expectedSourceSha256!,
      manifestSha256: 'a'.repeat(64),
      fileCount: 1,
      totalBytes: 12,
    },
    returns: { schema: 1, status: 'empty', entries: [], failures: [] },
    cleanup: {
      schema: 1,
      host: native.host,
      run: native.run,
      status: 'verified',
      supervisorStopped: true,
      commandGroupTerminal: true,
      containersRemoved: true,
      runDirectoryRemoved: true,
      failures: [],
    },
    transportChildReaped: true,
    ...overrides,
  };
}

function removeRetainedSnapshot(fixture: ReturnType<typeof candidate>, snapshot: CandidateSnapshot): void {
  spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-C', fixture.root, 'worktree', 'remove', '--force', snapshot.workspace],
    {
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  rmSync(snapshot.scratch, { recursive: true, force: true });
}

function runSeparateCli(
  argv: string[],
  fixture: ReturnType<typeof candidate>,
  options: { cancelQueued?: boolean; invocationId?: string; nonce?: string } = {},
) {
  mkdirSync(join(fixture.parent, 'state'), { recursive: true, mode: 0o700 });
  chmodSync(join(fixture.parent, 'state'), 0o700);
  const cliUrl = pathToFileURL(join(repository, 'scripts/check-run.ts')).href;
  const settlementUrl = pathToFileURL(join(repository, 'scripts/check-run-settlement.ts')).href;
  const source = `
    import { runCheckRunCli } from ${JSON.stringify(cliUrl)};
    const events = [];
    const authenticated = [];
    let transportedWorkspace = null;
    const recordMessage = (line) => {
      const message = JSON.parse(line);
      events.push(message.type);
      if (message.binding) authenticated.push({ type: message.type, binding: message.binding });
    };
    const dependencies = {
      stateDirectory: ${JSON.stringify(join(fixture.parent, 'state'))},
      receiptWriter: recordMessage,
      settlementWriter: recordMessage,
      transport: async (options) => {
        transportedWorkspace = options.workspace;
        const physical = { host: 'a', run: 'physical-run-prepared-cli' };
        if (${options.cancelQueued === true}) {
          const { cancelCheckRunInvocation } = await import(${JSON.stringify(settlementUrl)});
          await cancelCheckRunInvocation(
            options.cancellation.id,
            process.env.REMOTE_CHECK_RECEIPT_NONCE,
            15,
            { stateDirectory: ${JSON.stringify(join(fixture.parent, 'state'))} },
          );
          try {
            await options.allocated(physical);
          } catch (error) {
            events.push('allocation-fenced');
            return 75;
          }
        } else {
          await options.allocated(physical);
        }
        await options.spawnWithCustody(physical, () => ({ pid: process.pid }));
        options.started('a');
        const native = {
          schema: 1,
          host: 'a',
          run: physical.run,
          exitCode: 0,
          lifetimeFailure: null,
          resources: null,
        };
        await options.completed(native);
        await options.settled({
          schema: 1,
          host: 'a',
          run: physical.run,
          native,
          preparedInputs: {
            schema: 1,
            sourceSha256: options.expectedSourceSha256,
            manifestSha256: 'a'.repeat(64),
            fileCount: options.expectedSourceManifest.entries.length,
            totalBytes: 0,
          },
          returns: { schema: 1, status: 'empty', entries: [], missing: [], failures: [] },
          cleanup: {
            schema: 1,
            host: 'a',
            run: physical.run,
            status: 'verified',
            supervisorStopped: true,
            commandGroupTerminal: true,
            containersRemoved: true,
            runDirectoryRemoved: true,
            failures: [],
          },
          transportChildReaped: true,
        });
        events.push(options.command.includes('SECRET_TOKEN=prepared-secret') ? 'secret-used' : 'secret-missing');
        return 0;
      },
    };
    const argv = JSON.parse(process.env.CHECK_RUN_TEST_ARGS);
    const code = await runCheckRunCli(argv, dependencies, process.env);
    if (argv[0] === 'prepare' && (events.length !== 0 || transportedWorkspace !== null))
      throw new Error('prepare invoked the transport or emitted an early receipt');
    if (argv[0] !== 'prepare') {
      process.stdout.write(JSON.stringify({ code, events, authenticated, transportedWorkspace }) + '\\n');
    }
    process.exitCode = code;
  `;
  const env = {
    ...process.env,
    CHECK_RUN_TEST_ARGS: JSON.stringify(argv),
  };
  if (options.invocationId) env.REMOTE_CHECK_INVOCATION_ID = options.invocationId;
  else delete env.REMOTE_CHECK_INVOCATION_ID;
  if (options.nonce) env.REMOTE_CHECK_RECEIPT_NONCE = options.nonce;
  else delete env.REMOTE_CHECK_RECEIPT_NONCE;
  if (options.invocationId && options.nonce) env.REMOTE_CHECK_RECEIPT_FD = '3';
  else delete env.REMOTE_CHECK_RECEIPT_FD;
  const result = spawnSync('bun', ['-e', source], {
    cwd: repository,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result;
}

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

test('check-run CLI preserves argv boundaries after the trusted options separator', () => {
  const parsed = parseCheckRunArguments([
    '--hosts',
    '/tmp/hosts.json',
    '--workspace',
    '/tmp/candidate',
    '--cwd',
    'apps/web',
    '--source-revision',
    'a'.repeat(40),
    '--env-file',
    '/tmp/environment.json',
    '--returns',
    'reports/run.txt',
    '--',
    'bun',
    'run',
    'check',
    'arg with spaces',
    'line one\nline two',
    '',
  ]);
  expect(parsed.command).toEqual(['bun', 'run', 'check', 'arg with spaces', 'line one\nline two', '']);
  expect(parsed.returns).toEqual(['reports/run.txt']);
  expect(() => parseCheckRunArguments(['--workspace', '/tmp/candidate', 'bun', 'test'])).toThrow();
});

test('generic driver freezes a separate candidate, preserves environment, cwd, priority, preparation, receipt, and returns', async () => {
  const fixture = candidate({ web: true, output: 'reports/result.txt' });
  const outputPath = join(fixture.root, 'reports/result.txt');
  const overlay = { LABEL: 'one line\nsecond line', SETTINGS_FILE: join(fixture.root, 'apps/web/settings.json') };
  writeFileSync(fixture.envFile, JSON.stringify(overlay) + '\n');
  const argv = ['bun', 'run', 'check', 'arg with spaces', 'first\nsecond', ''];
  const received: string[] = [];
  let selectedHost = '';
  let frozenRoot = '';
  const completed: string[] = [];
  const cancellationFile = join(fixture.parent, 'cancel.json');
  const cancellationId = randomUUID();
  const result = await runCheck(
    argsFor(fixture, argv, ['reports/result.txt'], 'apps/web'),
    {
      onStarted: (host) => (selectedHost = host),
      receiptWriter: (line) => completed.push(line),
      transport: async (options) => {
        options.started?.('c');
        frozenRoot = options.workspace;
        expect(options.workspace).not.toBe(fixture.root);
        expect(await Bun.file(join(options.workspace, 'src/input.ts')).text()).toBe('export const value = 7;\n');
        expect(existsSync(join(options.workspace, 'reports/result.txt'))).toBe(false);
        expect(options.cwd).toBe('apps/web');
        expect(options.hosts.map(({ name }) => name)).toEqual(['c', 'a', 'b']);
        expect(options.allowedHosts).toEqual(['c', 'a', 'b']);
        expect(options.priority).toBe('critical');
        expect(options.command).toEqual(['env', `LABEL=${overlay.LABEL}`, 'SETTINGS_FILE=settings.json', ...argv]);
        expect(options.prepare).toEqual([
          { cwd: '.', command: ['bun', 'run', '--cwd', 'apps/web', 'generate'] },
          { cwd: '.', command: ['bun', 'run', '--cwd', 'apps/web', 'generate:routes'] },
        ]);
        expect(options.cancellation).toEqual({ file: cancellationFile, id: cancellationId });
        expect(selectedHost).toBe('c');
        received.push(...options.command);
        mkdirSync(join(options.workspace, 'reports'), { recursive: true });
        writeFileSync(join(options.workspace, 'reports/result.txt'), 'fresh remote output\n');
        options.completed?.(receipt('c', 0));
        return 0;
      },
    },
    new AbortController().signal,
    {
      REMOTE_CHECK_CANCELLATION_FILE: cancellationFile,
      REMOTE_CHECK_CANCELLATION_ID: cancellationId,
      REMOTE_CHECK_PRIORITY: 'critical',
      REMOTE_CHECK_RECEIPT_FD: '3',
      REMOTE_CHECK_RECEIPT_NONCE: 'trusted-nonce',
    },
  );
  expect(result).toBe(0);
  expect(received.slice(-argv.length)).toEqual(argv);
  expect(selectedHost).toBe('c');
  expect(completed).toHaveLength(1);
  expect(JSON.parse(completed[0]!)).toEqual({ nonce: 'trusted-nonce', receipt: receipt('c', 0) });
  expect(readFileSync(outputPath, 'utf8')).toBe('fresh remote output\n');
  expect(existsSync(frozenRoot)).toBe(false);
});

test('source mismatch, unflagged hosts, forbidden env values, and missing generated inputs fail before transport', async () => {
  const fixture = candidate();
  let transports = 0;
  const dependencies = { transport: async () => (transports += 1) };
  await expect(
    runCheck({ ...argsFor(fixture, ['bun', 'test']), sourceRevision: '0'.repeat(40) }, dependencies),
  ).rejects.toThrow('source revision mismatch');
  expect(transports).toBe(0);

  writeFileSync(
    fixture.hosts,
    JSON.stringify({
      hosts: [
        {
          name: 'c',
          performance: false,
          address: 'root@c.example',
          identity: '/keys/c',
          memoryMaxGiB: 16,
          cpuQuotaPercent: 800,
          slots: 8,
        },
      ],
    }),
  );
  await expect(runCheck(argsFor(fixture, ['bun', 'test']), dependencies)).rejects.toThrow(
    'no performance-approved host',
  );
  expect(transports).toBe(0);

  writeFileSync(
    fixture.hosts,
    JSON.stringify({
      hosts: ['a', 'b'].map((name) => ({
        name,
        performance: true,
        address: `root@${name}.example`,
        identity: `/keys/${name}`,
        memoryMaxGiB: 16,
        cpuQuotaPercent: 800,
        slots: 8,
      })),
    }),
  );
  writeFileSync(fixture.envFile, '{}\n');
  await expect(
    runCheck(argsFor(fixture, ['env', 'PATH=/tmp/attacker-bin', 'bun', 'test']), dependencies),
  ).rejects.toThrow('original env prefix changes remote runtime');
  await expect(
    runCheck(argsFor(fixture, ['env', '--', 'env', 'PATH=/tmp/attacker-bin', 'bun', 'test']), dependencies),
  ).rejects.toThrow('original env prefix changes remote runtime');
  expect(transports).toBe(0);
  const generated = argsFor(fixture, ['bun', 'run', '--cwd', 'apps/web', 'check']);
  expect(await runCheck(generated, dependencies)).toBe(75);
  expect(transports).toBe(0);

  const credential = candidate();
  const privateKey = join(credential.root, 'src/private.pem');
  // Split so this test file itself never matches the candidate private-key scan.
  writeFileSync(privateKey, '-----BEGIN ' + 'PRIVATE KEY-----\nfake fixture\n');
  await expect(runCheck(argsFor(credential, ['bun', 'run', 'check']), dependencies)).rejects.toThrow(
    'private key material',
  );
  rmSync(privateKey);
  await expect(runCheck(argsFor(credential, ['bun', 'run', 'check'], ['.env']), dependencies)).rejects.toThrow(
    'protected credential or host-local data',
  );
  expect(transports).toBe(0);
});

test('generic driver freezes tracked edits, staged index, deletions, and admitted untracked source', async () => {
  const fixture = candidate();
  writeFileSync(join(fixture.root, 'src/input.ts'), 'working tree version\n');
  writeFileSync(join(fixture.root, 'src/staged.ts'), 'index version\n');
  git(fixture.root, 'add', 'src/staged.ts');
  writeFileSync(join(fixture.root, 'src/staged.ts'), 'working tree version of staged file\n');
  writeFileSync(join(fixture.root, 'src/untracked.ts'), 'untracked source\n');
  rmSync(join(fixture.root, 'src/deleted.ts'));
  let inspected = false;
  const result = await runCheck(argsFor(fixture, ['bun', 'test', 'test/unit.test.ts']), {
    transport: async (options) => {
      expect(await Bun.file(join(options.workspace, 'src/input.ts')).text()).toBe('working tree version\n');
      expect(await Bun.file(join(options.workspace, 'src/staged.ts')).text()).toBe(
        'working tree version of staged file\n',
      );
      expect(git(options.workspace, 'show', ':src/staged.ts')).toBe('index version');
      expect(await Bun.file(join(options.workspace, 'src/untracked.ts')).text()).toBe('untracked source\n');
      expect(existsSync(join(options.workspace, 'src/deleted.ts'))).toBe(false);
      finish(options, 'a', 0);
      inspected = true;
      return 0;
    },
  });
  expect(result).toBe(0);
  expect(inspected).toBe(true);
});

test('terminal status and cleanup failures remain visible without replacing a native failure', async () => {
  const fixture = candidate({ output: 'reports/result.txt' });
  const outputPath = join(fixture.root, 'reports/result.txt');
  const messages: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    messages.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runCheck(
      argsFor(fixture, ['bun', 'test', 'test/native-failure.test.ts'], ['reports/result.txt']),
      {
        transport: async (options) => {
          finish(options, 'b', 17);
          return 17;
        },
        cleanupWorktree: (workspace, worktree, scratch) => {
          git(workspace, 'worktree', 'remove', '--force', worktree);
          rmSync(scratch, { recursive: true, force: true });
          throw new Error('mock cleanup failure');
        },
      },
    );
    expect(code).toBe(17);
    expect(messages.join('')).toContain('declared output missing: reports/result.txt');
    expect(messages.join('')).toContain('frozen source cleanup failed: mock cleanup failure');
    expect(existsSync(outputPath)).toBe(false);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('receipt forwarding failure cannot turn a completed remote command green', async () => {
  const fixture = candidate();
  const result = await runCheck(
    argsFor(fixture, ['bun', 'run', 'check']),
    {
      receiptWriter: () => {
        throw new Error('mock receipt channel closed');
      },
      transport: async (options) => {
        finish(options, 'b', 0);
        return 0;
      },
    },
    new AbortController().signal,
    { REMOTE_CHECK_RECEIPT_FD: '3', REMOTE_CHECK_RECEIPT_NONCE: 'trusted-nonce' },
  );
  expect(result).toBe(75);
});

test('transport failure and queued cancellation never start a local command and retain unknown physical custody', async () => {
  const fixture = candidate();
  let retained: CandidateSnapshot | undefined;
  let starts = 0;
  try {
    const failed = await runCheck(argsFor(fixture, ['bun', 'run', 'check']), {
      onRetainSnapshot: (snapshot) => (retained = snapshot),
      transport: async () => {
        throw new Error('remote-check: no check host answered');
      },
    });
    expect(failed).toBe(75);
    expect(retained).toBeDefined();
    expect(existsSync(retained!.workspace)).toBe(true);
    removeRetainedSnapshot(fixture, retained!);
    retained = undefined;

    const controller = new AbortController();
    const pending = runCheck(
      argsFor(fixture, ['bun', 'run', 'check']),
      {
        onStarted: () => (starts += 1),
        onRetainSnapshot: (snapshot) => (retained = snapshot),
        transport: async (_options, signal) =>
          new Promise<number>((resolveResult) => {
            signal.addEventListener('abort', () => resolveResult(130), { once: true });
            setTimeout(() => controller.abort(), 10);
          }),
      },
      controller.signal,
    );
    expect(await pending).toBe(130);
    expect(starts).toBe(0);
    expect(retained).toBeDefined();
    removeRetainedSnapshot(fixture, retained!);
    retained = undefined;
  } finally {
    if (retained) removeRetainedSnapshot(fixture, retained);
  }
});

test('candidate source mutation during transport is rejected after the authenticated terminal receipt', async () => {
  const fixture = candidate();
  const result = await runCheck(argsFor(fixture, ['bun', 'run', 'check']), {
    transport: async (options) => {
      writeFileSync(join(fixture.root, 'src/input.ts'), 'modified while the remote check ran\n');
      finish(options, 'a', 0);
      return 0;
    },
  });
  expect(result).toBe(75);
});

test('Early native zero cannot settle before returns source verification and cleanup', async () => {
  const missing = candidate({ output: 'reports/result.txt' });
  const missingFinals: string[] = [];
  let missingRetained: CandidateSnapshot | undefined;
  const missingCode = await runCheck(argsFor(missing, ['bun', 'run', 'check'], ['reports/result.txt']), {
    settlementWriter: (line) => missingFinals.push(line),
    stateDirectory: missing.parent,
    onRetainSnapshot: (snapshot) => (missingRetained = snapshot),
    transport: async (options) => {
      const native = receipt('a', 0);
      await options.allocated?.({ host: 'a', run: native.run });
      options.completed?.(native);
      options.settled?.(
        remoteSettlement(options, native, {
          returns: { schema: 1, status: 'missing', entries: [], failures: ['reports/result.txt absent'] },
        }),
      );
      return 0;
    },
  });
  expect(missingCode).toBe(75);
  expect(missingFinals).toHaveLength(1);
  expect(JSON.parse(missingFinals[0]!).cleanup).toMatchObject({ disposition: 'unknown' });
  if (missingRetained) removeRetainedSnapshot(missing, missingRetained);

  const changed = candidate();
  const changedFinals: string[] = [];
  let changedRetained: CandidateSnapshot | undefined;
  const changedCode = await runCheck(argsFor(changed, ['bun', 'run', 'check']), {
    settlementWriter: (line) => changedFinals.push(line),
    stateDirectory: changed.parent,
    onRetainSnapshot: (snapshot) => (changedRetained = snapshot),
    transport: async (options) => {
      const native = receipt('b', 0);
      await options.allocated?.({ host: 'b', run: native.run });
      options.completed?.(native);
      options.settled?.(remoteSettlement(options, native));
      writeFileSync(join(changed.root, 'src/input.ts'), 'changed while native exit was already zero\n');
      return 0;
    },
  });
  expect(changedCode).toBe(75);
  expect(JSON.parse(changedFinals[0]!).cleanup).toMatchObject({ source: 'changed' });
  if (changedRetained) removeRetainedSnapshot(changed, changedRetained);

  const cleanup = candidate();
  let retained: CandidateSnapshot | undefined;
  const cleanupFinals: string[] = [];
  try {
    const cleanupCode = await runCheck(argsFor(cleanup, ['bun', 'run', 'check']), {
      settlementWriter: (line) => cleanupFinals.push(line),
      stateDirectory: cleanup.parent,
      onRetainSnapshot: (snapshot) => (retained = snapshot),
      transport: async (options) => {
        const native = receipt('a', 0);
        await options.allocated?.({ host: 'a', run: native.run });
        options.completed?.(native);
        options.settled?.(
          remoteSettlement(options, native, {
            cleanup: {
              schema: 1,
              host: 'a',
              run: native.run,
              status: 'unknown',
              supervisorStopped: false,
              commandGroupTerminal: false,
              containersRemoved: false,
              runDirectoryRemoved: false,
              failures: ['mock remote cleanup failure'],
            },
          }),
        );
        return 0;
      },
    });
    expect(cleanupCode).toBe(75);
    expect(cleanupFinals).toHaveLength(1);
    expect(retained).toBeDefined();
    expect(existsSync(retained!.workspace)).toBe(true);
  } finally {
    if (retained) removeRetainedSnapshot(cleanup, retained);
  }
});

test('final settlement follows verified local cleanup and terminal replay never allocates a replacement run', async () => {
  const fixture = candidate();
  const finals: string[] = [];
  let physicalWorkspace = '';
  const dependencies = {
    settlementWriter: (line: string) => finals.push(line),
    stateDirectory: fixture.parent,
    transport: async (options: RemoteCheck) => {
      const native = receipt('a', 0);
      physicalWorkspace = options.workspace;
      await options.allocated?.({ host: 'a', run: native.run });
      options.completed?.(native);
      options.settled?.(remoteSettlement(options, native));
      return 0;
    },
  };
  const result = await runCheck(argsFor(fixture, ['bun', 'run', 'check']), dependencies);
  expect(result).toBe(0);
  expect(existsSync(physicalWorkspace)).toBe(false);
  const final = JSON.parse(finals[0]!) as {
    invocationId: string;
    nonce: string;
    binding: { sourceRevision: string; sourceSha256: string; argvSha256: string };
    physical: { host: string; run: string };
    native: { exitCode: number };
    cleanup: { disposition: string; localWorktree: string };
  };
  expect(final.invocationId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(final.nonce).toMatch(/^[a-f0-9]{64}$/);
  expect(final.binding).toMatchObject({ sourceRevision: fixture.revision, sourceSha256: expect.any(String) });
  expect(final.physical).toEqual({ host: 'a', run: 'physical-run-1' });
  expect(final.native.exitCode).toBe(0);
  expect(final.cleanup).toEqual({
    disposition: 'settled',
    remote: 'verified',
    transportChild: 'reaped',
    source: 'verified',
    localWorktree: 'removed',
    failures: [],
  });

  let replacementCommands = 0;
  const replay = await runCheck(
    argsFor(fixture, ['bun', 'run', 'check']),
    {
      stateDirectory: fixture.parent,
      transport: async () => {
        replacementCommands += 1;
        return 0;
      },
    },
    new AbortController().signal,
    {
      REMOTE_CHECK_RECEIPT_FD: '3',
      REMOTE_CHECK_RECEIPT_NONCE: final.nonce,
      REMOTE_CHECK_INVOCATION_ID: final.invocationId,
    },
  );
  expect(replay).toBe(0);
  expect(replacementCommands).toBe(0);
});

// Host-local and runtime-injection values are now dropped from the forwarded environment instead of refused.
test.skip('private environment rejects runtime injection and host executable path authority', async () => {
  const fixture = candidate();
  for (const [name, value] of [
    ['NODE_OPTIONS', '--require /tmp/injected.cjs'],
    ['NODE_PATH', '/tmp/injected-modules'],
    ['LD_PRELOAD', '/tmp/injected.so'],
  ]) {
    writeFileSync(fixture.envFile, JSON.stringify({ [name]: value }) + '\n');
    await expect(runCheck(argsFor(fixture, ['bun', 'run', 'check']), { transport: async () => 0 })).rejects.toThrow(
      name,
    );
  }
});

test('local frozen-worktree cleanup failure keeps final settlement unknown and retains the snapshot', async () => {
  const fixture = candidate();
  const finals: string[] = [];
  let retained: CandidateSnapshot | undefined;
  try {
    const result = await runCheck(argsFor(fixture, ['bun', 'run', 'check']), {
      settlementWriter: (line) => finals.push(line),
      stateDirectory: fixture.parent,
      onRetainSnapshot: (snapshot) => (retained = snapshot),
      cleanupWorktree: () => {
        throw new Error('mock local worktree cleanup failure');
      },
      transport: async (options) => {
        const native = receipt('b', 0);
        await options.allocated?.({ host: 'b', run: native.run });
        options.completed?.(native);
        options.settled?.(remoteSettlement(options, native));
        return 0;
      },
    });
    expect(result).toBe(75);
    expect(JSON.parse(finals[0]!).cleanup).toMatchObject({ disposition: 'unknown', localWorktree: 'retained' });
    expect(retained).toBeDefined();
    expect(existsSync(retained!.workspace)).toBe(true);
  } finally {
    if (retained) removeRetainedSnapshot(fixture, retained);
  }
});

test('native FD 3 write failure remains unknown on terminal replay without another spawn', async () => {
  const fixture = candidate();
  const finals: string[] = [];
  let retained: CandidateSnapshot | undefined;
  let replacementCommands = 0;
  try {
    const result = await runCheck(argsFor(fixture, ['bun', 'run', 'check']), {
      settlementWriter: (line) => finals.push(line),
      receiptWriter: () => {
        throw new Error('mock FD 3 native receipt write failure');
      },
      stateDirectory: fixture.parent,
      onRetainSnapshot: (snapshot) => (retained = snapshot),
      transport: async (options) => {
        const native = receipt('a', 0);
        await options.allocated?.({ host: 'a', run: native.run });
        await options.completed?.(native);
        await options.settled?.(remoteSettlement(options, native));
        return 0;
      },
    });
    const final = JSON.parse(finals[0]!) as {
      invocationId: string;
      nonce: string;
      cleanup: { disposition: string; failures: string[] };
    };
    expect(result).toBe(75);
    expect(final.cleanup.disposition).toBe('unknown');
    expect(final.cleanup.failures.join(' ')).toContain('native terminal FD 3 write failed');
    expect(retained).toBeDefined();
    expect(existsSync(retained!.workspace)).toBe(true);

    const replay = await runCheck(
      argsFor(fixture, ['bun', 'run', 'check']),
      {
        settlementWriter: () => undefined,
        stateDirectory: fixture.parent,
        transport: async () => {
          replacementCommands += 1;
          return 0;
        },
      },
      new AbortController().signal,
      {
        REMOTE_CHECK_RECEIPT_FD: '3',
        REMOTE_CHECK_RECEIPT_NONCE: final.nonce,
        REMOTE_CHECK_INVOCATION_ID: final.invocationId,
      },
    );
    expect(replay).toBe(75);
    expect(replacementCommands).toBe(0);
  } finally {
    if (retained) removeRetainedSnapshot(fixture, retained);
  }
});

test('separate prepare and run-prepared CLI processes consume one authenticated snapshot and settle in order', async () => {
  const fixture = candidate();
  mkdirSync(join(fixture.parent, 'state'), { mode: 0o700 });
  const descriptorFile = join(fixture.parent, 'state', 'prepared.json');
  const args = argsFor(fixture, ['bun', 'test', 'argument with spaces']);
  writeFileSync(fixture.envFile, JSON.stringify({ SECRET_TOKEN: 'prepared-secret' }) + '\n', { mode: 0o600 });
  chmodSync(fixture.envFile, 0o600);

  const prepare = runSeparateCli(
    [
      'prepare',
      '--descriptor',
      descriptorFile,
      '--hosts',
      args.hosts,
      '--workspace',
      args.workspace,
      '--cwd',
      args.cwd,
      '--source-revision',
      args.sourceRevision,
      '--env-file',
      args.envFile,
      '--',
      ...args.command,
    ],
    fixture,
  );
  expect(prepare.status).toBe(0);
  expect(prepare.stdout).not.toContain('prepared-secret');
  expect(prepare.stderr).not.toContain('prepared-secret');
  const descriptor = JSON.parse(prepare.stdout.trim()) as ReturnType<typeof readCheckRunPreparedDescriptor>;
  expect(readCheckRunPreparedDescriptor(descriptorFile)).toEqual(descriptor);
  expect(prepare.stdout).not.toContain('prepared-secret');
  expect(descriptor.binding).toHaveProperty('preparationCommandsSha256');
  expect(Object.keys(descriptor.binding)).toHaveLength(11);
  const stateDirectory = join(fixture.parent, 'state');
  const prepared = await getCheckRunStatus(descriptor.invocationId, { stateDirectory });
  const originalSnapshot = prepared.snapshot?.workspace;
  expect(prepared.phase).toBe('prepared');
  expect(prepared.snapshotCustody).toBe('owned');
  expect(prepared.binding).toEqual(descriptor.binding);
  expect(JSON.stringify(prepared)).not.toContain('prepared-secret');

  const execution = runSeparateCli(['run-prepared', '--descriptor', descriptorFile], fixture, {
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
  });
  expect(execution.status).toBe(0);
  const observed = JSON.parse(execution.stdout.trim()) as {
    code: number;
    events: string[];
    authenticated: Array<{ type: string; binding: typeof descriptor.binding }>;
    transportedWorkspace?: string;
  };
  expect(observed.code).toBe(0);
  expect(observed.events).toContain('secret-used');
  expect(observed.transportedWorkspace).toBe(originalSnapshot);
  expect(observed.events.indexOf('native-terminal')).toBeGreaterThanOrEqual(0);
  expect(observed.events.indexOf('final-settlement')).toBeGreaterThan(observed.events.indexOf('native-terminal'));
  expect(observed.authenticated).toEqual([
    { type: 'native-terminal', binding: descriptor.binding },
    { type: 'final-settlement', binding: descriptor.binding },
  ]);
  const settled = await getCheckRunStatus(descriptor.invocationId, { stateDirectory });
  expect(settled.phase).toBe('settled');
  expect(settled.final?.binding).toEqual(descriptor.binding);
  expect(settled.final?.cleanup.disposition).toBe('settled');
  expect(settled.final?.native?.exitCode).toBe(0);
  expect(settled.snapshot?.workspace).toBe(originalSnapshot);
  expect(settled.snapshotCustody).toBe('removed');

  const replay = runSeparateCli(['run-prepared', '--descriptor', descriptorFile], fixture, {
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
  });
  expect(replay.status).not.toBe(0);
  expect(JSON.parse(replay.stdout.trim()).events).toEqual([]);
  expect((await getCheckRunStatus(descriptor.invocationId, { stateDirectory })).final).toEqual(settled.final);
});

test('prepared execution establishes its original registration before cancellation can bind a workspace or allocate', async () => {
  const fixture = candidate();
  const stateDirectory = join(fixture.parent, 'state');
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const descriptorFile = join(stateDirectory, 'prepared.json');
  const descriptor = await prepareCheckRunInvocation(
    argsFor(fixture, ['bun', 'run', 'check']),
    descriptorFile,
    { stateDirectory },
    {},
  );
  const before = await getCheckRunStatus(descriptor.invocationId, { stateDirectory });
  const originalSnapshot = before.snapshot;
  const controller = new AbortController();
  let cancellationReady = false;
  let transportCalls = 0;
  const result = await runPreparedCheckRunInvocation(
    descriptorFile,
    {
      stateDirectory,
      onDurableCancellationReady: () => {
        cancellationReady = true;
        queueMicrotask(() => controller.abort());
      },
      transport: async () => {
        transportCalls += 1;
        return 0;
      },
    },
    controller.signal,
    {
      REMOTE_CHECK_INVOCATION_ID: descriptor.invocationId,
      REMOTE_CHECK_RECEIPT_NONCE: descriptor.nonce,
      REMOTE_CHECK_RECEIPT_FD: '3',
    },
  );

  expect(result).toBe(130);
  expect(cancellationReady).toBe(true);
  expect(transportCalls).toBe(0);
  const cancelled = await getCheckRunStatus(descriptor.invocationId, { stateDirectory });
  expect(cancelled.invocationId).toBe(before.invocationId);
  expect(cancelled.binding).toEqual(descriptor.binding);
  expect(cancelled.snapshot).toEqual(originalSnapshot);
  expect(cancelled.phase).toBe('cancelled');
  expect(cancelled.cancellation.requested).toBe(true);
  expect(cancelled.physical).toBeNull();
  expect(cancelled.snapshotCustody).toBe('removed');
});

test('unknown and failed remote cleanup evidence stay non-green with the exact admitted physical host', async () => {
  const cases: Array<{
    status: 'verified' | 'unknown';
    failures: string[];
    settlementHost?: string;
    expectedRemote: 'failed' | 'unknown';
  }> = [
    { status: 'unknown', failures: [], expectedRemote: 'unknown' },
    { status: 'verified', failures: ['mock remote cleanup failure'], expectedRemote: 'failed' },
    { status: 'unknown', failures: [], settlementHost: 'a', expectedRemote: 'unknown' },
  ];

  for (const scenario of cases) {
    const fixture = candidate();
    const finals: string[] = [];
    let retained: CandidateSnapshot | undefined;
    try {
      const result = await runCheck(argsFor(fixture, ['bun', 'run', 'check']), {
        settlementWriter: (line) => finals.push(line),
        stateDirectory: fixture.parent,
        onRetainSnapshot: (snapshot) => (retained = snapshot),
        transport: async (options) => {
          const native = receipt('c', 0, 'physical-run-admitted-c');
          const physical = { host: 'c', run: native.run };
          await options.allocated?.(physical);
          await options.completed?.(native);
          await options.settled?.(
            remoteSettlement(options, native, {
              host: scenario.settlementHost ?? 'c',
              cleanup: {
                schema: 1,
                host: 'c',
                run: native.run,
                status: scenario.status,
                supervisorStopped: scenario.status === 'verified',
                commandGroupTerminal: scenario.status === 'verified',
                containersRemoved: scenario.status === 'verified',
                runDirectoryRemoved: scenario.status === 'verified',
                failures: scenario.failures,
              },
            }),
          );
          return 0;
        },
      });

      expect(result).toBe(75);
      expect(finals).toHaveLength(1);
      const encoded = finals[0];
      if (!encoded) throw new Error('remote cleanup did not produce a retained final settlement');
      const final = JSON.parse(encoded);
      expect(final.physical).toEqual({ host: 'c', run: 'physical-run-admitted-c' });
      expect(final.native.exitCode).toBe(0);
      expect(final.cleanup.remote).toBe(scenario.expectedRemote);
      expect(final.cleanup.disposition).toBe('unknown');
      expect(final.failures.cleanup.length).toBeGreaterThan(0);
      if (scenario.failures.length) expect(final.failures.cleanup).toContain(scenario.failures[0]);
      if (scenario.settlementHost) expect(final.failures.primary.join(' ')).toContain('admitted physical identity');
      if (!retained) throw new Error('unknown cleanup did not retain the original snapshot');
      expect(existsSync(retained.workspace)).toBe(true);
    } finally {
      if (retained) removeRetainedSnapshot(fixture, retained);
    }
  }
});

test('descriptor tampering and foreign identity fail closed before transport', async () => {
  const fixture = candidate();
  mkdirSync(join(fixture.parent, 'state'), { mode: 0o700 });
  const stateDirectory = join(fixture.parent, 'state');
  const firstFile = join(stateDirectory, 'first.json');
  const secondFile = join(stateDirectory, 'second.json');
  const args = argsFor(fixture, ['bun', 'test', 'prepared']);
  const prepare = (descriptorFile: string) =>
    runSeparateCli(
      [
        'prepare',
        '--descriptor',
        descriptorFile,
        '--hosts',
        args.hosts,
        '--workspace',
        args.workspace,
        '--cwd',
        args.cwd,
        '--source-revision',
        args.sourceRevision,
        '--env-file',
        args.envFile,
        '--',
        ...args.command,
      ],
      fixture,
    );
  const firstResult = prepare(firstFile);
  const secondResult = prepare(secondFile);
  expect(firstResult.status).toBe(0);
  expect(secondResult.status).toBe(0);
  const first = JSON.parse(firstResult.stdout.trim()) as ReturnType<typeof readCheckRunPreparedDescriptor>;
  const second = JSON.parse(secondResult.stdout.trim()) as ReturnType<typeof readCheckRunPreparedDescriptor>;
  const foreign = runSeparateCli(['run-prepared', '--descriptor', secondFile], fixture, {
    invocationId: first.invocationId,
    nonce: first.nonce,
  });
  expect(foreign.status).not.toBe(0);
  expect(JSON.parse(foreign.stdout.trim()).events).toEqual([]);

  writeFileSync(
    firstFile,
    `${JSON.stringify({ ...first, binding: { ...first.binding, argvSha256: '9'.repeat(64) } })}\n`,
  );
  chmodSync(firstFile, 0o600);
  const tampered = runSeparateCli(['run-prepared', '--descriptor', firstFile], fixture, {
    invocationId: first.invocationId,
    nonce: first.nonce,
  });
  expect(tampered.status).not.toBe(0);
  expect(JSON.parse(tampered.stdout.trim()).events).toEqual([]);
  expect((await getCheckRunStatus(first.invocationId, { stateDirectory })).phase).toBe('prepared');

  for (const descriptor of [first, second])
    await reconcileRegisteredCheckRun(descriptor.invocationId, undefined, { stateDirectory });
  expect((await getCheckRunStatus(first.invocationId, { stateDirectory })).snapshotCustody).toBe('removed');
  expect((await getCheckRunStatus(second.invocationId, { stateDirectory })).snapshotCustody).toBe('removed');
});

test('changed candidate inputs and cancellation cannot spawn late or replace the owned snapshot', async () => {
  const changedFixture = candidate();
  mkdirSync(join(changedFixture.parent, 'state'), { mode: 0o700 });
  const changedState = join(changedFixture.parent, 'state');
  const changedDescriptorFile = join(changedState, 'changed.json');
  const args = argsFor(changedFixture, ['bun', 'test', 'prepared-input']);
  const prepareArgs = (descriptorFile: string, checkArgs: CheckRunArguments) => [
    'prepare',
    '--descriptor',
    descriptorFile,
    '--hosts',
    checkArgs.hosts,
    '--workspace',
    checkArgs.workspace,
    '--cwd',
    checkArgs.cwd,
    '--source-revision',
    checkArgs.sourceRevision,
    '--env-file',
    checkArgs.envFile,
    '--',
    ...checkArgs.command,
  ];
  const changedPrepare = runSeparateCli(prepareArgs(changedDescriptorFile, args), changedFixture);
  expect(changedPrepare.status).toBe(0);
  const changed = JSON.parse(changedPrepare.stdout.trim()) as ReturnType<typeof readCheckRunPreparedDescriptor>;
  const original = (await getCheckRunStatus(changed.invocationId, { stateDirectory: changedState })).snapshot
    ?.workspace;
  writeFileSync(join(changedFixture.root, 'src/input.ts'), 'export const value = 8;\n');
  const rejected = runSeparateCli(['run-prepared', '--descriptor', changedDescriptorFile], changedFixture, {
    invocationId: changed.invocationId,
    nonce: changed.nonce,
  });
  expect(rejected.status).toBe(75);
  expect(JSON.parse(rejected.stdout.trim()).events).toEqual([]);
  const changedRecord = await getCheckRunStatus(changed.invocationId, { stateDirectory: changedState });
  expect(changedRecord.phase).toBe('cancelled');
  expect(changedRecord.snapshot?.workspace).toBe(original);
  expect(changedRecord.snapshotCustody).toBe('removed');
  expect(existsSync(original!)).toBe(false);

  const queuedFixture = candidate();
  mkdirSync(join(queuedFixture.parent, 'state'), { mode: 0o700 });
  const queuedState = join(queuedFixture.parent, 'state');
  const queuedDescriptorFile = join(queuedState, 'queued.json');
  const queuedArgs = argsFor(queuedFixture, ['bun', 'test', 'queued-prepared']);
  const queuedPrepare = runSeparateCli(prepareArgs(queuedDescriptorFile, queuedArgs), queuedFixture);
  expect(queuedPrepare.status).toBe(0);
  const queued = JSON.parse(queuedPrepare.stdout.trim()) as ReturnType<typeof readCheckRunPreparedDescriptor>;
  const queuedSnapshot = (await getCheckRunStatus(queued.invocationId, { stateDirectory: queuedState })).snapshot
    ?.workspace;
  const cancelled = runSeparateCli(['run-prepared', '--descriptor', queuedDescriptorFile], queuedFixture, {
    cancelQueued: true,
    invocationId: queued.invocationId,
    nonce: queued.nonce,
  });
  expect(cancelled.status).toBe(75);
  const queuedResult = JSON.parse(cancelled.stdout.trim()) as { code: number; events: string[] };
  expect(queuedResult.events).toContain('allocation-fenced');
  expect(queuedResult.events).not.toContain('native-terminal');
  const retained = await getCheckRunStatus(queued.invocationId, { stateDirectory: queuedState });
  expect(retained.phase).toBe('unknown');
  expect(retained.snapshot?.workspace).toBe(queuedSnapshot);
  expect(retained.snapshotCustody).toBe('owned');
  expect(existsSync(queuedSnapshot!)).toBe(true);
  const reconciled = await reconcileRegisteredCheckRun(queued.invocationId, undefined, { stateDirectory: queuedState });
  expect(reconciled.phase).toBe('cancelled');
  expect(reconciled.snapshot?.workspace).toBe(queuedSnapshot);
  expect(reconciled.snapshotCustody).toBe('removed');
  expect(existsSync(queuedSnapshot!)).toBe(false);

  const abandonedFixture = candidate();
  mkdirSync(join(abandonedFixture.parent, 'state'), { mode: 0o700 });
  const abandonedState = join(abandonedFixture.parent, 'state');
  const abandonedDescriptorFile = join(abandonedState, 'abandoned.json');
  const abandonedArgs = argsFor(abandonedFixture, ['bun', 'test', 'abandoned-prepared']);
  const abandonedPrepare = runSeparateCli(prepareArgs(abandonedDescriptorFile, abandonedArgs), abandonedFixture);
  expect(abandonedPrepare.status).toBe(0);
  const abandoned = JSON.parse(abandonedPrepare.stdout.trim()) as ReturnType<typeof readCheckRunPreparedDescriptor>;
  const abandonedSnapshot = (await getCheckRunStatus(abandoned.invocationId, { stateDirectory: abandonedState }))
    .snapshot?.workspace;
  await cancelCheckRunInvocation(abandoned.invocationId, abandoned.nonce, 15, { stateDirectory: abandonedState });
  const noClaim = runSeparateCli(['run-prepared', '--descriptor', abandonedDescriptorFile], abandonedFixture, {
    invocationId: abandoned.invocationId,
    nonce: abandoned.nonce,
  });
  expect(noClaim.status).not.toBe(0);
  expect(JSON.parse(noClaim.stdout.trim()).events).toEqual([]);
  const abandonedResult = await reconcileRegisteredCheckRun(abandoned.invocationId, undefined, {
    stateDirectory: abandonedState,
  });
  expect(abandonedResult.phase).toBe('cancelled');
  expect(abandonedResult.snapshot?.workspace).toBe(abandonedSnapshot);
  expect(abandonedResult.snapshotCustody).toBe('removed');
  expect(existsSync(abandonedSnapshot!)).toBe(false);
});

test.each(['complete', 'wrong-source', 'wrong-run', 'corrupt', 'incomplete', 'failed'] as const)(
  'original check-run terminal receiving validates the entire named tree and mixed schema return: %s',
  async (mode) => {
    const fixture = candidate({ tmpfs: true, output: `${PROFILE.root}/obsolete.d.ts` });
    writeFileSync(join(fixture.root, 'packages/client/src/sibling.ts'), 'untouched');
    const schema = 'services/kernel/db/semantic/schema.sql';
    const returns = [PROFILE.transport, schema];
    const finals: string[] = [];
    let allocations = 0;
    let retained: CandidateSnapshot | undefined;
    let expected: ReturnType<typeof collectOutputTree>['members'] = [];
    let actualSource = '';
    const args = argsFor(
      fixture,
      ['bun', 'run', '--cwd', 'services/kernel', 'typecheck', '--emit-client', '--emit-schema=semantic'],
      returns,
    );
    try {
      const result = await runCheck(args, {
        stateDirectory: fixture.parent,
        settlementWriter: (line) => finals.push(line),
        onRetainSnapshot: (snapshot) => {
          retained = snapshot;
        },
        transport: async (options) => {
          allocations++;
          expect(options.returns).toEqual(returns);
          actualSource = options.expectedSourceSha256!;
          expect(actualSource).toMatch(/^[a-f0-9]{64}$/);
          const native = receipt('a', mode === 'failed' ? 23 : 0);
          await options.allocated?.({ host: native.host, run: native.run });
          const producer = join(fixture.parent, 'producer');
          for (let i = 0; i < 282; i++) {
            const file = join(producer, PROFILE.root, `module${String(i).padStart(3, '0')}/query.sql.d.ts`);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, `export declare const row${i}: ${i};\n`);
          }
          expected = collectOutputTree(producer).members;
          const bytes = encodeOutputTree(producer, {
            host: native.host,
            run: mode === 'wrong-run' ? 'previous-physical-run' : native.run,
            sourceSha256: mode === 'wrong-source' ? 'f'.repeat(64) : actualSource,
          });
          if (mode === 'corrupt') bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
          for (const [path, content] of [
            [PROFILE.transport, bytes],
            [schema, Buffer.from('CREATE TABLE proof(id int);\n')],
          ] as const) {
            const file = join(options.workspace, path);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, content);
          }
          const entries = returns.map((path) => {
            const content = readFileSync(join(options.workspace, path));
            return { path, size: content.length, sha256: outputTreeDigest(content), kind: 'file' as const };
          });
          options.completed?.(native);
          options.settled?.(
            remoteSettlement(options, native, {
              returns: {
                schema: 1,
                status: mode === 'incomplete' ? 'missing' : 'complete',
                entries: mode === 'incomplete' ? entries.slice(0, 1) : entries,
                failures: [],
                missing: mode === 'incomplete' ? [schema] : [],
              },
            }),
          );
          return native.exitCode;
        },
      });
      expect(allocations).toBe(1);
      const final = JSON.parse(finals[0]!);
      expect(final.binding.sourceSha256).toBe(actualSource);
      expect(final.physical).toEqual({ host: 'a', run: 'physical-run-1' });
      if (mode === 'complete') {
        expect(result).toBe(0);
        expect(final.returns.status).toBe('restored');
        expect(collectOutputTree(fixture.root).members).toEqual(expected);
        expect(existsSync(join(fixture.root, PROFILE.root, 'obsolete.d.ts'))).toBe(false);
        expect(readFileSync(join(fixture.root, schema), 'utf8')).toBe('CREATE TABLE proof(id int);\n');
        const replay = await runCheck(
          args,
          {
            stateDirectory: fixture.parent,
            transport: async () => {
              throw new Error('terminal replay must not allocate');
            },
          },
          new AbortController().signal,
          {
            REMOTE_CHECK_RECEIPT_FD: '3',
            REMOTE_CHECK_RECEIPT_NONCE: final.nonce,
            REMOTE_CHECK_INVOCATION_ID: final.invocationId,
          },
        );
        expect(replay).toBe(0);
        expect(collectOutputTree(fixture.root).members).toEqual(expected);
      } else {
        expect(result).not.toBe(0);
        if (mode === 'failed') expect(result).toBe(23);
        expect(final.returns.status).not.toBe('restored');
        expect(readFileSync(join(fixture.root, PROFILE.root, 'obsolete.d.ts'), 'utf8')).toBe(
          'stale output must not reach the host\n',
        );
        expect(collectOutputTree(fixture.root).members).toHaveLength(1);
      }
      expect(readFileSync(join(fixture.root, 'packages/client/src/sibling.ts'), 'utf8')).toBe('untouched');
    } finally {
      if (retained) removeRetainedSnapshot(fixture, retained);
    }
  },
);
