import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Browser } from 'playwright';
import {
  hasWebCheckCustody,
  localStorybookPublicationRevisionEnvironment,
  placeWebCheck,
  routeWebCheck,
  trustedDriver,
  webCheckDriverCommand,
  webCheckEnvironment,
  workspacePath,
  type DriverExecution,
  type WebPlacementRuntime,
} from './check-placement.ts';
import type {
  PreparedCheckRunDescriptor,
  WebCheckCustodyRuntime,
  WebCheckDriverInvocation,
  WebCheckPrivateFiles,
} from './check-placement-custody.ts';
import { runBrowserWorker, runWebTestLanes } from './check.ts';
import { smokeStorybook } from './storybook-smoke.ts';
import { storybookLaunchPlan } from './storybook-dev.ts';

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

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const directory of fixtureRoots) rmSync(directory, { recursive: true, force: true });
});

function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsePrepare(command: string[]) {
  const separator = command.indexOf('--');
  const value = (name: string) => command[command.indexOf(name) + 1]!;
  return {
    descriptorFile: value('--descriptor'),
    hostsFile: value('--hosts'),
    workspace: value('--workspace'),
    cwd: value('--cwd'),
    sourceRevision: value('--source-revision'),
    environmentFile: value('--env-file'),
    returns: command
      .slice(0, separator)
      .flatMap((part, index, list) => (part === '--returns' ? [list[index + 1]!] : [])),
    command: command.slice(separator + 1),
  };
}

function descriptorFor(input: WebCheckDriverInvocation): PreparedCheckRunDescriptor {
  const parsed = parsePrepare(input.command);
  const environment = JSON.parse(readFileSync(parsed.environmentFile, 'utf8')) as Record<string, string>;
  const sortedEnvironment = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  const priority = input.env.REMOTE_CHECK_PRIORITY ?? null;
  const environmentHash = sha(JSON.stringify({ values: sortedEnvironment, priority }));
  const returns = [...new Set(parsed.returns)];
  const binding = {
    sourceRevision: parsed.sourceRevision,
    indexTree: parsed.sourceRevision,
    sourceSha256: 'c'.repeat(64),
    argvSha256: sha(JSON.stringify(parsed.command)),
    cwd: parsed.cwd,
    semanticEnvironmentSha256: environmentHash,
    relocatedEnvironmentSha256: environmentHash,
    producerClosureSha256: 'd'.repeat(64),
    hostsSha256: sha(readFileSync(parsed.hostsFile)),
    preparationCommandsSha256: 'e'.repeat(64),
    returnsSha256: sha(JSON.stringify(returns)),
  };
  return {
    schema: 1,
    type: 'check-run-preparation',
    invocationId: '11111111-1111-4111-8111-111111111111',
    nonce: 'a'.repeat(64),
    binding,
    cancellation: {
      file: join(dirname(parsed.descriptorFile), 'cancel.json'),
      id: '11111111-1111-4111-8111-111111111111',
    },
  };
}

function terminalMessages(
  descriptor: PreparedCheckRunDescriptor,
  exitCode: number,
  returns: string[],
  duplicateFinal = false,
) {
  const physical = { host: 'a' as const, run: 'fixture-physical-run' };
  const receipt = {
    schema: 1 as const,
    host: physical.host,
    run: physical.run,
    exitCode,
    lifetimeFailure: null,
    resources: null,
  };
  const receiptSha256 = sha(
    JSON.stringify({ schema: receipt.schema, host: receipt.host, run: receipt.run, exitCode, lifetimeFailure: null }),
  );
  const native = {
    schema: 1 as const,
    type: 'native-terminal' as const,
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    binding: descriptor.binding,
    physical,
    receipt,
  };
  const final = {
    schema: 1 as const,
    type: 'final-settlement' as const,
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    binding: descriptor.binding,
    physical,
    native: { exitCode, lifetimeFailure: false, receiptSha256 },
    preparedInputs: {
      status: 'verified' as const,
      sourceSha256: descriptor.binding.sourceSha256,
      manifestSha256: 'f'.repeat(64),
      fileCount: 1,
      totalBytes: 1,
    },
    returns: {
      status: returns.length ? ('restored' as const) : ('empty' as const),
      declarationsSha256: descriptor.binding.returnsSha256,
      entries: returns.map((path) => ({ path, size: 0, sha256: sha('') })),
      missing: [],
      failures: [],
    },
    cleanup: {
      disposition: 'settled' as const,
      remote: 'verified' as const,
      transportChild: 'reaped' as const,
      source: 'verified' as const,
      localWorktree: 'removed' as const,
      failures: [],
    },
    failures: { primary: [], cleanup: [] },
  };
  const nativeLine = `${JSON.stringify(native)}\n`;
  const finalLine = `${JSON.stringify(final)}\n`;
  return {
    physical,
    receipt,
    native,
    final,
    nativeLine,
    finalLine,
    bytes: Buffer.from(nativeLine + finalLine + (duplicateFinal ? finalLine : '')),
  };
}

