import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readEnvironmentFile } from '../../../scripts/check-run.ts';
import {
  getCheckRunStatus,
  persistCheckRunPreparedInvocation,
  reconcileCheckRunInvocation,
  registerCheckRunInvocation,
} from '../../../scripts/check-run-settlement.ts';
import {
  reconcileWebCheckCustody,
  runPreparedWebCheck,
  runWebCheckDriverProcess,
  WEB_CHECK_RECOVERY_LIMITS,
  type PreparedCheckRunDescriptor,
  type WebCheckCustodyRuntime,
  type WebCheckDriverInvocation,
  type WebCheckDriverProcessRuntime,
  type WebCheckPrivateFiles,
} from './check-placement-custody.ts';

const root = resolve(import.meta.dir, '../../..');
const fixtures: string[] = [];
const revision = 'a'.repeat(40);
const physical = { host: 'a' as const, run: 'original-physical-run' };

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

function descriptorFor(
  input: WebCheckDriverInvocation,
  options: { wrongArgvBinding?: boolean } = {},
): PreparedCheckRunDescriptor {
  const prepared = parsePrepare(input.command);
  const environment = JSON.parse(readFileSync(prepared.environmentFile, 'utf8')) as Record<string, string>;
  const priority = input.env.REMOTE_CHECK_PRIORITY ?? null;
  const environmentHash = sha(
    JSON.stringify({ values: Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)), priority }),
  );
  const returns = [...new Set(prepared.returns)];
  const binding = {
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
  };
  if (options.wrongArgvBinding) binding.argvSha256 = sha('different request');
  return {
    schema: 1,
    type: 'check-run-preparation',
    invocationId: '11111111-1111-4111-8111-111111111111',
    nonce: 'b'.repeat(64),
    binding,
    cancellation: {
      file: join(dirname(prepared.descriptorFile), 'cancel.json'),
      id: '11111111-1111-4111-8111-111111111111',
    },
  };
}

function terminalMessages(
  descriptor: PreparedCheckRunDescriptor,
  exitCode: number,
  returns: string[],
  evidence: { sourceUnavailable?: boolean; returnFailure?: boolean } = {},
) {
  const receipt = {
    schema: 1,
    host: physical.host,
    run: physical.run,
    exitCode,
    lifetimeFailure: null,
    resources: null,
  };
  const receiptSha256 = sha(
    JSON.stringify({
      schema: receipt.schema,
      host: receipt.host,
      run: receipt.run,
      exitCode,
      lifetimeFailure: null,
    }),
  );
  const native = {
    schema: 1,
    type: 'native-terminal',
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    binding: descriptor.binding,
    physical,
    receipt,
  };
  const final = {
    schema: 1,
    type: 'final-settlement',
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    binding: descriptor.binding,
    physical,
    native: { exitCode, lifetimeFailure: false, receiptSha256 },
    preparedInputs: {
      status: evidence.sourceUnavailable ? 'unavailable' : 'verified',
      sourceSha256: evidence.sourceUnavailable ? null : descriptor.binding.sourceSha256,
      manifestSha256: evidence.sourceUnavailable ? null : 'f'.repeat(64),
      fileCount: 1,
      totalBytes: 1,
    },
    returns: {
      status: returns.length ? 'restored' : 'empty',
      declarationsSha256: descriptor.binding.returnsSha256,
      entries: returns.map((path) => ({ path, size: 0, sha256: sha('') })),
      missing: [],
      failures: evidence.returnFailure ? ['declared output could not be restored'] : [],
    },
    cleanup: {
      disposition: 'settled',
      remote: 'verified',
      transportChild: 'reaped',
      source: 'verified',
      localWorktree: 'removed',
      failures: [],
    },
    failures: { primary: [], cleanup: [] },
  };
  const nativeLine = `${JSON.stringify(native)}\n`;
  const finalLine = `${JSON.stringify(final)}\n`;
  return { native, final, nativeLine, finalLine, bytes: Buffer.from(nativeLine + finalLine) };
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
  const descriptorRaw = `${JSON.stringify(descriptor)}\n`;
  return {
    preparedExecution: {
      file: join(dirname(prepared.descriptorFile), 'prepared-execution.json'),
      sha256: sha('prepared execution bytes'),
    },
    descriptor: { file: prepared.descriptorFile, sha256: sha(descriptorRaw) },
    preparationIntent: null,
  };
}

