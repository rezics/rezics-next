import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runPreparedWebCheck,
  type PreparedCheckRunDescriptor,
  type WebCheckCustodyRuntime,
  type WebCheckDriverInvocation,
  type WebCheckPrivateFiles,
} from './check-placement-custody.ts';

const root = resolve(import.meta.dir, '../../..');
const fixtures: string[] = [];
const revision = 'a'.repeat(40);

afterAll(() => {
  for (const directory of fixtures) rmSync(directory, { recursive: true, force: true });
});

function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsePrepare(command: string[]) {
  const value = (name: string) => command[command.indexOf(name) + 1]!;
  const separator = command.indexOf('--');
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
  const prepared = parsePrepare(input.command);
  const environment = JSON.parse(readFileSync(prepared.environmentFile, 'utf8')) as Record<string, string>;
  const priority = input.env.REMOTE_CHECK_PRIORITY ?? null;
  const environmentHash = sha(
    JSON.stringify({ values: Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)), priority }),
  );
  const returns = [...new Set(prepared.returns)];
  return {
    schema: 1,
    type: 'check-run-preparation',
    invocationId: '11111111-1111-4111-8111-111111111111',
    nonce: 'b'.repeat(64),
    binding: {
      sourceRevision: prepared.sourceRevision,
      indexTree: prepared.sourceRevision,
      sourceSha256: 'c'.repeat(64),
      argvSha256: sha(JSON.stringify(prepared.command)),
      cwd: prepared.cwd,
      semanticEnvironmentSha256: environmentHash,
      relocatedEnvironmentSha256: environmentHash,
      producerClosureSha256: 'd'.repeat(64),
      hostsSha256: sha(readFileSync(prepared.hostsFile)),
      preparationCommandsSha256: 'e'.repeat(64),
      returnsSha256: sha(JSON.stringify(returns)),
    },
    cancellation: {
      file: join(prepared.descriptorFile, '..', 'cancel.json'),
      id: '11111111-1111-4111-8111-111111111111',
    },
  };
}