type ProducerReferences = {
  preparedExecution: { file: string; sha256: string };
  descriptor: { file: string; sha256: string };
  preparationIntent: { file: string; sha256: string } | null;
};

function registrationFor(
  descriptor: PreparedCheckRunDescriptor,
  prepared: ReturnType<typeof parsePrepare>,
): ProducerReferences {
  return {
    preparedExecution: {
      file: join(dirname(prepared.descriptorFile), 'prepared-execution.json'),
      sha256: sha('prepared execution bytes'),
    },
    descriptor: { file: prepared.descriptorFile, sha256: sha(`${JSON.stringify(descriptor)}\n`) },
    preparationIntent: null,
  };
}

function preparationStatusFor(
  descriptor: PreparedCheckRunDescriptor,
  prepared: ReturnType<typeof parsePrepare>,
  registration: ProducerReferences,
) {
  return {
    schema: 1,
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.500Z',
    phase: 'prepared',
    binding: descriptor.binding,
    physical: null,
    transportChild: null,
    native: null,
    snapshot: {
      workspace: '/frozen/workspace',
      scratch: '/frozen',
      sourceSha256: descriptor.binding.sourceSha256,
      inputFiles: [],
    },
    candidateWorkspace: prepared.workspace,
    preparedExecution: registration.preparedExecution,
    descriptor: registration.descriptor,
    preparationIntent: null,
    snapshotCustody: 'owned',
    returns: prepared.returns,
    cancellation: { requested: false, signal: null },
    final: null,
    finalCustody: null,
    failure: null,
  };
}

function statusFor(
  descriptor: PreparedCheckRunDescriptor,
  messages: ReturnType<typeof terminalMessages>,
  prepared: ReturnType<typeof parsePrepare>,
  registration: ProducerReferences,
) {
  const snapshot = {
    workspace: '/frozen/workspace',
    scratch: '/frozen',
    sourceSha256: descriptor.binding.sourceSha256,
    inputFiles: [],
  };
  const identityCore = {
    bindingSha256: sha(JSON.stringify(descriptor.binding)),
    physical: messages.physical,
    sourceSha256: descriptor.binding.sourceSha256,
    snapshotSha256: sha(JSON.stringify(snapshot)),
    candidateWorkspaceSha256: sha(JSON.stringify(prepared.workspace)),
    returnsSha256: descriptor.binding.returnsSha256,
    preparedExecutionReferenceSha256: sha(JSON.stringify(registration.preparedExecution)),
    descriptorReferenceSha256: sha(JSON.stringify(registration.descriptor)),
    preparationIntentReferenceSha256: registration.preparationIntent
      ? sha(JSON.stringify(registration.preparationIntent))
      : null,
  };
  const finalCustody = {
    schema: 1,
    aggregate: 'settled',
    delivery: 'delivered',
    deliverySha256: sha(messages.finalLine.slice(0, -1)),
    privateFiles: 'settled',
    reconciliation: 'settled',
    originalFinalSha256: sha(JSON.stringify(messages.final)),
    identity: { sha256: sha(JSON.stringify(identityCore)), ...identityCore },
    observations: [
      {
        observedAt: '2026-11-02T00:00:01.000Z',
        disposition: 'settled',
        transportIdentity: null,
        final: messages.final,
        reason: null,
      },
    ],
    continuation: null,
  };
  return {
    schema: 1,
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:01.000Z',
    phase: 'settled',
    binding: descriptor.binding,
    physical: messages.physical,
    transportChild: null,
    native: messages.final.native,
    snapshot,
    candidateWorkspace: prepared.workspace,
    preparedExecution: null,
    descriptor: registration.descriptor,
    preparationIntent: null,
    snapshotCustody: 'removed',
    returns: prepared.returns,
    cancellation: { requested: false, signal: null },
    final: messages.final,
    finalCustody,
    failure: null,
  };
}