function preparationStatusFor(
  descriptor: PreparedCheckRunDescriptor,
  prepared: ReturnType<typeof parsePrepare>,
  registration: ProducerReferences,
) {
  const snapshot = {
    workspace: '/frozen/original-run/workspace',
    scratch: '/frozen/original-run',
    sourceSha256: descriptor.binding.sourceSha256,
    inputFiles: [],
  };
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
    snapshot,
    candidateWorkspace: prepared.workspace,
    preparedExecution: registration.preparedExecution,
    descriptor: registration.descriptor,
    preparationIntent: registration.preparationIntent,
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
  prepared: ReturnType<typeof parsePrepare>,
  messages: ReturnType<typeof terminalMessages> | null,
  registration: ProducerReferences,
  options: {
    delivery?: 'delivered' | 'unknown' | 'pending' | 'reconciled';
    privateFiles?: 'settled' | 'pending' | 'unknown';
    reconciliation?: 'settled' | 'unknown';
    canceled?: boolean;
    omitFinal?: boolean;
    wrongFinalCustodyReference?: boolean;
  } = {},
) {
  const canceled = options.canceled ?? false;
  const snapshot = {
    workspace: '/frozen/original-run/workspace',
    scratch: '/frozen/original-run',
    sourceSha256: descriptor.binding.sourceSha256,
    inputFiles: [],
  };
  const native = messages
    ? {
        exitCode: messages.final.native.exitCode,
        lifetimeFailure: messages.final.native.lifetimeFailure,
        receiptSha256: messages.final.native.receiptSha256,
      }
    : null;
  const final = messages && !options.omitFinal ? messages.final : null;
  const custody =
    final && messages
      ? (() => {
          const identityCore = {
            bindingSha256: sha(JSON.stringify(descriptor.binding)),
            physical,
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
          const delivery = options.delivery ?? 'delivered';
          const privateFiles =
            options.privateFiles ?? (delivery === 'pending' || delivery === 'unknown' ? 'unknown' : 'settled');
          const reconciliation =
            options.reconciliation ?? (delivery === 'pending' || delivery === 'unknown' ? 'unknown' : 'settled');
          const unknown = delivery === 'unknown' || privateFiles === 'unknown' || reconciliation === 'unknown';
          const pending = delivery === 'pending' || privateFiles === 'pending';
          return {
            schema: 1,
            aggregate: unknown ? 'unknown' : pending ? 'pending' : 'settled',
            delivery,
            deliverySha256: sha(messages.finalLine.slice(0, -1)),
            privateFiles,
            reconciliation,
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
        })()
      : null;
  if (custody && options.wrongFinalCustodyReference)
    custody.identity.preparedExecutionReferenceSha256 = sha('foreign prepared execution reference');
  return {
    schema: 1,
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:01.000Z',
    phase: canceled
      ? 'cancelled'
      : custody?.aggregate === 'settled'
        ? 'settled'
        : final
          ? 'unknown'
          : 'native-terminal',
    binding: descriptor.binding,
    physical: canceled ? null : messages ? physical : null,
    transportChild: null,
    native: canceled ? null : native,
    snapshot,
    candidateWorkspace: prepared.workspace,
    preparedExecution: null,
    descriptor: registration.descriptor,
    preparationIntent: null,
    snapshotCustody: canceled ? 'removed' : final ? 'removed' : 'owned',
    returns: prepared.returns,
    cancellation: { requested: canceled, signal: canceled ? 15 : null },
    final,
    finalCustody: custody,
    failure: null,
  };
}

function fixture(
  options: {
    returns?: string[];
    nativeExitCode?: number;
    wrongPrepareBinding?: boolean;
    tamperNativeBinding?: boolean;
    tamperFinalBinding?: boolean;
    wrongRegistration?: boolean;
    missingFinal?: boolean;
    duplicateFinal?: boolean;
    partialFinal?: boolean;
    finalFirst?: boolean;
    wrongFinalCustodyReference?: boolean;
    sourceUnavailable?: boolean;
    returnFailure?: boolean;
    prepareUnknown?: boolean;
    delivery?: 'delivered' | 'unknown' | 'pending' | 'reconciled';
    reconcileDelivery?: 'delivered' | 'unknown' | 'pending' | 'reconciled';
    privateFiles?: 'settled' | 'pending' | 'unknown';
    reconciliation?: 'settled' | 'unknown';
    reconcilePrivateFiles?: 'settled' | 'pending' | 'unknown';
    reconcileReconciliation?: 'settled' | 'unknown';
    cancelOnPrepare?: AbortController;
    cancelOnRun?: AbortController;
    cancelBeforePhysical?: boolean;
    cleanupFailure?: Error;
    statusUnsettled?: boolean;
    reconcileUnsettled?: boolean;
  } = {},
) {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const fixtureRoot = mkdtempSync(join(root, '.temp', 'web-custody-fixture-'));
  fixtures.push(fixtureRoot);
  const workspace = join(fixtureRoot, 'candidate');
  const privateRoot = join(fixtureRoot, 'private');
  mkdirSync(join(workspace, 'apps/web'), { recursive: true });
  mkdirSync(join(workspace, '.temp'), { recursive: true });
  mkdirSync(privateRoot, { recursive: true });
  const hostsFile = join(privateRoot, 'hosts.json');
  writeFileSync(hostsFile, '{"hosts":[]}', { mode: 0o600 });
  const environment = { CI: '1', MESSAGE: 'bounded injected invocation' };
  const returns = options.returns ?? ['apps/web/report.json'];
  const filesDirectory = mkdtempSync(join(privateRoot, 'invocation-'));
  const environmentFile = join(filesDirectory, 'environment.json');
  const descriptorFile = join(filesDirectory, 'prepared-descriptor.json');
  const recordFile = join(filesDirectory, 'web-custody.json');
  const evidenceFile = join(filesDirectory, 'receipts.ndjson');
  writeFileSync(environmentFile, JSON.stringify(environment), { mode: 0o600 });
  writeFileSync(evidenceFile, '', { mode: 0o600 });
  let removed = false;
  const files: WebCheckPrivateFiles = {
    directory: filesDirectory,
    environmentFile,
    descriptorFile,
    recordFile,
    evidenceFile,
    close: () => {
      if (options.cleanupFailure) throw options.cleanupFailure;
      removed = true;
      rmSync(filesDirectory, { recursive: true, force: true });
    },
  };
  const input = {
    driverRoot: '/trusted/producer',
    hostsFile,
    workspace,
    cwd: 'apps/web',
    sourceRevision: revision,
    command: ['bun', 'test', 'tests/check-placement-custody.test.ts', '--test-name-pattern', 'original argv'],
    environment,
    priority: null,
    returns,
    env: { CI: '1' },
    files,
  };
  const invocations: WebCheckDriverInvocation[] = [];
  let descriptor: PreparedCheckRunDescriptor | undefined;
  let prepared: ReturnType<typeof parsePrepare> | undefined;
  let registration: ProducerReferences | undefined;
  let messages: ReturnType<typeof terminalMessages> | undefined;
  let lateRecoveryLifecycle: WebCheckDriverInvocation['onLifetime'] | undefined;
  let runFinalDelivery = options.delivery ?? 'delivered';
  const runtime: WebCheckCustodyRuntime = {
    async invoke(invocation) {
      invocations.push(invocation);
      if (invocation.phase === 'prepare') {
        prepared = parsePrepare(invocation.command);
        descriptor = descriptorFor(
          invocation,
          options.wrongPrepareBinding === undefined ? {} : { wrongArgvBinding: options.wrongPrepareBinding },
        );
        writeFileSync(descriptorFile, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
        registration = registrationFor(descriptor, prepared);
        options.cancelOnPrepare?.abort();
        return options.prepareUnknown
          ? { code: null, signal: null, closed: false, output: '', outputOverflow: false }
          : { code: 0, signal: null, closed: true, output: `${JSON.stringify(descriptor)}\n`, outputOverflow: false };
      }
      if (!descriptor || !prepared) return { code: 75, signal: null, closed: true, output: '', outputOverflow: false };
      if (invocation.phase === 'status' && !messages) {
        if (options.statusUnsettled) {
          invocation.onStart?.({ pid: 4242, startedAt: '2026-11-02T00:00:00.750Z' });
          lateRecoveryLifecycle = invocation.onLifetime;
          invocation.onLifetime?.({ parentClosed: true, outputClosed: false, groupClosed: null, timedOut: true });
          return {
            code: null,
            signal: 'SIGTERM',
            closed: false,
            output: '',
            outputOverflow: false,
            parentClosed: true,
            outputClosed: false,
            groupClosed: null,
            timedOut: true,
          };
        }
        const preparedStatus = preparationStatusFor(descriptor, prepared, registration!);
        if (options.wrongRegistration) preparedStatus.snapshot.sourceSha256 = sha('different frozen source');
        return {
          code: 0,
          signal: null,
          closed: true,
          output: `${JSON.stringify(preparedStatus)}\n`,
          outputOverflow: false,
        };
      }
      if (invocation.phase === 'run-prepared') {
        expect(existsSync(prepared.environmentFile)).toBe(true);
        const raw = terminalMessages(descriptor, options.nativeExitCode ?? 0, prepared.returns, options);
        const native = options.tamperNativeBinding
          ? { ...raw.native, binding: { ...descriptor.binding, argvSha256: sha('foreign binding') } }
          : raw.native;
        const final = options.tamperFinalBinding
          ? { ...raw.final, binding: { ...descriptor.binding, argvSha256: sha('foreign binding') } }
          : raw.final;
        const nativeLine = `${JSON.stringify(native)}\n`;
        const finalLine = `${JSON.stringify(final)}\n`;
        const bytes = options.finalFirst
          ? finalLine + nativeLine
          : nativeLine +
            (options.missingFinal
              ? ''
              : options.partialFinal
                ? finalLine.slice(0, -1)
                : finalLine + (options.duplicateFinal ? finalLine : ''));
        messages = { ...raw, native, final, nativeLine, finalLine, bytes: Buffer.from(bytes) };
        invocation.onReceipt?.(Buffer.from(messages.bytes));
        options.cancelOnRun?.abort();
        return { code: options.nativeExitCode ?? 0, signal: null, closed: true, output: '', outputOverflow: false };
      }
      if (options.cancelBeforePhysical && invocation.phase === 'reconcile') {
        const canceled = statusFor(descriptor, prepared, null, registration!, { canceled: true });
        return { code: 0, signal: null, closed: true, output: `${JSON.stringify(canceled)}\n`, outputOverflow: false };
      }
      if (!messages) return { code: 75, signal: null, closed: true, output: '', outputOverflow: false };
      if (invocation.phase === 'reconcile' && options.reconcileUnsettled) {
        invocation.onStart?.({ pid: 4343, startedAt: '2026-11-02T00:00:02.000Z' });
        invocation.onLifetime?.({ parentClosed: true, outputClosed: false, groupClosed: null, timedOut: true });
        return {
          code: null,
          signal: 'SIGTERM',
          closed: false,
          output: '',
          outputOverflow: false,
          parentClosed: true,
          outputClosed: false,
          groupClosed: null,
          timedOut: true,
        };
      }
      const delivery =
        invocation.phase === 'reconcile' ? (options.reconcileDelivery ?? runFinalDelivery) : runFinalDelivery;
      const omitFinal = invocation.phase === 'status' && options.missingFinal;
      const privateFiles =
        invocation.phase === 'reconcile'
          ? (options.reconcilePrivateFiles ?? options.privateFiles)
          : options.privateFiles;
      const reconciliation =
        invocation.phase === 'reconcile'
          ? (options.reconcileReconciliation ?? options.reconciliation)
          : options.reconciliation;
      const status = statusFor(descriptor, prepared, messages, registration!, {
        delivery,
        ...(privateFiles === undefined ? {} : { privateFiles }),
        ...(reconciliation === undefined ? {} : { reconciliation }),
        ...(omitFinal ? { omitFinal: true } : {}),
        ...(options.wrongFinalCustodyReference !== undefined
          ? { wrongFinalCustodyReference: options.wrongFinalCustodyReference }
          : {}),
      });
      return { code: 0, signal: null, closed: true, output: `${JSON.stringify(status)}\n`, outputOverflow: false };
    },
    cleanup: (privateFiles) => privateFiles.close(),
  };
  return {
    input,
    runtime,
    invocations,
    files,
    workspace,
    descriptor: () => descriptor!,
    setReconcileDelivery: (value: 'delivered' | 'unknown' | 'pending' | 'reconciled') => {
      options.reconcileDelivery = value;
    },
    setReconcileCustody: (privateFiles: 'settled' | 'pending' | 'unknown', reconciliation: 'settled' | 'unknown') => {
      options.reconcilePrivateFiles = privateFiles;
      options.reconcileReconciliation = reconciliation;
    },
    setRunDelivery: (value: 'delivered' | 'unknown' | 'pending' | 'reconciled') => {
      runFinalDelivery = value;
    },
    exists: () => existsSync(filesDirectory),
    wasRemoved: () => removed,
    settleLateRecovery: () => lateRecoveryLifecycle?.({ parentClosed: true, outputClosed: true, groupClosed: true }),
  };
}

function productionRecoveryFixture(probe: () => boolean | null, onSpawn: () => void = () => {}) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stdio: unknown[];
    kill: () => boolean;
  };
  const output = new EventEmitter();
  child.pid = 7878;
  child.stdout = output;
  child.stdio = [null, output, null];
  child.kill = () => true;
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const signals: NodeJS.Signals[] = [];
  const lifetimes: Array<Record<string, unknown>> = [];
  let spawnCount = 0;
  const processAdapter: WebCheckDriverProcessRuntime = {
    spawn: () => {
      spawnCount += 1;
      onSpawn();
      return child as never;
    },
    setTimer(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      (timer as { cleared: boolean }).cleared = true;
    },
    probeGroup: () => probe(),
    signalGroup: (_pid, signal) => {
      signals.push(signal);
      return true;
    },
    now: () => '2026-11-02T00:00:00.000Z',
  };
  return {
    child,
    output,
    timers,
    signals,
    lifetimes,
    processAdapter,
    spawnCount: () => spawnCount,
  };
}

test('prepare registers once, binds the prior Web request, then accepts the original FD 3 final', async () => {
  const f = fixture({ returns: ['apps/web/report.json'] });
  const result = await runPreparedWebCheck(f.input, f.runtime);

  expect(f.invocations.filter((call) => call.phase === 'prepare')).toHaveLength(1);
  expect(f.invocations.filter((call) => call.phase === 'status')).toHaveLength(2);
  expect(f.invocations.filter((call) => call.phase === 'run-prepared')).toHaveLength(1);
  expect(f.invocations.findIndex((call) => call.phase === 'status')).toBeLessThan(
    f.invocations.findIndex((call) => call.phase === 'run-prepared'),
  );
  const prepared = f.invocations.find((call) => call.phase === 'prepare')!;
  expect(prepared.command.slice(0, 5)).toEqual([
    'bun',
    join('/trusted/producer', 'scripts/check-run.ts'),
    'prepare',
    '--descriptor',
    f.files.descriptorFile,
  ]);
  const run = f.invocations.find((call) => call.phase === 'run-prepared')!;
  expect(run.command).toEqual([
    'bun',
    join('/trusted/producer', 'scripts/check-run.ts'),
    'run-prepared',
    '--descriptor',
    f.files.descriptorFile,
  ]);
  expect(run.env.REMOTE_CHECK_RECEIPT_FD).toBe('3');
  expect(run.env.REMOTE_CHECK_RECEIPT_NONCE).toBe(f.descriptor().nonce);
  expect(run.env.REMOTE_CHECK_INVOCATION_ID).toBe(f.descriptor().invocationId);
  expect(result).toMatchObject({
    code: 0,
    custody: 'settled',
    source: 'verified',
    returns: 'verified',
    finalCustody: 'settled',
    privateCleanup: 'settled',
  });
  expect(f.wasRemoved()).toBe(true);
});

test('wrong prior binding, rejected native/final and duplicate final never release private custody', async () => {
  const cases = [
    { wrongPrepareBinding: true },
    { tamperNativeBinding: true },
    { tamperFinalBinding: true },
    { duplicateFinal: true },
    { wrongRegistration: true },
  ];
  for (const options of cases) {
    const f = fixture(options);
    const result = await runPreparedWebCheck(f.input, f.runtime);
    expect(result.custody).toBe('occupied');
    expect(result.privateCleanup).toBe('retained');
    expect(f.wasRemoved()).toBe(false);
    expect(f.exists()).toBe(true);
    expect(f.invocations.filter((call) => call.phase === 'prepare')).toHaveLength(1);
    if (options.wrongPrepareBinding || options.wrongRegistration)
      expect(f.invocations.some((call) => call.phase === 'run-prepared')).toBe(false);
  }
});

test('missing final remains occupied unless original-descriptor reconciliation proves its exact final', async () => {
  const uncertain = fixture({ missingFinal: true, delivery: 'unknown', reconcileDelivery: 'unknown' });
  const first = await runPreparedWebCheck(uncertain.input, uncertain.runtime);
  expect(first).toMatchObject({
    code: 75,
    custody: 'occupied',
    nativeExitCode: 0,
    finalCustody: 'unknown',
    privateCleanup: 'retained',
  });
  expect(uncertain.wasRemoved()).toBe(false);
  expect(existsSync(uncertain.files.environmentFile)).toBe(false);
  const journal = JSON.parse(readFileSync(uncertain.files.recordFile, 'utf8')) as {
    caller: { prepare: { state: string }; run: { state: string } };
    ingress: { native: { state: string }; final: { state: string }; complete: boolean };
  };
  expect(journal).toMatchObject({
    caller: { prepare: { state: 'closed' }, run: { state: 'closed' } },
    ingress: { native: { state: 'received' }, final: { state: 'absent' }, complete: true },
  });
  const prepareCount = uncertain.invocations.filter((call) => call.phase === 'prepare').length;
  const runCount = uncertain.invocations.filter((call) => call.phase === 'run-prepared').length;

  uncertain.setReconcileDelivery('reconciled');
  const recovered = await reconcileWebCheckCustody(uncertain.files.descriptorFile, uncertain.runtime);
  expect(recovered).toMatchObject({ code: 0, custody: 'settled', finalCustody: 'settled', privateCleanup: 'settled' });
  expect(uncertain.invocations.filter((call) => call.phase === 'prepare')).toHaveLength(prepareCount);
  expect(uncertain.invocations.filter((call) => call.phase === 'run-prepared')).toHaveLength(runCount);
  expect(existsSync(uncertain.files.directory)).toBe(false);
});

test('partial, out-of-order and reference-forged final ingress remain occupied across original-run reconciliation', async () => {
  for (const options of [{ partialFinal: true }, { finalFirst: true }, { wrongFinalCustodyReference: true }]) {
    const f = fixture(options);
    const first = await runPreparedWebCheck(f.input, f.runtime);
    expect(first.custody).toBe('occupied');
    expect(f.exists()).toBe(true);
    const invocations = f.invocations.filter(
      (call) => call.phase === 'prepare' || call.phase === 'run-prepared',
    ).length;
    const reconciled = await reconcileWebCheckCustody(f.files.descriptorFile, f.runtime);
    expect(reconciled.custody).toBe('occupied');
    expect(f.invocations.filter((call) => call.phase === 'prepare' || call.phase === 'run-prepared')).toHaveLength(
      invocations,
    );
  }
});

test('source and return failures remain separately recorded and cannot release Web custody', async () => {
  const cases: Array<{ sourceUnavailable?: boolean; returnFailure?: boolean }> = [
    { sourceUnavailable: true },
    { returnFailure: true },
  ];
  for (const options of cases) {
    const f = fixture(options);
    const result = await runPreparedWebCheck(f.input, f.runtime);
    expect(result.custody).toBe('occupied');
    expect(result.privateCleanup).toBe('retained');
    expect(f.exists()).toBe(true);
    const journal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
      validation: { source: string; returns: string };
    };
    expect(journal.validation).toEqual({
      source: options.sourceUnavailable ? 'rejected' : 'verified',
      returns: options.returnFailure ? 'rejected' : 'verified',
    });
  }
});