function fixture(
  options: {
    nativeExitCode?: number;
    wrongPrepareBinding?: boolean;
    prepareUnknown?: boolean;
    leftoverOccupied?: boolean;
    leftoverJournal?: string;
    cleanupFailure?: Error;
    cancelOnPrepare?: AbortController;
    cancelOnRun?: AbortController;
    runThrow?: Error;
  } = {},
) {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const fixtureRoot = mkdtempSync(join(root, '.temp', 'web-custody-fixture-'));
  fixtures.push(fixtureRoot);
  const workspace = join(fixtureRoot, 'candidate');
  const privateRoot = join(fixtureRoot, 'private');
  mkdirSync(join(workspace, 'apps/web'), { recursive: true });
  mkdirSync(privateRoot, { recursive: true });
  const hostsFile = join(privateRoot, 'hosts.json');
  writeFileSync(hostsFile, '{"hosts":[]}', { mode: 0o600 });
  const environment = { CI: '1', MESSAGE: 'bounded injected invocation' };
  const filesDirectory = mkdtempSync(join(privateRoot, 'invocation-'));
  const environmentFile = join(filesDirectory, 'environment.json');
  const descriptorFile = join(filesDirectory, 'prepared-descriptor.json');
  writeFileSync(environmentFile, JSON.stringify(environment), { mode: 0o600 });
  if (options.leftoverOccupied) {
    writeFileSync(
      join(filesDirectory, 'web-custody.json'),
      `${JSON.stringify({
        schema: 1,
        type: 'web-check-custody',
        custody: 'occupied',
        nativeExitCode: null,
        failure: 'invocation custody occupied; source/returns/finalCustody/cancellation unknown',
      })}\n`,
      { mode: 0o600 },
    );
  }
  if (options.leftoverJournal) {
    writeFileSync(join(filesDirectory, 'web-custody.json'), options.leftoverJournal, { mode: 0o600 });
    writeFileSync(descriptorFile, '{"stale":true}\n', { mode: 0o600 });
  }
  let removed = false;
  const files: WebCheckPrivateFiles = {
    directory: filesDirectory,
    environmentFile,
    descriptorFile,
    close: () => {
      if (options.cleanupFailure) throw options.cleanupFailure;
      removed = true;
      rmSync(filesDirectory, { recursive: true, force: true });
    },
  };
  const invocations: WebCheckDriverInvocation[] = [];
  let descriptor: PreparedCheckRunDescriptor | undefined;
  const runtime: WebCheckCustodyRuntime = {
    async invoke(invocation) {
      invocations.push(invocation);
      if (invocation.phase === 'prepare') {
        descriptor = descriptorFor(invocation);
        if (options.wrongPrepareBinding) descriptor.binding.argvSha256 = sha('different request');
        writeFileSync(descriptorFile, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
        options.cancelOnPrepare?.abort();
        return options.prepareUnknown
          ? { code: null, signal: null, closed: false, output: '', outputOverflow: false }
          : { code: 0, signal: null, closed: true, output: `${JSON.stringify(descriptor)}\n`, outputOverflow: false };
      }
      if (options.runThrow) throw options.runThrow;
      options.cancelOnRun?.abort();
      return {
        code: options.nativeExitCode ?? 0,
        signal: null,
        closed: true,
        output: '',
        outputOverflow: false,
      };
    },
    cleanup: (privateFiles) => privateFiles.close(),
  };
  return {
    input: {
      driverRoot: '/trusted/producer',
      hostsFile,
      workspace,
      cwd: 'apps/web',
      sourceRevision: revision,
      command: ['bun', 'test', 'tests/check-placement-custody.test.ts', '--test-name-pattern', 'original argv'],
      environment,
      priority: null,
      returns: ['apps/web/report.json'],
      env: { CI: '1' },
      files,
    },
    runtime,
    invocations,
    files,
    descriptor: () => descriptor!,
    exists: () => existsSync(filesDirectory),
    wasRemoved: () => removed,
  };
}

test('prepare binds the request then run-prepared reports this invocation and removes private files', async () => {
  const f = fixture();
  const result = await runPreparedWebCheck(f.input, f.runtime);
  expect(f.invocations.map((call) => call.phase)).toEqual(['prepare', 'run-prepared']);
  expect(f.invocations[0]!.command.slice(0, 5)).toEqual([
    'bun',
    join('/trusted/producer', 'scripts/check-run.ts'),
    'prepare',
    '--descriptor',
    f.files.descriptorFile,
  ]);
  expect(f.invocations[1]!.command).toEqual([
    'bun',
    join('/trusted/producer', 'scripts/check-run.ts'),
    'run-prepared',
    '--descriptor',
    f.files.descriptorFile,
  ]);
  expect(f.invocations[1]!.env.REMOTE_CHECK_RECEIPT_FD).toBe('3');
  expect(f.invocations[1]!.env.REMOTE_CHECK_RECEIPT_NONCE).toBe(f.descriptor().nonce);
  expect(f.invocations[1]!.env.REMOTE_CHECK_INVOCATION_ID).toBe(f.descriptor().invocationId);
  expect(result).toEqual({
    code: 0,
    invocationId: f.descriptor().invocationId,
    descriptorFile: f.files.descriptorFile,
  });
  expect(f.wasRemoved()).toBe(true);
});

test('with an earlier invocation occupied or unknown, a new check starts fresh and reports its own result', async () => {
  const occupied = fixture({ leftoverOccupied: true, prepareUnknown: true });
  const occupiedResult = await runPreparedWebCheck(occupied.input, occupied.runtime);
  expect(occupiedResult.code).toBe(75);
  expect(occupied.invocations.filter((call) => call.phase === 'run-prepared')).toHaveLength(0);

  const unknownReceipt = fixture({ leftoverOccupied: true, nativeExitCode: 17 });
  const unknownResult = await runPreparedWebCheck(unknownReceipt.input, unknownReceipt.runtime);
  expect(unknownResult.code).toBe(17);
  expect(unknownReceipt.invocations.map((call) => call.phase)).toEqual(['prepare', 'run-prepared']);

  const next = fixture();
  const nextResult = await runPreparedWebCheck(next.input, next.runtime);
  expect(nextResult.code).toBe(0);
  expect(next.invocations.map((call) => call.phase)).toEqual(['prepare', 'run-prepared']);
  expect(next.files.directory).not.toBe(occupied.files.directory);
  expect(next.files.directory).not.toBe(unknownReceipt.files.directory);
});

test('a stale descriptor or journal is ignored or cleaned up, never a reason to refuse', async () => {
  const stale = fixture({
    leftoverJournal: `${JSON.stringify({ custody: 'occupied', nativeExitCode: null })}\n`,
  });
  const result = await runPreparedWebCheck(stale.input, stale.runtime);
  expect(result.code).toBe(0);
  expect(stale.invocations.map((call) => call.phase)).toEqual(['prepare', 'run-prepared']);
  expect(stale.wasRemoved()).toBe(true);
  expect(stale.exists()).toBe(false);
});

test('this invocation keeps its native exit when receipts are unknown and when private cleanup fails', async () => {
  const unknown = fixture({ nativeExitCode: 17, leftoverOccupied: true });
  expect(await runPreparedWebCheck(unknown.input, unknown.runtime)).toMatchObject({ code: 17 });
  expect(unknown.wasRemoved()).toBe(true);

  const cleanup = fixture({ nativeExitCode: 17, cleanupFailure: new Error('private cleanup unavailable') });
  expect(await runPreparedWebCheck(cleanup.input, cleanup.runtime)).toMatchObject({ code: 17 });
  expect(cleanup.exists()).toBe(true);
});

test('wrong prepare binding and a transport throw return this invocation without blocking a later one', async () => {
  const wrong = fixture({ wrongPrepareBinding: true });
  expect(await runPreparedWebCheck(wrong.input, wrong.runtime)).toMatchObject({ code: 75, invocationId: null });
  expect(wrong.invocations.some((call) => call.phase === 'run-prepared')).toBe(false);
  expect(wrong.wasRemoved()).toBe(true);

  const transport = fixture({ runThrow: new Error('transport terminality unknown') });
  expect(await runPreparedWebCheck(transport.input, transport.runtime)).toMatchObject({ code: 75 });
  expect(transport.invocations.filter((call) => call.phase === 'run-prepared')).toHaveLength(1);

  const retry = fixture();
  expect(await runPreparedWebCheck(retry.input, retry.runtime)).toMatchObject({ code: 0 });
  expect(retry.invocations.map((call) => call.phase)).toEqual(['prepare', 'run-prepared']);
});

test('abort before dispatch does not prepare; abort after prepare or during run still reports this invocation', async () => {
  const before = fixture();
  const beforeAbort = new AbortController();
  beforeAbort.abort();
  const beforeResult = await runPreparedWebCheck(before.input, before.runtime, beforeAbort.signal);
  expect(beforeResult).toMatchObject({ code: 143, invocationId: null });
  expect(before.invocations).toHaveLength(0);

  const afterAbort = new AbortController();
  const afterPrepare = fixture({ cancelOnPrepare: afterAbort });
  const afterResult = await runPreparedWebCheck(afterPrepare.input, afterPrepare.runtime, afterAbort.signal);
  expect(afterResult.code).toBe(143);
  expect(afterPrepare.invocations.some((call) => call.phase === 'run-prepared')).toBe(false);

  const duringAbort = new AbortController();
  const during = fixture({ cancelOnRun: duringAbort });
  const duringResult = await runPreparedWebCheck(during.input, during.runtime, duringAbort.signal);
  expect(duringResult.code).toBe(143);
});