function fixture() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const fixtureRoot = mkdtempSync(join(root, '.temp', 'web-placement-fixture-'));
  fixtureRoots.push(fixtureRoot);
  const workspace = join(fixtureRoot, 'candidate');
  const privateRoot = join(fixtureRoot, 'private');
  mkdirSync(join(workspace, 'apps/web'), { recursive: true });
  mkdirSync(join(workspace, 'packages/ui'), { recursive: true });
  mkdirSync(join(workspace, '.temp'), { recursive: true });
  mkdirSync(privateRoot, { recursive: true });
  const hostsFile = join(privateRoot, 'hosts.json');
  writeFileSync(hostsFile, '{"hosts":[]}', { mode: 0o600 });
  const calls: DriverExecution[] = [];
  const runCalls: DriverExecution[] = [];
  const overlays: Record<string, string>[] = [];
  let closed = 0;
  let nativeExitCode = 0;
  let missingFinal = false;
  let duplicateFinal = false;
  let transportError: unknown;
  let cleanupError: unknown;
  let lastFiles: WebCheckPrivateFiles | undefined;
  let descriptor: PreparedCheckRunDescriptor | undefined;
  let prepared: ReturnType<typeof parsePrepare> | undefined;
  let registration: ProducerReferences | undefined;
  let messages: ReturnType<typeof terminalMessages> | undefined;
  const custody: WebCheckCustodyRuntime = {
    async invoke(input) {
      if (input.phase === 'prepare') {
        calls.push({
          command: input.command,
          cwd: input.cwd,
          env: input.env,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        descriptor = descriptorFor(input);
        prepared = parsePrepare(input.command);
        const output = `${JSON.stringify(descriptor)}\n`;
        writeFileSync(prepared.descriptorFile, output, { mode: 0o600 });
        registration = registrationFor(descriptor, prepared);
        return { code: 0, signal: null, closed: true, output, outputOverflow: false };
      }
      if (input.phase === 'run-prepared') {
        runCalls.push({
          command: input.command,
          cwd: input.cwd,
          env: input.env,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (transportError) throw transportError;
        messages = terminalMessages(descriptor!, nativeExitCode, prepared!.returns, duplicateFinal);
        input.onReceipt?.(Buffer.from(missingFinal ? `${messages.nativeLine}` : messages.bytes));
        return { code: nativeExitCode, signal: null, closed: true, output: '', outputOverflow: false };
      }
      if (input.phase === 'status') {
        if (!messages) {
          const value = preparationStatusFor(descriptor!, prepared!, registration!);
          return { code: 0, signal: null, closed: true, output: `${JSON.stringify(value)}\n`, outputOverflow: false };
        }
        const value = statusFor(descriptor!, messages, prepared!, registration!);
        if (missingFinal) value.final = null as never;
        return { code: 0, signal: null, closed: true, output: `${JSON.stringify(value)}\n`, outputOverflow: false };
      }
      if (!messages) return { code: 75, signal: null, closed: true, output: '', outputOverflow: false };
      const result = statusFor(descriptor!, messages, prepared!, registration!);
      return { code: 0, signal: null, closed: true, output: `${JSON.stringify(result)}\n`, outputOverflow: false };
    },
    cleanup(files) {
      if (cleanupError) throw cleanupError;
      files.close();
    },
  };
  const adapter: WebPlacementRuntime = {
    custody: () => false,
    driver: () => '/trusted/producer',
    hosts: () => hostsFile,
    revision: () => revision,
    isTreeClean: () => true,
    environment(values) {
      overlays.push(values);
      const directory = mkdtempSync(join(privateRoot, 'invocation-'));
      const path = join(directory, 'environment.json');
      writeFileSync(path, JSON.stringify(values), { mode: 0o600 });
      const evidenceFile = join(directory, 'receipts.ndjson');
      writeFileSync(evidenceFile, '', { mode: 0o600 });
      lastFiles = {
        directory,
        environmentFile: path,
        descriptorFile: join(directory, 'prepared-descriptor.json'),
        recordFile: join(directory, 'web-custody.json'),
        evidenceFile,
        close: () => {
          closed += 1;
          rmSync(directory, { recursive: true, force: true });
        },
      };
      return lastFiles;
    },
    receiver: custody,
    execute: async (input) => {
      calls.push(input);
      return 0;
    },
  };
  return {
    adapter,
    calls,
    runCalls,
    overlays,
    workspace,
    app: join(workspace, 'apps/web'),
    hostsFile,
    setNativeExitCode: (value: number) => {
      nativeExitCode = value;
    },
    setMissingFinal: (value: boolean) => {
      missingFinal = value;
    },
    setDuplicateFinal: (value: boolean) => {
      duplicateFinal = value;
    },
    setTransportError: (value: unknown) => {
      transportError = value;
    },
    setCleanupError: (value: unknown) => {
      cleanupError = value;
    },
    files: () => lastFiles!,
    descriptor: () => descriptor!,
    closed: () => closed,
  };
}

function fixtureRun(
  f: ReturnType<typeof fixture>,
  run: { root: string; cwd: string; command: string[]; returns?: string[]; label?: string },
) {
  const cwd = relative(root, resolve(run.cwd));
  if (cwd === '..' || cwd.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    throw new Error('test fixture cwd must be under the Web worktree');
  return { ...run, label: run.label ?? 'Web fixture', root: f.workspace, cwd: join(f.workspace, cwd) };
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

test('canonical dev accepts an integrated snapshot despite unrelated untracked files', async () => {
  const gitFixture = createDriverGitFixture();
  try {
    expect(git(gitFixture.repository, ['rev-parse', 'main'])).toBe(gitFixture.mainRevision);
    expect(git(gitFixture.repository, ['rev-parse', 'dev'])).toBe(gitFixture.devRevision);
    expect(gitFixture.mainRevision).not.toBe(gitFixture.devRevision);
    expect(gitFixture.integratedRevision).not.toBe(gitFixture.devRevision);

    const f = gitFixtureAdapter(gitFixture.candidateRoot);
    writeFileSync(join(gitFixture.integratedRoot, 'unrelated.txt'), 'unrelated checkout entry\n');
    writeFileSync(join(gitFixture.integratedRoot, 'scripts/unrelated.ts'), 'export {}\n');
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
      'driver sources must be clean',
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
        fixtureRun(f, { root, label: 'heavy route', ...route }),
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
    const separator = args.indexOf('--');
    expect(args.slice(0, separator)).toEqual([
      'bun',
      join('/trusted/producer', 'scripts/check-run.ts'),
      'prepare',
      '--descriptor',
      f.files().descriptorFile,
      '--hosts',
      f.hostsFile,
      '--workspace',
      f.workspace,
      '--cwd',
      route.cwd === app ? 'apps/web' : 'packages/ui',
      '--source-revision',
      revision,
      '--env-file',
      f.files().environmentFile,
      ...route.returns.flatMap((path) => ['--returns', path]),
    ]);
    expect(args.slice(separator + 1)).toEqual(route.command);
    expect(f.runCalls).toHaveLength(1);
    expect(f.runCalls[0]!.command).toEqual([
      'bun',
      join('/trusted/producer', 'scripts/check-run.ts'),
      'run-prepared',
      '--descriptor',
      f.files().descriptorFile,
    ]);
    expect(f.runCalls[0]!.env.REMOTE_CHECK_RECEIPT_FD).toBe('3');
    expect(f.runCalls[0]!.env.REMOTE_CHECK_RECEIPT_NONCE).toBe(f.descriptor().nonce);
    expect(f.runCalls[0]!.env.REMOTE_CHECK_INVOCATION_ID).toBe(f.descriptor().invocationId);
    expect(f.closed()).toBe(1);
  }
});

test('an explicit local publication admits only the exact finite deployment validation commands', async () => {
  const local = { [localStorybookPublicationRevisionEnvironment]: revision };
  const routes = [
    {
      command: ['bun', 'scripts/storybook-deploy.ts', '--validate-only'],
      returns: ['apps/web/storybook-static'],
    },
    { command: ['bun', 'scripts/storybook-build.ts'], returns: ['apps/web/storybook-static'] },
    { command: ['bun', 'scripts/storybook-smoke.ts'], returns: [] },
  ];

  for (const route of routes) {
    const f = fixture();
    f.adapter.custody = () => false;
    expect(await routeWebCheck(fixtureRun(f, { root, cwd: app, ...route }), local, f.adapter)).toBeNull();
    expect(f.calls).toHaveLength(0);
    expect(f.overlays).toHaveLength(0);
    expect(f.closed()).toBe(0);
  }
});

test('local publication authorization never admits interactive, altered or unrelated heavy commands', async () => {
  const local = { [localStorybookPublicationRevisionEnvironment]: revision };
  const commands = [
    ['bun', 'scripts/storybook-build.ts', '--force'],
    ['bun', 'scripts/storybook-smoke.ts', '--origin', 'https://example.invalid/'],
    ['bun', 'scripts/storybook-dev.ts', '--port', '6006'],
    ['bun', 'test', 'tests/page-stories.test.ts'],
  ];

  for (const command of commands) {
    const f = fixture();
    f.adapter.custody = () => false;
    expect(await routeWebCheck(fixtureRun(f, { root, cwd: app, command }), local, f.adapter)).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.command.slice(-command.length)).toEqual(command);
    expect(f.calls[0]!.env).not.toHaveProperty(localStorybookPublicationRevisionEnvironment);
    expect(f.overlays[0]).not.toHaveProperty(localStorybookPublicationRevisionEnvironment);
  }
});

test('local publication requires the exact committed revision and a clean source tree', async () => {
  const local = { [localStorybookPublicationRevisionEnvironment]: revision };
  const run = {
    root,
    cwd: app,
    command: ['bun', 'scripts/storybook-build.ts'],
    returns: ['apps/web/storybook-static'],
  };
  const changed = fixture();
  changed.adapter.custody = () => false;
  changed.adapter.revision = () => 'b'.repeat(40);
  await expect(routeWebCheck(fixtureRun(changed, run), local, changed.adapter)).rejects.toThrow('revision changed');
  expect(changed.calls).toHaveLength(0);

  const dirty = fixture();
  dirty.adapter.custody = () => false;
  dirty.adapter.isTreeClean = () => false;
  await expect(routeWebCheck(fixtureRun(dirty, run), local, dirty.adapter)).rejects.toThrow('clean working tree');
  expect(dirty.calls).toHaveLength(0);

  const malformed = fixture();
  malformed.adapter.custody = () => false;
  await expect(
    routeWebCheck(
      fixtureRun(malformed, run),
      { [localStorybookPublicationRevisionEnvironment]: 'head' },
      malformed.adapter,
    ),
  ).rejects.toThrow('full committed revision');
  expect(malformed.calls).toHaveLength(0);
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
        fixtureRun(f, { root, cwd: app, label: 'heavy', command: ['bun', 'test', '--local'] }),
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
    f.setNativeExitCode(status);
    expect(
      await routeWebCheck(fixtureRun(f, { root, cwd: app, command: ['unknown', '--local'] }), forged, f.adapter),
    ).toBe(status);
    expect(f.calls).toHaveLength(1);
    expect(f.runCalls).toHaveLength(1);
    expect(f.closed()).toBe(1);
  }
  const f = fixture();
  f.setTransportError(new Error('transport terminality unknown'));
  expect(await routeWebCheck(fixtureRun(f, { root, cwd: app, command: ['bun', 'test'] }), {}, f.adapter)).toBe(75);
  expect(f.calls).toHaveLength(1);
  expect(f.runCalls).toHaveLength(1);
  expect(f.closed()).toBe(0);
});

test('only actual remote custody admits the native continuation; forged markers are irrelevant', async () => {
  const f = fixture();
  expect(hasWebCheckCustody(f.workspace, f.app)).toBe(false);
  expect(await routeWebCheck(fixtureRun(f, { root, cwd: app, command: ['bun', 'test'] }), forged, f.adapter)).toBe(0);
  f.adapter.custody = () => true; // Trusted physical-boundary fixture, not an environment override.
  expect(await routeWebCheck(fixtureRun(f, { root, cwd: app, command: ['bun', 'test'] }), {}, f.adapter)).toBeNull();
  expect(f.calls).toHaveLength(1);
});

test('private environment cleanup cannot hide native or transport failure', async () => {
  const native = fixture();
  const cleanup = new Error('private environment cleanup failed');
  native.setNativeExitCode(17);
  native.setCleanupError(cleanup);
  expect(
    await routeWebCheck(fixtureRun(native, { root, cwd: app, command: ['bun', 'test'] }), {}, native.adapter),
  ).toBe(17);
  expect(native.closed()).toBe(0);
  expect(readFileSync(native.files().evidenceFile, 'utf8')).toContain('native-terminal');
  expect(readFileSync(native.files().evidenceFile, 'utf8')).toContain('final-settlement');

  const transport = fixture();
  transport.setTransportError(new Error('transport terminality unknown'));
  transport.setCleanupError(cleanup);
  expect(
    await routeWebCheck(fixtureRun(transport, { root, cwd: app, command: ['bun', 'test'] }), {}, transport.adapter),
  ).toBe(75);
  expect(transport.closed()).toBe(0);
});

test('semantic strings/newlines survive JSON while host controls and receipt authority stay at the driver', async () => {
  const f = fixture();
  const env = {
    ...forged,
    CI: '1',
    MESSAGE: 'a\nb "quoted" $literal',
    STORYBOOK_OUTPUT_DIR: resolve(f.app, 'storybook-static'),
    WEB_CHECK_EVENTS: resolve(f.workspace, '.temp/events'),
    GOAL_SESSION_SECRET: 'private',
    PATH: '/local/bin',
    HOME: '/local/home',
    REMOTE_CHECK_RECEIPT_FD: '3',
    REMOTE_CHECK_RECEIPT_NONCE: 'authenticated',
  };
  const command = ['env', 'NAME=value with spaces\nand newline', 'bun', 'test', '--test-name-pattern', 'a "quote"'];
  await routeWebCheck(fixtureRun(f, { root, cwd: app, command }), env, f.adapter);
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

test('ambient host paths and compiler placement stay out of the overlay while semantics, argv and returns survive', async () => {
  const f = fixture();
  const certificatePath = '/nix/store/host-cacerts/etc/ssl/certs/ca-bundle.crt';
  const env = {
    NIX_SSL_CERT_FILE: certificatePath,
    DEBUGINFOD_IMA_CERT_PATH: '/nix/store/debugger/certificates',
    MOZ_GMP_PATH: '/nix/store/browser/plugins',
    NVM_DIR: '/host/runtime-manager',
    NVM_BIN: '/host/runtime-manager/bin',
    NVM_INC: '/host/runtime-manager/include',
    EDITOR: '/host/editor',
    VISUAL: '/host/editor',
    PAGER: '/host/pager',
    GPG_TTY: '/dev/pts/1',
    KDEDIRS: '/host/kde',
    MAIL: '/host/mail',
    MEMORY_PRESSURE_WATCH: '/host/memory-pressure',
    NIX_PROFILES: '/host/nix-profile',
    SSH_ASKPASS: '/host/askpass',
    TMUX: '/host/tmux,123,0',
    XDG_DATA_DIRS: '/host/share',
    ZSH: '/host/shell',
    KERNEL_CHECK_AFFECTED: '1',
    KERNEL_CHECK_REMOTE: 'required',
    CI: '1',
    MESSAGE: 'a\nb "quoted" $literal',
    STORYBOOK_OUTPUT_DIR: resolve(f.app, 'storybook-static'),
    GROWTH_PROFILE: resolve(f.app, '.temp/growth-profile.json'),
    WEB_TEST_STATE_DIR: resolve(f.app, '.temp/web-test-state'),
    WEB_CHECK_EVENTS: resolve(f.workspace, '.temp/web-check-events'),
  };
  const originalEnvironment = { ...env };
  const command = ['bun', 'test', 'tests/check placement.test.ts', '--test-name-pattern', 'a "quote"'];

  await routeWebCheck(
    fixtureRun(f, { root, cwd: app, command, returns: ['apps/web/reports/check.json'] }),
    env,
    f.adapter,
  );

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

test('absolute host-path settings are dropped while runtime option refusals stay intact', async () => {
  const certificatePath = '/nix/store/host-cacerts/etc/ssl/certs/ca-bundle.crt';
  const unsupported = [
    ['NODE_OPTIONS', '--require=/nix/store/node-hook/register.cjs'],
    ['BUN_OPTIONS', '--preload=/nix/store/bun-hook/register.ts'],
  ] as const;

  for (const [name, value] of unsupported) {
    const f = fixture();
    await expect(
      routeWebCheck(
        fixtureRun(f, { root, cwd: app, command: ['bun', 'test'] }),
        { NIX_SSL_CERT_FILE: certificatePath, [name]: value },
        f.adapter,
      ),
    ).rejects.toThrow(`unsupported host-path environment setting ${name}`);
    expect(f.overlays).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  }
});

test('inherited host runtimes and paths are omitted while kernel affected selection survives', () => {
  expect(
    webCheckEnvironment(
      {
        KERNEL_CHECK_AFFECTED: revision,
        NODE: '/usr/bin/node',
        NVM_DIR: '/home/worker/.nvm',
        NVM_INC: '/home/worker/.nvm/include/node',
        npm_config_prefix: '/home/worker/.npm',
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-0',
        XAUTHORITY: '/run/user/1000/Xauthority',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        DEBUGINFOD_IMA_CERT_PATH: 'none',
        MOZ_GMP_PATH: '/usr/lib/mozilla/plugins',
        UNKNOWN_HOST_PATH: '/opt/host/cert.pem',
      },
      root,
      app,
    ),
  ).toEqual({ KERNEL_CHECK_AFFECTED: revision });
});

test('unsupported host dependencies and destinations fail before a driver or native process starts', async () => {
  expect(() => workspacePath(root, '/outside/screenshots')).toThrow('inside the candidate workspace');
  expect(() => webCheckEnvironment({ WEB_TEST_STATE_DIR: '/outside/state' }, root, app)).toThrow();
  expect(
    webCheckEnvironment(
      { NATIVE_CONFIG_FILE: '/outside/config', EDITOR: '/usr/bin/vi', NVM_BIN: '/outside/bin', CI: '1' },
      root,
      app,
    ),
  ).toEqual({ CI: '1' });
  const f = fixture();
  await expect(
    routeWebCheck(fixtureRun(f, { root, cwd: app, command: ['bun', 'test', '/outside/test.ts'] }), {}, f.adapter),
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
  expect(
    await routeWebCheck(fixtureRun(f, { root, cwd: app, command: ['bun', 'test'] }), {}, f.adapter, controller.signal),
  ).toBe(143);
  expect(f.calls).toHaveLength(0);
  const active = new AbortController();
  const invoke = f.adapter.receiver.invoke;
  f.adapter.receiver.invoke = async (input) => {
    if (input.phase === 'run-prepared') {
      expect(input.signal).toBe(active.signal);
      active.abort();
    }
    return invoke(input);
  };
  expect(
    await routeWebCheck(fixtureRun(f, { root, cwd: app, command: ['bun', 'test'] }), {}, f.adapter, active.signal),
  ).toBe(143);
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
  expect(() => storybookLaunchPlan(['--web'], forged)).toThrow('finite test commands');
});