test('original-descriptor reconciliation settles received final only after private custody becomes known', async () => {
  const f = fixture({
    delivery: 'delivered',
    privateFiles: 'unknown',
    reconciliation: 'unknown',
    reconcilePrivateFiles: 'unknown',
    reconcileReconciliation: 'unknown',
  });
  const first = await runPreparedWebCheck(f.input, f.runtime);
  expect(first).toMatchObject({ custody: 'occupied', finalCustody: 'unknown', privateCleanup: 'retained' });
  const journal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
    ingress: { native: { state: string }; final: { state: string } };
  };
  expect(journal.ingress).toMatchObject({ native: { state: 'received' }, final: { state: 'received' } });
  const preparedCount = f.invocations.filter((call) => call.phase === 'prepare').length;
  const runCount = f.invocations.filter((call) => call.phase === 'run-prepared').length;

  f.setReconcileCustody('settled', 'settled');
  const recovered = await reconcileWebCheckCustody(f.files.descriptorFile, f.runtime);
  expect(recovered).toMatchObject({ custody: 'settled', finalCustody: 'settled', privateCleanup: 'settled' });
  expect(f.invocations.filter((call) => call.phase === 'prepare')).toHaveLength(preparedCount);
  expect(f.invocations.filter((call) => call.phase === 'run-prepared')).toHaveLength(runCount);
});

