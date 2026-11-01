import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCheckRunArguments, runCheck, type CandidateSnapshot, type CheckRunArguments } from './check-run.ts';
import type { RemoteCheck, RemotePhysicalRunReceipt } from './remote-check.ts';
import type { RemoteCheckSettlement } from './remote-check.ts';

const repository = resolve(import.meta.dir, '..');
const temporary: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function candidate(options: { web?: boolean; output?: string } = {}) {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const parent = mkdtempSync(join(repository, '.temp', `check-run-test-${randomUUID()}-`));
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
        options.started?.('a');
        frozenRoot = options.workspace;
        expect(options.workspace).not.toBe(fixture.root);
        expect(await Bun.file(join(options.workspace, 'src/input.ts')).text()).toBe('export const value = 7;\n');
        expect(existsSync(join(options.workspace, 'reports/result.txt'))).toBe(false);
        expect(options.cwd).toBe('apps/web');
        expect(options.hosts.map(({ name }) => name)).toEqual(['a', 'b']);
        expect(options.allowedHosts).toEqual(['a', 'b']);
        expect(options.priority).toBe('critical');
        expect(options.command).toEqual(['env', `LABEL=${overlay.LABEL}`, 'SETTINGS_FILE=settings.json', ...argv]);
        expect(options.prepare).toEqual([
          { cwd: '.', command: ['bun', 'run', '--cwd', 'apps/web', 'generate'] },
          { cwd: '.', command: ['bun', 'run', '--cwd', 'apps/web', 'generate:routes'] },
        ]);
        expect(options.cancellation).toEqual({ file: cancellationFile, id: cancellationId });
        expect(selectedHost).toBe('a');
        received.push(...options.command);
        mkdirSync(join(options.workspace, 'reports'), { recursive: true });
        writeFileSync(join(options.workspace, 'reports/result.txt'), 'fresh remote output\n');
        options.completed?.(receipt('a', 0));
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
  expect(selectedHost).toBe('a');
  expect(completed).toHaveLength(1);
  expect(JSON.parse(completed[0]!)).toEqual({ nonce: 'trusted-nonce', receipt: receipt('a', 0) });
  expect(readFileSync(outputPath, 'utf8')).toBe('fresh remote output\n');
  expect(existsSync(frozenRoot)).toBe(false);
});

test('source mismatch, c-only hosts, forbidden env values, and missing generated inputs fail before transport', async () => {
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
        { name: 'c', address: 'root@c.example', identity: '/keys/c', memoryMaxGiB: 16, cpuQuotaPercent: 800, slots: 8 },
      ],
    }),
  );
  await expect(runCheck(argsFor(fixture, ['bun', 'test']), dependencies)).rejects.toThrow('no approved a/b host');
  expect(transports).toBe(0);

  writeFileSync(
    fixture.hosts,
    JSON.stringify({
      hosts: ['a', 'b'].map((name) => ({
        name,
        address: `root@${name}.example`,
        identity: `/keys/${name}`,
        memoryMaxGiB: 16,
        cpuQuotaPercent: 800,
        slots: 8,
      })),
    }),
  );
  writeFileSync(fixture.envFile, JSON.stringify({ PATH: '/tmp/attacker-bin' }) + '\n');
  await expect(runCheck(argsFor(fixture, ['bun', 'test']), dependencies)).rejects.toThrow(
    'host-local or placement authority',
  );
  expect(transports).toBe(0);

  writeFileSync(fixture.envFile, JSON.stringify({ REMOTE_CHECK_PRIORITY: 'critical' }) + '\n');
  await expect(runCheck(argsFor(fixture, ['bun', 'test']), dependencies)).rejects.toThrow(
    'host-local or placement authority',
  );
  expect(transports).toBe(0);

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
  writeFileSync(privateKey, '-----BEGIN PRIVATE KEY-----\nfake fixture\n');
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
  const missingCode = await runCheck(
    argsFor(missing, ['bun', 'run', 'check'], ['reports/result.txt']),
    {
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
    },
  );
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
    const cleanupCode = await runCheck(
      argsFor(cleanup, ['bun', 'run', 'check']),
      {
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
      },
    );
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

test('private environment rejects runtime injection and host executable path authority', async () => {
  const fixture = candidate();
  for (const [name, value] of [
    ['NODE_OPTIONS', '--require /tmp/injected.cjs'],
    ['NODE_PATH', '/tmp/injected-modules'],
    ['LD_PRELOAD', '/tmp/injected.so'],
  ]) {
    writeFileSync(fixture.envFile, JSON.stringify({ [name]: value }) + '\n');
    await expect(runCheck(argsFor(fixture, ['bun', 'run', 'check']), { transport: async () => 0 })).rejects.toThrow(name);
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