test('pending delivery and private cleanup failure retain the descriptor and evidence', async () => {
  const pending = fixture({ delivery: 'pending', reconcileDelivery: 'pending' });
  const pendingResult = await runPreparedWebCheck(pending.input, pending.runtime);
  expect(pendingResult).toMatchObject({ custody: 'occupied', finalCustody: 'unknown', privateCleanup: 'retained' });
  expect(pending.exists()).toBe(true);

  const cleanupError = new Error('private cleanup unavailable');
  const cleanup = fixture({ cleanupFailure: cleanupError });
  const cleanupResult = await runPreparedWebCheck(cleanup.input, cleanup.runtime);
  expect(cleanupResult).toMatchObject({ code: 75, custody: 'occupied', privateCleanup: 'unknown' });
  expect(cleanup.exists()).toBe(true);
  expect(readFileSync(cleanup.files.evidenceFile, 'utf8')).toContain('native-terminal');

  const prepare = fixture({ prepareUnknown: true });
  const prepareResult = await runPreparedWebCheck(prepare.input, prepare.runtime);
  expect(prepareResult).toMatchObject({ custody: 'occupied', privateCleanup: 'retained' });
  expect(existsSync(prepare.files.environmentFile)).toBe(true);
  expect(prepare.invocations.some((call) => call.phase === 'run-prepared')).toBe(false);
  expect(prepare.exists()).toBe(true);
});

test('abort before dispatch does not prepare; abort after prepare reconciles and abort during run stays bounded', async () => {
  const before = fixture();
  const beforeAbort = new AbortController();
  beforeAbort.abort();
  const beforeResult = await runPreparedWebCheck(before.input, before.runtime, beforeAbort.signal);
  expect(beforeResult).toMatchObject({ code: 143, custody: 'settled', invocationId: null, privateCleanup: 'settled' });
  expect(before.invocations).toHaveLength(0);

  const after = fixture({ cancelBeforePhysical: true });
  const afterAbort = new AbortController();
  const afterPrepare = fixture({ cancelOnPrepare: afterAbort, cancelBeforePhysical: true });
  const afterResult = await runPreparedWebCheck(afterPrepare.input, afterPrepare.runtime, afterAbort.signal);
  expect(afterResult).toMatchObject({
    code: 143,
    custody: 'settled',
    cancellation: 'settled',
    finalCustody: 'unknown',
  });
  expect(afterPrepare.invocations.some((call) => call.phase === 'run-prepared')).toBe(false);
  expect(afterPrepare.invocations.some((call) => call.phase === 'reconcile')).toBe(true);
  expect(afterPrepare.wasRemoved()).toBe(true);
  expect(after.invocations).toHaveLength(0);

  const during = fixture();
  const duringAbort = new AbortController();
  const abortDuringRun = fixture({ cancelOnRun: duringAbort });
  const duringResult = await runPreparedWebCheck(abortDuringRun.input, abortDuringRun.runtime, duringAbort.signal);
  expect(duringResult).toMatchObject({
    code: 143,
    custody: 'settled',
    cancellation: 'settled',
    privateCleanup: 'settled',
  });
  const recoveryCall = abortDuringRun.invocations.find((call) => call.phase === 'reconcile');
  expect(recoveryCall?.signal).toBeUndefined();
  expect(recoveryCall?.limits).toEqual(WEB_CHECK_RECOVERY_LIMITS);
});

test('original native failure is preserved after settlement and while final custody remains unknown', async () => {
  const settledFailure = fixture({ nativeExitCode: 17 });
  const settled = await runPreparedWebCheck(settledFailure.input, settledFailure.runtime);
  expect(settled).toMatchObject({ code: 17, custody: 'settled', nativeExitCode: 17, privateCleanup: 'settled' });

  const retainedFailure = fixture({ nativeExitCode: 17, delivery: 'unknown', reconcileDelivery: 'unknown' });
  const retained = await runPreparedWebCheck(retainedFailure.input, retainedFailure.runtime);
  expect(retained).toMatchObject({ code: 17, custody: 'occupied', nativeExitCode: 17, privateCleanup: 'retained' });
  expect(retainedFailure.exists()).toBe(true);
});

test('hung registration status keeps its helper identity and blocks a duplicate recovery helper', async () => {
  const f = fixture({ statusUnsettled: true });
  const result = await runPreparedWebCheck(f.input, f.runtime);
  expect(result).toMatchObject({ custody: 'occupied', privateCleanup: 'retained' });
  expect(f.invocations.filter((call) => call.phase === 'prepare')).toHaveLength(1);
  expect(f.invocations.filter((call) => call.phase === 'run-prepared')).toHaveLength(0);
  expect(f.invocations.filter((call) => call.phase === 'status')).toHaveLength(1);
  expect(f.invocations[0]?.limits).toBeUndefined();
  const statusCall = f.invocations.find((call) => call.phase === 'status')!;
  expect(statusCall.limits).toEqual(WEB_CHECK_RECOVERY_LIMITS);
  expect(f.invocations.filter((call) => call.phase === 'reconcile')).toHaveLength(0);
  const journal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
    recovery: Array<Record<string, unknown>>;
  };
  expect(journal.recovery).toHaveLength(1);
  expect(journal.recovery[0]).toMatchObject({
    operation: 'status',
    pid: 4242,
    state: 'unknown',
    parentClosed: true,
    outputClosed: false,
    groupClosed: null,
    timedOut: true,
  });
  expect(f.wasRemoved()).toBe(false);
});

test('production status timeout remains occupied through composition and late closure only updates its journal', async () => {
  const f = fixture();
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stdio: unknown[];
    kill: () => boolean;
  };
  const output = new EventEmitter();
  child.pid = 5151;
  child.stdout = output;
  child.stdio = [null, output, null];
  child.kill = () => true;
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = () => resolve();
  });
  const processAdapter: WebCheckDriverProcessRuntime = {
    spawn: () => {
      markSpawned();
      return child as never;
    },
    setTimer(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      (timer as { cleared: boolean }).cleared = true;
    },
    probeGroup: () => false,
    signalGroup: (_pid, signal) => signal === 'SIGTERM',
    now: () => '2026-11-02T00:00:00.000Z',
  };
  const originalInvoke = f.runtime.invoke.bind(f.runtime);
  f.runtime.invoke = (invocation) =>
    invocation.phase === 'status' ? runWebCheckDriverProcess(invocation, processAdapter) : originalInvoke(invocation);

  const pending = runPreparedWebCheck(f.input, f.runtime);
  await spawned;
  expect(timers[0]?.delayMs).toBe(WEB_CHECK_RECOVERY_LIMITS.observationMs);
  timers[0]!.callback();
  timers[1]!.callback();
  timers[2]!.callback();
  expect(timers[3]?.delayMs).toBe(WEB_CHECK_RECOVERY_LIMITS.outputSettleMs);
  timers[3]!.callback();
  const result = await pending;
  expect(result).toMatchObject({ custody: 'occupied', privateCleanup: 'retained', code: 75 });
  expect(f.invocations.filter((call) => call.phase === 'prepare')).toHaveLength(1);
  expect(f.invocations.filter((call) => call.phase === 'run-prepared')).toHaveLength(0);
  expect(f.invocations.filter((call) => call.phase === 'reconcile')).toHaveLength(0);
  const journal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
    recovery: Array<Record<string, unknown>>;
  };
  expect(journal.recovery[0]).toMatchObject({
    pid: 5151,
    state: 'unknown',
    timedOut: true,
    parentClosed: false,
    outputClosed: false,
    groupClosed: true,
  });

  const timerCount = timers.length;
  child.emit('exit', 0, null);
  output.emit('close');
  expect(timers).toHaveLength(timerCount);
  const lateJournal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
    recovery: Array<Record<string, unknown>>;
  };
  expect(lateJournal.recovery[0]).toMatchObject({
    state: 'closed',
    parentClosed: true,
    outputClosed: true,
    groupClosed: true,
  });
  expect(f.wasRemoved()).toBe(false);
});

test('hung reconciliation after parent exit retains unresolved output and private custody', async () => {
  const f = fixture({ privateFiles: 'unknown', reconcileUnsettled: true });
  const result = await runPreparedWebCheck(f.input, f.runtime);
  expect(result).toMatchObject({ custody: 'occupied', privateCleanup: 'retained' });
  expect(f.invocations.filter((call) => call.phase === 'prepare')).toHaveLength(1);
  expect(f.invocations.filter((call) => call.phase === 'run-prepared')).toHaveLength(1);
  expect(f.invocations.filter((call) => call.phase === 'reconcile')).toHaveLength(1);
  const journal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
    recovery: Array<Record<string, unknown>>;
  };
  expect(journal.recovery.at(-1)).toMatchObject({
    operation: 'reconcile',
    pid: 4343,
    state: 'unknown',
    parentClosed: true,
    outputClosed: false,
    groupClosed: null,
    timedOut: true,
  });
  expect(f.wasRemoved()).toBe(false);
});

test('late output close updates durable helper closure without disposing until explicit recovery', async () => {
  const f = fixture({ statusUnsettled: true });
  const result = await runPreparedWebCheck(f.input, f.runtime);
  expect(result.custody).toBe('occupied');
  let journal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
    recovery: Array<Record<string, unknown>>;
  };
  expect(journal.recovery[0]).toMatchObject({ state: 'unknown', parentClosed: true, outputClosed: false });

  f.settleLateRecovery();
  journal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
    recovery: Array<Record<string, unknown>>;
  };
  expect(journal.recovery[0]).toMatchObject({
    state: 'closed',
    parentClosed: true,
    outputClosed: true,
    groupClosed: true,
  });
  expect(f.wasRemoved()).toBe(false);
});

test('production helper lifetime waits separately for output after parent exit and records late closure', async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stdio: unknown[];
    kill: () => boolean;
  };
  const output = new EventEmitter();
  child.pid = 5678;
  child.stdout = output;
  child.stdio = [null, output, null];
  child.kill = () => true;
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const lifetimes: Array<Record<string, unknown>> = [];
  const processAdapter: WebCheckDriverProcessRuntime = {
    spawn: () => child as never,
    setTimer(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      (timer as { cleared: boolean }).cleared = true;
    },
    probeGroup: () => false,
    signalGroup: () => false,
    now: () => '2026-11-02T00:00:00.000Z',
  };
  const pending = runWebCheckDriverProcess(
    {
      phase: 'status',
      command: ['bun', 'status'],
      cwd: '/candidate',
      env: {},
      limits: WEB_CHECK_RECOVERY_LIMITS,
      onLifetime: (lifetime) => lifetimes.push(lifetime),
    },
    processAdapter,
  );
  child.emit('exit', 0, null);
  expect(timers.some((timer) => timer.delayMs === WEB_CHECK_RECOVERY_LIMITS.outputSettleMs && !timer.cleared)).toBe(
    true,
  );
  const outputDeadline = timers.find(
    (timer) => timer.delayMs === WEB_CHECK_RECOVERY_LIMITS.outputSettleMs && !timer.cleared,
  )!;
  outputDeadline.callback();
  const result = await pending;
  expect(result).toMatchObject({
    closed: false,
    parentClosed: true,
    outputClosed: false,
    groupClosed: true,
  });
  expect(timers.every((timer) => timer.cleared || timer === outputDeadline)).toBe(true);

  output.emit('close');
  expect(lifetimes.at(-1)).toMatchObject({ parentClosed: true, outputClosed: true, groupClosed: true });
});

test('production helper timeout bounds group termination and never rearms timers after unresolved return', async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stdio: unknown[];
    kill: () => boolean;
  };
  const output = new EventEmitter();
  child.pid = 6789;
  child.stdout = output;
  child.stdio = [null, output, null];
  child.kill = () => true;
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const signals: NodeJS.Signals[] = [];
  const lifetimes: Array<Record<string, unknown>> = [];
  const processAdapter: WebCheckDriverProcessRuntime = {
    spawn: () => child as never,
    setTimer(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      (timer as { cleared: boolean }).cleared = true;
    },
    probeGroup: () => false,
    signalGroup: (_pid, signal) => {
      signals.push(signal);
      return signal === 'SIGTERM';
    },
    now: () => '2026-11-02T00:00:00.000Z',
  };
  const pending = runWebCheckDriverProcess(
    {
      phase: 'reconcile',
      command: ['bun', 'reconcile'],
      cwd: '/candidate',
      env: {},
      limits: WEB_CHECK_RECOVERY_LIMITS,
      onLifetime: (lifetime) => lifetimes.push(lifetime),
    },
    processAdapter,
  );

  const observation = timers.find((timer) => timer.delayMs === WEB_CHECK_RECOVERY_LIMITS.observationMs)!;
  observation.callback();
  expect(signals).toEqual(['SIGTERM']);
  const grace = timers.find(
    (timer) => timer.delayMs === WEB_CHECK_RECOVERY_LIMITS.terminationGraceMs && !timer.cleared,
  )!;
  grace.callback();
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  const settle = timers.find(
    (timer) => timer.delayMs === WEB_CHECK_RECOVERY_LIMITS.terminationSettleMs && !timer.cleared,
  )!;
  settle.callback();
  const outputDeadline = timers.find((timer) => timer.delayMs === WEB_CHECK_RECOVERY_LIMITS.outputSettleMs)!;
  outputDeadline.callback();

  const result = await pending;
  expect(result).toMatchObject({
    code: null,
    closed: false,
    timedOut: true,
    parentClosed: false,
    outputClosed: false,
    groupClosed: true,
  });
  const timerCount = timers.length;
  child.emit('exit', 75, null);
  output.emit('close');
  expect(timers).toHaveLength(timerCount);
  expect(lifetimes.at(-1)).toMatchObject({ parentClosed: true, outputClosed: true, groupClosed: true, timedOut: true });
});

test('closed output still gets final settlement, keeps one helper occupied, and journals late parent closure', async () => {
  const f = fixture();
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = () => resolve();
  });
  const process = productionRecoveryFixture(() => false, markSpawned);
  const originalInvoke = f.runtime.invoke.bind(f.runtime);
  let statusCalls = 0;
  f.runtime.invoke = (invocation) => {
    if (invocation.phase === 'status' && ++statusCalls === 2)
      return runWebCheckDriverProcess(invocation, process.processAdapter);
    return originalInvoke(invocation);
  };

  const pending = runPreparedWebCheck(f.input, f.runtime);
  await spawned;
  process.output.emit('close');
  const observation = process.timers.find((timer) => timer.delayMs === WEB_CHECK_RECOVERY_LIMITS.observationMs)!;
  observation.callback();
  expect(process.signals).toEqual(['SIGTERM']);
  process.timers[1]!.callback();
  expect(process.signals).toEqual(['SIGTERM', 'SIGKILL']);
  process.timers[2]!.callback();
  expect(process.timers[3]?.delayMs).toBe(WEB_CHECK_RECOVERY_LIMITS.outputSettleMs);
  process.timers[3]!.callback();

  const result = await pending;
  expect(result).toMatchObject({ custody: 'occupied', privateCleanup: 'retained', code: 75 });
  expect(process.spawnCount()).toBe(1);
  let journal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
    recovery: Array<Record<string, unknown>>;
  };
  expect(journal.recovery).toHaveLength(1);
  expect(journal.recovery[0]).toMatchObject({
    state: 'unknown',
    parentClosed: false,
    outputClosed: true,
    groupClosed: true,
    timedOut: true,
  });
  expect(f.wasRemoved()).toBe(false);

  const again = await reconcileWebCheckCustody(f.files.descriptorFile, f.runtime);
  expect(again).toMatchObject({ custody: 'occupied', privateCleanup: 'retained' });
  expect(process.spawnCount()).toBe(1);

  const timerCount = process.timers.length;
  process.child.emit('exit', 0, null);
  expect(process.timers).toHaveLength(timerCount);
  journal = JSON.parse(readFileSync(f.files.recordFile, 'utf8')) as {
    recovery: Array<Record<string, unknown>>;
  };
  expect(journal.recovery[0]).toMatchObject({
    state: 'closed',
    parentClosed: true,
    outputClosed: true,
    groupClosed: true,
  });
  expect(f.exists()).toBe(true);
  expect(f.wasRemoved()).toBe(false);
});

test('closed output and exited parent do not settle a live process group after the final deadline', async () => {
  let groupPresent = true;
  const process = productionRecoveryFixture(() => groupPresent);
  const lifetimes = process.lifetimes;
  const pending = runWebCheckDriverProcess(
    {
      phase: 'status',
      command: ['bun', 'status'],
      cwd: '/candidate',
      env: {},
      limits: WEB_CHECK_RECOVERY_LIMITS,
      onLifetime: (lifetime) => lifetimes.push(lifetime),
    },
    process.processAdapter,
  );

  process.output.emit('close');
  process.child.emit('exit', 0, null);
  expect(process.signals).toEqual(['SIGTERM']);
  process.timers[1]!.callback();
  expect(process.signals).toEqual(['SIGTERM', 'SIGKILL']);
  process.timers[2]!.callback();
  expect(process.timers[3]?.delayMs).toBe(WEB_CHECK_RECOVERY_LIMITS.outputSettleMs);
  process.timers[3]!.callback();

  const result = await pending;
  expect(result).toMatchObject({
    closed: false,
    parentClosed: true,
    outputClosed: true,
    groupClosed: false,
  });
  const timerCount = process.timers.length;
  groupPresent = false;
  process.child.emit('close', 0, null);
  expect(process.timers).toHaveLength(timerCount);
  expect(lifetimes.at(-1)).toMatchObject({ parentClosed: true, outputClosed: true, groupClosed: true });
});

test('closed output and parent with unknown group return boundedly and preserve late group evidence', async () => {
  let groupPresent: boolean | null = null;
  const process = productionRecoveryFixture(() => groupPresent);
  const lifetimes = process.lifetimes;
  const pending = runWebCheckDriverProcess(
    {
      phase: 'reconcile',
      command: ['bun', 'reconcile'],
      cwd: '/candidate',
      env: {},
      limits: WEB_CHECK_RECOVERY_LIMITS,
      onLifetime: (lifetime) => lifetimes.push(lifetime),
    },
    process.processAdapter,
  );

  process.output.emit('close');
  process.child.emit('exit', 0, null);
  expect(process.signals).toEqual([]);
  expect(process.timers[1]?.delayMs).toBe(WEB_CHECK_RECOVERY_LIMITS.outputSettleMs);
  process.timers[1]!.callback();

  const result = await pending;
  expect(result).toMatchObject({
    closed: false,
    parentClosed: true,
    outputClosed: true,
    groupClosed: null,
  });
  const timerCount = process.timers.length;
  groupPresent = false;
  process.child.emit('close', 0, null);
  expect(process.timers).toHaveLength(timerCount);
  expect(lifetimes.at(-1)).toMatchObject({ parentClosed: true, outputClosed: true, groupClosed: true });
});

test('an explicit driver environment file keeps affected selection and prepared custody round-trips maximum inventories', async () => {
  const parent = mkdtempSync(join(root, '.temp', 'check-run-bounds-'));
  fixtures.push(parent);
  const candidateWorkspace = join(parent, 'candidate');
  const stateDirectory = join(parent, 'state');
  const descriptorDirectory = join(parent, 'private');
  mkdirSync(candidateWorkspace);
  mkdirSync(descriptorDirectory, { mode: 0o700 });
  const environmentFile = join(parent, 'environment.json');
  writeFileSync(
    environmentFile,
    JSON.stringify({
      KERNEL_CHECK_AFFECTED: revision,
      KERNEL_CHECK_REMOTE: '1',
      NODE: '/usr/bin/node',
      NVM_INC: '/home/worker/.nvm/include/node',
      npm_config_prefix: '/home/worker/.npm',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/run/user/1000/Xauthority',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      DEBUGINFOD_IMA_CERT_PATH: 'none',
      MOZ_GMP_PATH: '/usr/lib/mozilla/plugins',
    }),
    { mode: 0o600 },
  );
  expect(readEnvironmentFile(environmentFile, candidateWorkspace)).toEqual({ KERNEL_CHECK_AFFECTED: revision });

  const sourceSha256 = 'c'.repeat(64);
  const binding = {
    sourceRevision: revision,
    indexTree: revision,
    sourceSha256,
    argvSha256: sha('argv'),
    cwd: 'apps/web',
    semanticEnvironmentSha256: sha('semantic'),
    relocatedEnvironmentSha256: sha('relocated'),
    producerClosureSha256: sha('producer'),
    hostsSha256: sha('hosts'),
    preparationCommandsSha256: sha('preparation'),
    returnsSha256: sha('[]'),
  };
  const inventories = [
    Array.from({ length: 50_000 }, (_, index) => `src/file-${index}.ts`),
    Array.from({ length: 8_100 }, (_, index) => `src/${String(index).padStart(4, '0')}/${'a'.repeat(1_008)}`),
  ];
  expect(Buffer.byteLength(JSON.stringify(inventories[1])) + 64 * 1024).toBeLessThan(8 * 1024 * 1024);
  for (const inputFiles of inventories) {
    const registration = await registerCheckRunInvocation(binding, {
      stateDirectory,
      candidateWorkspace,
      snapshot: { workspace: candidateWorkspace, scratch: parent, sourceSha256, inputFiles },
      returns: [],
    });
    const descriptorFile = join(descriptorDirectory, `${registration.invocationId}.json`);
    await persistCheckRunPreparedInvocation(registration, {
      stateDirectory,
      candidateWorkspace,
      snapshot: { workspace: candidateWorkspace, scratch: parent, sourceSha256, inputFiles },
      returns: [],
      descriptorFile,
      execution: {},
    });
    const expected = sha(JSON.stringify(inputFiles));
    const prepared = await getCheckRunStatus(registration.invocationId, { stateDirectory });
    expect(sha(JSON.stringify(prepared.snapshot?.inputFiles))).toBe(expected);
    const reconciled = await reconcileCheckRunInvocation(registration.invocationId, { stateDirectory });
    expect(reconciled.phase).toBe('unknown');
    expect(sha(JSON.stringify(reconciled.snapshot?.inputFiles))).toBe(expected);
  }
});
