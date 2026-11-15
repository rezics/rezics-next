import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  discardRegisteredCheckRunFailedSnapshot,
  prepareCandidateSnapshot,
  maintainCheckRunSnapshots,
  reapRetainedTransportChild,
  reconcileCheckRunPreparationIntent,
  reconcileRegisteredCheckRun,
  reconcileCheckRunPhysicalCleanup,
} from './check-run.ts';
import {
  acceptCheckRunFinalSettlement,
  acceptCheckRunPhysicalCleanup,
  allocateCheckRunPhysical,
  beginCheckRunAllocation,
  cancelCheckRunInvocation,
  claimCheckRunPreparedInvocation,
  checkRunPreparationIntentFile,
  createCheckRunFinalSettlement,
  discardCheckRunFailedSnapshot,
  checkRunBindingHash,
  checkRunSnapshotReleaseKind,
  discardCheckRunPreparationIntent,
  encodeCheckRunFinalSettlement,
  getCheckRunStatus,
  markCheckRunFinalSettlementDelivery,
  markCheckRunNativeTerminal,
  markCheckRunQueued,
  persistCheckRunPreparedInvocation,
  reconcileCheckRunInvocation,
  registerCheckRunInvocation,
  stageCheckRunFinalSettlement,
  setCheckRunUnknown,
  withCheckRunSpawnPermit,
  writeCheckRunPreparationIntent,
  type CheckRunFinalSettlement,
  type CheckRunInvocationBinding,
  type CheckRunRegistration,
  type CheckRunTransportChildIdentity,
} from './check-run-settlement.ts';
import type { RemoteCheckSettlement } from './remote-check.ts';

const fixtures: string[] = [];
const settlementCli = resolve(import.meta.dir, 'check-run-settlement.ts');

function privateDirectory(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), `check-run-lifetime-${randomUUID()}-`));
  fixtures.push(root);
  return root;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function binding(): CheckRunInvocationBinding {
  return {
    sourceRevision: 'a'.repeat(40),
    indexTree: 'b'.repeat(40),
    sourceSha256: 'c'.repeat(64),
    argvSha256: 'd'.repeat(64),
    cwd: 'apps/web',
    semanticEnvironmentSha256: 'e'.repeat(64),
    relocatedEnvironmentSha256: 'f'.repeat(64),
    producerClosureSha256: '1'.repeat(64),
    hostsSha256: '2'.repeat(64),
    preparationCommandsSha256: '3'.repeat(64),
    returnsSha256: digest('[]'),
  };
}

type InvocationFixture = {
  root: string;
  candidate: string;
  state: string;
  descriptorDirectory: string;
  descriptor: string;
  scratch: string;
  workspace: string;
  registration: CheckRunRegistration;
  transportChild: CheckRunTransportChildIdentity;
};

async function preparedInvocation(
  persist = true,
  bindingOverrides: Partial<CheckRunInvocationBinding> = {},
): Promise<InvocationFixture> {
  const root = fixtureRoot();
  const candidate = privateDirectory(root, 'candidate');
  const state = privateDirectory(root, 'state');
  const descriptorDirectory = privateDirectory(root, 'descriptor');
  const invocationId = randomUUID();
  const descriptor = join(descriptorDirectory, `${invocationId}.json`);
  const snapshots = privateDirectory(root, 'snapshots');
  const scratch = join(snapshots, `check-run-${invocationId}`);
  mkdirSync(scratch, { mode: 0o700 });
  const workspace = join(scratch, 'workspace');
  const snapshot = { workspace, scratch, sourceSha256: binding().sourceSha256, inputFiles: [] as string[] };
  const intent = {
    schema: 1 as const,
    type: 'check-run-preparation-intent' as const,
    invocationId,
    descriptor,
    candidateWorkspace: candidate,
    snapshot: { ...snapshot, sourceSha256: snapshot.sourceSha256 },
  };
  const preparationIntent = writeCheckRunPreparationIntent(checkRunPreparationIntentFile(descriptor), intent);
  const registration = await registerCheckRunInvocation(
    { ...binding(), ...bindingOverrides },
    {
      stateDirectory: state,
      invocationId,
      candidateWorkspace: candidate,
      snapshot,
      returns: [],
      preparationIntent,
      descriptorFile: descriptor,
    },
  );
  if (persist) {
    const preparedDescriptor = await persistCheckRunPreparedInvocation(registration, {
      stateDirectory: state,
      candidateWorkspace: candidate,
      snapshot,
      returns: [],
      descriptorFile: descriptor,
      execution: { schema: 1, originalEnvironment: { SECRET_FIXTURE: 'never-in-status' } },
    });
    expect(preparedDescriptor.invocationId).toBe(registration.invocationId);
  }
  return {
    root,
    candidate,
    state,
    descriptorDirectory,
    descriptor,
    scratch,
    workspace,
    registration,
    transportChild: { pid: 4242, bootId: randomUUID(), start: '987654' },
  };
}

async function queueAndStart(fixture: InvocationFixture, native = true, transport = true): Promise<void> {
  const { registration, state, candidate, workspace, scratch, transportChild } = fixture;
  await claimCheckRunPreparedInvocation(fixture.descriptor, { stateDirectory: state });
  await markCheckRunQueued(registration.invocationId, registration.nonce, {
    stateDirectory: state,
    candidateWorkspace: candidate,
    returns: [],
    snapshot: { workspace, scratch, sourceSha256: registration.binding.sourceSha256, inputFiles: [] },
  });
  await beginCheckRunAllocation(registration.invocationId, registration.nonce, { stateDirectory: state });
  await allocateCheckRunPhysical(registration.invocationId, registration.nonce, 'a', 'original-run-1', {
    stateDirectory: state,
  });
  if (transport)
    await withCheckRunSpawnPermit(
      registration.invocationId,
      registration.nonce,
      'a',
      'original-run-1',
      () => ({ pid: transportChild.pid }),
      { stateDirectory: state },
      () => transportChild,
    );
  if (native)
    await markCheckRunNativeTerminal(
      registration.invocationId,
      registration.nonce,
      { host: 'a', run: 'original-run-1', exitCode: 0, lifetimeFailure: false, receiptSha256: '6'.repeat(64) },
      { stateDirectory: state },
    );
}

function finalFor(
  fixture: InvocationFixture,
  cleanup: 'unknown' | 'settled',
  changes: Partial<Pick<CheckRunFinalSettlement, 'binding' | 'physical' | 'native'>> = {},
): CheckRunFinalSettlement {
  const { registration } = fixture;
  return createCheckRunFinalSettlement({
    invocationId: registration.invocationId,
    nonce: registration.nonce,
    binding: changes.binding ?? registration.binding,
    physical: changes.physical ?? { host: 'a', run: 'original-run-1' },
    native: changes.native ?? { exitCode: 0, lifetimeFailure: false, receiptSha256: '6'.repeat(64) },
    preparedInputs: {
      status: 'verified',
      sourceSha256: registration.binding.sourceSha256,
      manifestSha256: '5'.repeat(64),
      fileCount: 1,
      totalBytes: 128,
    },
    returns: {
      status: 'empty',
      declarationsSha256: registration.binding.returnsSha256,
      entries: [],
      missing: [],
      failures: [],
    },
    cleanup:
      cleanup === 'settled'
        ? {
            disposition: 'settled',
            remote: 'verified',
            transportChild: 'reaped',
            source: 'verified',
            localWorktree: 'removed',
            failures: [],
          }
        : {
            disposition: 'unknown',
            remote: 'unknown',
            transportChild: 'unknown',
            source: 'unknown',
            localWorktree: 'retained',
            failures: ['mocked cleanup evidence is not yet complete'],
          },
    failures: { primary: [], cleanup: cleanup === 'settled' ? [] : ['mocked cleanup evidence is not yet complete'] },
  });
}

async function acceptFinal(
  fixture: InvocationFixture,
  final: CheckRunFinalSettlement,
  options: Parameters<typeof acceptCheckRunFinalSettlement>[1] = { stateDirectory: fixture.state },
) {
  return acceptCheckRunFinalSettlement(`${encodeCheckRunFinalSettlement(final)}\n`, options);
}

function procStat(pid: number, start: string): string {
  const fields = ['S', ...Array.from({ length: 18 }, () => '0'), start];
  return `${pid} (inert mocked child) ${fields.join(' ')}\n`;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function gitCandidate(root: string): { candidate: string; sourceRevision: string } {
  const candidate = privateDirectory(root, 'candidate-repo');
  git(candidate, ['init', '-b', 'main']);
  git(candidate, ['config', 'user.name', 'Check Run Fixture']);
  git(candidate, ['config', 'user.email', 'check-run-fixture@example.invalid']);
  writeFileSync(join(candidate, 'source.txt'), 'retained source fixture\n');
  git(candidate, ['add', 'source.txt']);
  git(candidate, ['commit', '-m', 'fixture source']);
  return { candidate, sourceRevision: git(candidate, ['rev-parse', 'HEAD']) };
}

function gitSnapshot(candidate: string, sourceRevision: string, invocationId: string) {
  const temp = privateDirectory(candidate, '.temp');
  const scratch = join(temp, `check-run-${invocationId}`);
  mkdirSync(scratch, { mode: 0o700 });
  const workspace = join(scratch, 'workspace');
  git(candidate, ['worktree', 'add', '--detach', workspace, sourceRevision]);
  return { workspace, scratch, sourceSha256: binding().sourceSha256, inputFiles: [] as string[] };
}

async function registerMaintenanceSnapshot(
  state: string,
  candidate: string,
  sourceRevision: string,
  invocationId: string,
) {
  const selectedBinding = { ...binding(), sourceRevision };
  const snapshot = gitSnapshot(candidate, sourceRevision, invocationId);
  const registration = await registerCheckRunInvocation(selectedBinding, {
    stateDirectory: state,
    invocationId,
    candidateWorkspace: candidate,
    snapshot,
    returns: [],
  });
  return { registration, snapshot, selectedBinding };
}

function maintenanceFinal(
  registration: CheckRunRegistration,
  returns: CheckRunFinalSettlement['returns'] = {
    status: 'empty',
    declarationsSha256: registration.binding.returnsSha256,
    entries: [],
    missing: [],
    failures: [],
  },
): CheckRunFinalSettlement {
  return createCheckRunFinalSettlement({
    invocationId: registration.invocationId,
    nonce: registration.nonce,
    binding: registration.binding,
    physical: { host: 'a', run: 'maintenance-run-123' },
    native: { exitCode: 0, lifetimeFailure: false, receiptSha256: '6'.repeat(64) },
    preparedInputs: {
      status: 'verified',
      sourceSha256: registration.binding.sourceSha256,
      manifestSha256: '5'.repeat(64),
      fileCount: 1,
      totalBytes: 12,
    },
    returns,
    cleanup: {
      disposition: 'unknown',
      remote: 'verified',
      transportChild: 'reaped',
      source: 'verified',
      localWorktree: 'retained',
      failures: ['local Git cleanup will be retried by maintenance'],
    },
    failures: { primary: [], cleanup: ['local Git cleanup will be retried by maintenance'] },
  });
}

async function finishMaintenanceInvocation(
  registration: CheckRunRegistration,
  state: string,
  final: CheckRunFinalSettlement,
): Promise<void> {
  const options = { stateDirectory: state };
  await markCheckRunQueued(registration.invocationId, registration.nonce, options);
  await beginCheckRunAllocation(registration.invocationId, registration.nonce, options);
  await allocateCheckRunPhysical(registration.invocationId, registration.nonce, 'a', 'maintenance-run-123', options);
  await withCheckRunSpawnPermit(
    registration.invocationId,
    registration.nonce,
    'a',
    'maintenance-run-123',
    () => undefined,
    options,
  );
  await markCheckRunNativeTerminal(
    registration.invocationId,
    registration.nonce,
    { host: 'a', run: 'maintenance-run-123', exitCode: 0, receiptSha256: '6'.repeat(64) },
    options,
  );
  await acceptCheckRunFinalSettlement(`${encodeCheckRunFinalSettlement(final)}\n`, options);
}

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

test('bounded maintenance removes a successful artifact-free snapshot through Git cleanup and records release', async () => {
  const root = fixtureRoot();
  const state = privateDirectory(root, 'state');
  const { candidate, sourceRevision } = gitCandidate(root);
  const invocationId = '00000000-0000-4000-8000-000000000003';
  const { registration, snapshot } = await registerMaintenanceSnapshot(state, candidate, sourceRevision, invocationId);
  await finishMaintenanceInvocation(registration, state, maintenanceFinal(registration));

  const report = await maintainCheckRunSnapshots({
    stateDirectory: state,
    limit: 1,
    apply: true,
    maxRemovals: 1,
    readIoPressure: () => 0,
  });
  expect(report.accounting).toMatchObject({ recordsChecked: 1, ready: 0, removed: 1 });
  expect(report.items[0]).toMatchObject({
    invocationId,
    disposition: 'removed',
    releaseKind: 'successful-delivered-no-artifacts',
  });
  expect(existsSync(snapshot.workspace)).toBe(false);
  expect(existsSync(snapshot.scratch)).toBe(false);
  expect((await getCheckRunStatus(invocationId, { stateDirectory: state })).snapshotCustody).toBe('removed');
});

test('bounded maintenance resumes by checked UUID and releases only completed prelaunch fences', async () => {
  const root = fixtureRoot();
  const state = privateDirectory(root, 'state');
  const { candidate, sourceRevision } = gitCandidate(root);
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const snapshots: Array<{ workspace: string; scratch: string; sourceSha256: string; inputFiles: string[] }> = [];
  for (const invocationId of ids) {
    const { registration, snapshot } = await registerMaintenanceSnapshot(
      state,
      candidate,
      sourceRevision,
      invocationId,
    );
    snapshots.push(snapshot);
    const options = { stateDirectory: state };
    await cancelCheckRunInvocation(registration.invocationId, registration.nonce, 15, options);
    const cancelled = await reconcileCheckRunInvocation(registration.invocationId, { ...options, force: true });
    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.physical).toBeNull();
  }

  const pressure = await maintainCheckRunSnapshots({
    stateDirectory: state,
    limit: 1,
    apply: true,
    readIoPressure: () => 21,
  });
  expect(pressure.ioPressure.paused).toBe(true);
  expect(pressure.accounting.recordsChecked).toBe(0);
  expect(pressure.cursor.output).toBeNull();

  const first = await maintainCheckRunSnapshots({
    stateDirectory: state,
    limit: 2,
    apply: true,
    maxRemovals: 1,
    readIoPressure: () => 0,
  });
  expect(first.cursor).toMatchObject({ output: ids[0], hasMore: true });
  expect(first.accounting.removed).toBe(1);
  expect(first.items).toMatchObject([
    { disposition: 'removed', releaseKind: 'cancelled-before-start' },
    { disposition: 'ready', reason: 'per-pass removal bound reached' },
  ]);
  const second = await maintainCheckRunSnapshots({
    stateDirectory: state,
    cursor: first.cursor.output,
    limit: 1,
    apply: true,
    maxRemovals: 1,
    readIoPressure: () => 0,
  });
  expect(second.cursor).toMatchObject({ output: ids[1], hasMore: false });
  expect(second.accounting.removed).toBe(1);
  expect(snapshots.every(({ workspace, scratch }) => !existsSync(workspace) && !existsSync(scratch))).toBe(true);
});

test('maintenance retains unknown custody and snapshots that still contain returned artifact evidence', async () => {
  const root = fixtureRoot();
  const state = privateDirectory(root, 'state');
  const { candidate, sourceRevision } = gitCandidate(root);
  const unknownId = '00000000-0000-4000-8000-000000000004';
  const artifactId = '00000000-0000-4000-8000-000000000005';
  const unknown = await registerMaintenanceSnapshot(state, candidate, sourceRevision, unknownId);
  const artifact = await registerMaintenanceSnapshot(state, candidate, sourceRevision, artifactId);
  await setCheckRunUnknown(unknownId, unknown.registration.nonce, 'original invocation identity is unresolved', {
    stateDirectory: state,
  });
  await finishMaintenanceInvocation(
    artifact.registration,
    state,
    maintenanceFinal(artifact.registration, {
      status: 'restored',
      declarationsSha256: artifact.registration.binding.returnsSha256,
      entries: [{ path: 'artifacts/report.bin', size: 4, sha256: digest('data') }],
      missing: [],
      failures: [],
    }),
  );

  const report = await maintainCheckRunSnapshots({ stateDirectory: state, limit: 2, readIoPressure: () => 0 });
  expect(report.items).toMatchObject([
    { invocationId: unknownId, disposition: 'retained', reason: 'invocation custody is unknown' },
    {
      invocationId: artifactId,
      disposition: 'retained',
      reason: 'the final settlement still references returned artifacts',
    },
  ]);
  expect(existsSync(unknown.snapshot.workspace)).toBe(true);
  expect(existsSync(artifact.snapshot.workspace)).toBe(true);
});

test('Original prepared invocation retains durable input and cleanup custody across cancellation process loss unreadable child identity and unknown final reconciliation without replay replacement allocation lost cleanup reference or false settlement', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'unknown');
  const originalRecord = await acceptFinal(fixture, original);
  expect(originalRecord.final).toEqual(original);
  expect(originalRecord.finalCustody?.reconciliation).toBe('unknown');

  let observedPhysical: { host: string; run: string } | undefined;
  const later = finalFor(fixture, 'settled');
  const reconciled = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
    stateDirectory: fixture.state,
    reconcilePhysical: async (physical, record) => {
      observedPhysical = physical;
      expect(record.invocationId).toBe(fixture.registration.invocationId);
      return { disposition: 'settled', final: later, transportIdentity: 'gone-or-replaced' };
    },
  });

  expect(observedPhysical).toEqual({ host: 'a', run: 'original-run-1' });
  expect(reconciled.final).toEqual(original);
  expect(reconciled.phase).toBe('settled');
  expect(reconciled.finalCustody?.observations.at(-1)?.final).toEqual(later);
  expect(reconciled.finalCustody?.observations.at(-1)?.transportIdentity).toBe('gone-or-replaced');
  const throughProducer = await reconcileRegisteredCheckRun(fixture.registration.invocationId, undefined, {
    stateDirectory: fixture.state,
  });
  expect(throughProducer.final).toEqual(original);
  expect(throughProducer.finalCustody?.reconciliation).toBe('settled');
  const throughCli = spawnSync(
    process.execPath,
    [settlementCli, 'reconcile', '--descriptor', fixture.descriptor, '--state-dir', fixture.state],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(throughCli.status).toBe(0);
  expect(JSON.parse(throughCli.stdout).final).toEqual(original);
  await expect(acceptFinal(fixture, later)).rejects.toThrow(/duplicate|replay/i);
});

test('reconciliation rejects changed native, eleven-field binding, and physical host evidence', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'unknown');
  await acceptFinal(fixture, original);
  const candidates = [
    finalFor(fixture, 'settled', {
      native: { exitCode: 0, lifetimeFailure: false, receiptSha256: '7'.repeat(64) },
    }),
    finalFor(fixture, 'settled', { binding: { ...fixture.registration.binding, argvSha256: '8'.repeat(64) } }),
    finalFor(fixture, 'settled', { physical: { host: 'b', run: 'original-run-1' } }),
  ];
  for (const candidate of candidates) {
    const record = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
      stateDirectory: fixture.state,
      reconcilePhysical: async () => ({
        disposition: 'settled',
        final: candidate,
        transportIdentity: 'gone-or-replaced',
      }),
    });
    expect(record.phase).toBe('unknown');
    expect(record.final).toEqual(original);
    expect(record.finalCustody?.observations.at(-1)?.disposition).toBe('rejected');
    expect(record.finalCustody?.observations.at(-1)?.reason).toBeTruthy();
  }
  const retained = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  expect(retained.physical).toEqual({ host: 'a', run: 'original-run-1' });
  expect(retained.final).toEqual(original);
});

test('native final admission, cancellation, and reconciliation races preserve immutable authority', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'unknown');
  const raw = `${encodeCheckRunFinalSettlement(original)}\n`;
  const concurrent = await Promise.allSettled([
    cancelCheckRunInvocation(fixture.registration.invocationId, fixture.registration.nonce, 15, {
      stateDirectory: fixture.state,
    }),
    acceptCheckRunFinalSettlement(raw, { stateDirectory: fixture.state }),
  ]);
  expect(concurrent.every((result) => result.status === 'fulfilled')).toBe(true);
  expect((await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state })).final).toEqual(
    original,
  );

  let releaseReconcile!: () => void;
  let reconciliationEntered!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseReconcile = resolve));
  const entered = new Promise<void>((resolve) => (reconciliationEntered = resolve));
  const later = finalFor(fixture, 'settled');
  const reconciliation = reconcileCheckRunInvocation(fixture.registration.invocationId, {
    stateDirectory: fixture.state,
    reconcilePhysical: async () => {
      reconciliationEntered();
      await blocked;
      return { disposition: 'settled', final: later, transportIdentity: 'gone-or-replaced' };
    },
  });
  await entered;
  const cancellation = cancelCheckRunInvocation(fixture.registration.invocationId, fixture.registration.nonce, 2, {
    stateDirectory: fixture.state,
  });
  const duplicate = acceptCheckRunFinalSettlement(raw, { stateDirectory: fixture.state });
  releaseReconcile();
  await cancellation;
  await expect(duplicate).rejects.toThrow(/duplicate|replay/i);
  const reconciled = await reconciliation;
  expect(reconciled.final).toEqual(original);
  expect(reconciled.finalCustody?.reconciliation).toBe('settled');
});

test('a failed private execution unlink keeps its exact reference for process-loss cleanup', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const executionReference = (
    await getCheckRunStatus(fixture.registration.invocationId, {
      stateDirectory: fixture.state,
    })
  ).preparedExecution;
  expect(executionReference).not.toBeNull();
  const final = finalFor(fixture, 'settled');
  const failedCleanup = await acceptFinal(fixture, final, {
    stateDirectory: fixture.state,
    removePrivateFile: () => {
      throw new Error('inert unlink fault');
    },
  });
  expect(failedCleanup.final).toEqual(final);
  expect(failedCleanup.finalCustody?.privateFiles).toBe('unknown');
  expect(failedCleanup.preparedExecution).toEqual(executionReference);
  expect(existsSync(executionReference!.file)).toBe(true);

  const recovered = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
    stateDirectory: fixture.state,
  });
  expect(recovered.phase).toBe('settled');
  expect(recovered.preparedExecution).toBeNull();
  expect(recovered.preparationIntent).toBeNull();
  expect(recovered.descriptor?.file).toBe(fixture.descriptor);
  expect(existsSync(fixture.descriptor)).toBe(true);
  expect(existsSync(executionReference!.file)).toBe(false);
});

test('successful preparation-intent unlink with a lost durable reference clear is recovered by discard', async () => {
  const fixture = await preparedInvocation();
  const before = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  const reference = before.preparationIntent;
  expect(reference).not.toBeNull();
  await expect(
    discardCheckRunPreparationIntent(fixture.registration.invocationId, fixture.registration.nonce, {
      stateDirectory: fixture.state,
      removePrivateFile: (path) => {
        unlinkSync(path);
        throw new Error('durable intent reference clear was interrupted');
      },
    }),
  ).rejects.toThrow(/interrupted/);
  expect(existsSync(reference!.file)).toBe(false);
  expect(
    (await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state })).preparationIntent,
  ).toEqual(reference);

  const recovered = await discardCheckRunPreparationIntent(
    fixture.registration.invocationId,
    fixture.registration.nonce,
    { stateDirectory: fixture.state },
  );
  expect(recovered.preparationIntent).toBeNull();
  expect(recovered.descriptor?.file).toBe(fixture.descriptor);
  expect(existsSync(fixture.descriptor)).toBe(true);
});

test('prepared registration rejects snapshot custody rebinding before persisting execution', async () => {
  const fixture = await preparedInvocation(false);
  await expect(
    persistCheckRunPreparedInvocation(fixture.registration, {
      stateDirectory: fixture.state,
      candidateWorkspace: fixture.candidate,
      snapshot: {
        workspace: `${fixture.workspace}-forged`,
        scratch: fixture.scratch,
        sourceSha256: fixture.registration.binding.sourceSha256,
        inputFiles: [],
      },
      returns: [],
      descriptorFile: fixture.descriptor,
      execution: { schema: 1, originalEnvironment: { SECRET_FIXTURE: 'never-in-status' } },
    }),
  ).rejects.toThrow(/cannot be rebound/);

  const retained = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  expect(retained.phase).toBe('registered');
  expect(retained.snapshot).toEqual({
    workspace: fixture.workspace,
    scratch: fixture.scratch,
    sourceSha256: fixture.registration.binding.sourceSha256,
    inputFiles: [],
  });
  expect(retained.preparedExecution).toBeNull();
  expect(retained.preparationIntent).not.toBeNull();
  expect(existsSync(fixture.descriptor)).toBe(false);

  const preparedDescriptor = await persistCheckRunPreparedInvocation(fixture.registration, {
    stateDirectory: fixture.state,
    candidateWorkspace: fixture.candidate,
    snapshot: {
      workspace: fixture.workspace,
      scratch: fixture.scratch,
      sourceSha256: fixture.registration.binding.sourceSha256,
      inputFiles: [],
    },
    returns: [],
    descriptorFile: fixture.descriptor,
    execution: { schema: 1, originalEnvironment: { SECRET_FIXTURE: 'never-in-status' } },
  });
  expect(preparedDescriptor.invocationId).toBe(fixture.registration.invocationId);
  expect(existsSync(fixture.descriptor)).toBe(true);
});

test('successful preparation-intent unlink with a lost durable clear recovers final private-file custody', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const before = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  const intentReference = before.preparationIntent;
  expect(intentReference).not.toBeNull();
  const final = finalFor(fixture, 'settled');
  const interrupted = await acceptFinal(fixture, final, {
    stateDirectory: fixture.state,
    removePrivateFile: (path) => {
      unlinkSync(path);
      if (path === intentReference!.file) throw new Error('durable intent reference clear was interrupted');
    },
  });
  expect(interrupted.final).toEqual(final);
  expect(interrupted.preparationIntent).toEqual(intentReference);
  expect(interrupted.finalCustody?.privateFiles).toBe('unknown');
  expect(interrupted.finalCustody?.aggregate).toBe('unknown');
  expect(existsSync(intentReference!.file)).toBe(false);

  const recovered = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
    stateDirectory: fixture.state,
  });
  expect(recovered.final).toEqual(final);
  expect(recovered.finalCustody?.privateFiles).toBe('settled');
  expect(recovered.finalCustody?.aggregate).toBe('settled');
  expect(recovered.phase).toBe('settled');
  expect(recovered.preparationIntent).toBeNull();
  expect(recovered.descriptor?.file).toBe(fixture.descriptor);
  expect(existsSync(fixture.descriptor)).toBe(true);
});

test('rejected reconciliation evidence cannot mutate snapshot custody before exact original-run recovery', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'unknown');
  await acceptFinal(fixture, original);
  const forged = finalFor(fixture, 'settled', {
    binding: { ...fixture.registration.binding, argvSha256: '8'.repeat(64) },
  });
  const rejected = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
    stateDirectory: fixture.state,
    reconcilePhysical: async () => ({
      disposition: 'settled',
      final: forged,
      transportIdentity: 'gone-or-replaced',
    }),
  });
  expect(rejected.final).toEqual(original);
  expect(rejected.finalCustody?.observations.at(-1)?.final).toEqual(forged);
  expect(rejected.finalCustody?.observations.at(-1)?.disposition).toBe('rejected');
  expect(rejected.snapshotCustody).toBe('owned');

  const recovered = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
    stateDirectory: fixture.state,
    reconcilePhysical: async () => ({
      disposition: 'settled',
      final: finalFor(fixture, 'settled'),
      transportIdentity: 'gone-or-replaced',
    }),
  });
  expect(recovered.final).toEqual(original);
  expect(recovered.snapshotCustody).toBe('removed');
  expect(recovered.finalCustody?.aggregate).toBe('settled');
});

test('bounded observation continuation keeps old evidence and admits later exact original-run recovery', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'unknown');
  const admitted = await acceptFinal(fixture, original);
  const originalObservations = admitted.finalCustody!.observations;
  const rejected = finalFor(fixture, 'settled', {
    binding: { ...fixture.registration.binding, argvSha256: '8'.repeat(64) },
  });
  let retainedPrefix: NonNullable<Awaited<ReturnType<typeof getCheckRunStatus>>['finalCustody']>['observations'] = [];

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await reconcileCheckRunInvocation(fixture.registration.invocationId, {
      stateDirectory: fixture.state,
      reconcilePhysical: async () => ({
        disposition: 'settled',
        final: rejected,
        transportIdentity: 'gone-or-replaced',
      }),
    });
    if (attempt === 14) {
      retainedPrefix = (await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state }))
        .finalCustody!.observations;
    }
  }
  const saturated = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  expect(retainedPrefix).toHaveLength(16);
  expect(retainedPrefix[0]).toEqual(originalObservations[0]);
  expect(saturated.finalCustody?.observations).toEqual(retainedPrefix);
  expect(saturated.finalCustody?.continuation?.count).toBeGreaterThan(0);
  expect(saturated.finalCustody?.continuation?.latest.final).toEqual(rejected);
  expect(saturated.final).toEqual(original);

  const exact = finalFor(fixture, 'settled');
  const recovered = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
    stateDirectory: fixture.state,
    reconcilePhysical: async () => ({
      disposition: 'settled',
      final: exact,
      transportIdentity: 'gone-or-replaced',
    }),
  });
  expect(recovered.final).toEqual(original);
  expect(recovered.finalCustody?.continuation?.latest.final).toEqual(exact);
  expect(recovered.finalCustody?.aggregate).toBe('settled');
  expect(recovered.phase).toBe('settled');
  await expect(acceptFinal(fixture, exact)).rejects.toThrow(/duplicate|replay/i);
});

test('Original lifetime custody survives lost reference clear rejected evidence bounded observation saturation and interrupted final delivery without replay or false release', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'unknown');
  const intentReference = (
    await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state })
  ).preparationIntent;
  expect(intentReference).not.toBeNull();

  const staged = await stageCheckRunFinalSettlement(`${encodeCheckRunFinalSettlement(original)}\n`, {
    stateDirectory: fixture.state,
    removePrivateFile: (path) => {
      unlinkSync(path);
      if (path === intentReference!.file) throw new Error('simulated lost durable intent reference clear');
    },
  });
  expect(staged.final).toEqual(original);
  expect(staged.finalCustody?.delivery).toBe('pending');
  expect(staged.finalCustody?.privateFiles).toBe('unknown');
  expect(staged.finalCustody?.aggregate).toBe('unknown');
  expect(existsSync(intentReference!.file)).toBe(false);

  const rejected = finalFor(fixture, 'settled', {
    binding: { ...fixture.registration.binding, argvSha256: '8'.repeat(64) },
  });
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
      stateDirectory: fixture.state,
      reconcilePhysical: async () => ({
        disposition: 'settled',
        final: rejected,
        transportIdentity: 'gone-or-replaced',
      }),
    });
    expect(result.final).toEqual(original);
    expect(result.snapshotCustody).toBe('owned');
  }

  const saturated = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  expect(saturated.preparationIntent).toBeNull();
  expect(saturated.finalCustody?.privateFiles).toBe('settled');
  expect(saturated.finalCustody?.delivery).toBe('pending');
  expect(saturated.finalCustody?.aggregate).toBe('unknown');
  expect(saturated.finalCustody?.observations).toHaveLength(16);
  expect(saturated.finalCustody?.continuation?.count).toBeGreaterThan(0);
  expect(saturated.finalCustody?.continuation?.latest.disposition).toBe('rejected');
  expect(saturated.phase).toBe('unknown');

  const recovered = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
    stateDirectory: fixture.state,
    reconcilePhysical: async () => ({
      disposition: 'settled',
      final: finalFor(fixture, 'settled'),
      transportIdentity: 'gone-or-replaced',
    }),
  });
  expect(recovered.final).toEqual(original);
  expect(recovered.finalCustody?.reconciliation).toBe('settled');
  expect(recovered.finalCustody?.privateFiles).toBe('settled');
  expect(recovered.finalCustody?.delivery).toBe('pending');
  expect(recovered.finalCustody?.aggregate).toBe('pending');
  expect(recovered.snapshotCustody).toBe('removed');
  expect(recovered.phase).toBe('unknown');

  const interrupted = await markCheckRunFinalSettlementDelivery(
    fixture.registration.invocationId,
    recovered.finalCustody!.deliverySha256,
    'unknown',
    { stateDirectory: fixture.state },
  );
  expect(interrupted.final).toEqual(original);
  expect(interrupted.finalCustody?.delivery).toBe('unknown');
  expect(interrupted.finalCustody?.aggregate).toBe('unknown');
  expect(interrupted.phase).toBe('unknown');
  const observations = interrupted.finalCustody?.observations;
  const continuation = interrupted.finalCustody?.continuation;
  await expect(acceptFinal(fixture, finalFor(fixture, 'settled'))).rejects.toThrow(/duplicate|replay/i);
  const afterReplay = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  expect(afterReplay.final).toEqual(original);
  expect(afterReplay.finalCustody?.delivery).toBe('unknown');
  expect(afterReplay.finalCustody?.aggregate).toBe('unknown');
  expect(afterReplay.finalCustody?.observations).toEqual(observations);
  expect(afterReplay.finalCustody?.continuation).toEqual(continuation);
});

test('pending or unknown FD 3 delivery stays unreleasable after cleanup through all reconciliation entrypoints', async () => {
  for (const delivery of ['pending', 'unknown'] as const) {
    for (const entrypoint of ['invocation-api', 'producer-api', 'descriptor-cli'] as const) {
      const fixture = await preparedInvocation();
      await queueAndStart(fixture);
      const original = finalFor(fixture, 'settled');
      const staged = await stageCheckRunFinalSettlement(`${encodeCheckRunFinalSettlement(original)}\n`, {
        stateDirectory: fixture.state,
      });
      expect(staged.finalCustody?.delivery).toBe('pending');
      if (delivery === 'unknown') {
        await markCheckRunFinalSettlementDelivery(
          fixture.registration.invocationId,
          staged.finalCustody!.deliverySha256,
          'unknown',
          { stateDirectory: fixture.state },
        );
      }

      let reconciled: Awaited<ReturnType<typeof getCheckRunStatus>>;
      if (entrypoint === 'invocation-api') {
        reconciled = await reconcileCheckRunInvocation(fixture.registration.invocationId, {
          stateDirectory: fixture.state,
        });
      } else if (entrypoint === 'producer-api') {
        reconciled = await reconcileRegisteredCheckRun(fixture.registration.invocationId, undefined, {
          stateDirectory: fixture.state,
        });
      } else {
        const child = spawnSync(
          process.execPath,
          [settlementCli, 'reconcile', '--descriptor', fixture.descriptor, '--state-dir', fixture.state],
          { encoding: 'utf8', timeout: 10_000 },
        );
        expect(child.status).toBe(0);
        reconciled = JSON.parse(child.stdout) as Awaited<ReturnType<typeof getCheckRunStatus>>;
      }

      expect(reconciled.final).toEqual(original);
      expect(reconciled.final?.cleanup.disposition).toBe('settled');
      expect(reconciled.finalCustody?.privateFiles).toBe('settled');
      expect(reconciled.finalCustody?.reconciliation).toBe('settled');
      expect(reconciled.finalCustody?.delivery).toBe(delivery);
      expect(reconciled.finalCustody?.aggregate).toBe(delivery === 'pending' ? 'pending' : 'unknown');
      expect(reconciled.phase).toBe('unknown');
    }
  }
});

test('aggregate custody settles only after successful FD 3 delivery and verified private cleanup', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'settled');
  const staged = await stageCheckRunFinalSettlement(`${encodeCheckRunFinalSettlement(original)}\n`, {
    stateDirectory: fixture.state,
  });
  expect(staged.finalCustody?.delivery).toBe('pending');
  expect(staged.finalCustody?.privateFiles).toBe('settled');
  expect(staged.finalCustody?.aggregate).toBe('pending');
  expect(staged.phase).toBe('unknown');

  const delivered = await markCheckRunFinalSettlementDelivery(
    fixture.registration.invocationId,
    staged.finalCustody!.deliverySha256,
    'delivered',
    { stateDirectory: fixture.state },
  );
  expect(delivered.final).toEqual(original);
  expect(delivered.finalCustody?.delivery).toBe('delivered');
  expect(delivered.finalCustody?.aggregate).toBe('settled');
  expect(delivered.phase).toBe('settled');
});

test('cancellation racing a staged final cannot make pending FD 3 custody releasable', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'settled');
  const raw = `${encodeCheckRunFinalSettlement(original)}\n`;
  const concurrent = await Promise.allSettled([
    cancelCheckRunInvocation(fixture.registration.invocationId, fixture.registration.nonce, 15, {
      stateDirectory: fixture.state,
    }),
    stageCheckRunFinalSettlement(raw, { stateDirectory: fixture.state }),
  ]);
  expect(concurrent.every((result) => result.status === 'fulfilled')).toBe(true);
  const status = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  expect(status.final).toEqual(original);
  expect(status.finalCustody?.delivery).toBe('pending');
  expect(status.finalCustody?.aggregate).toBe('pending');
  expect(status.phase).toBe('unknown');
  await expect(acceptFinal(fixture, finalFor(fixture, 'unknown'))).rejects.toThrow(/duplicate|replay/i);
});

test('immutable final replay rejection preserves the original unknown FD 3 custody decision', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'settled');
  const staged = await stageCheckRunFinalSettlement(`${encodeCheckRunFinalSettlement(original)}\n`, {
    stateDirectory: fixture.state,
  });
  await markCheckRunFinalSettlementDelivery(
    fixture.registration.invocationId,
    staged.finalCustody!.deliverySha256,
    'unknown',
    { stateDirectory: fixture.state },
  );
  const before = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  await expect(acceptFinal(fixture, finalFor(fixture, 'unknown'))).rejects.toThrow(/duplicate|replay/i);
  const after = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  expect(after.final).toEqual(original);
  expect(after.finalCustody?.delivery).toBe('unknown');
  expect(after.finalCustody?.aggregate).toBe('unknown');
  expect(after.finalCustody?.observations).toEqual(before.finalCustody?.observations);
  expect(after.phase).toBe('unknown');
});

test('FD 3 delivery failure is recorded after pinning and cannot admit a contradictory final', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'unknown');
  const staged = await stageCheckRunFinalSettlement(`${encodeCheckRunFinalSettlement(original)}\n`, {
    stateDirectory: fixture.state,
  });
  expect(staged.final).toEqual(original);
  expect(staged.finalCustody?.delivery).toBe('pending');
  const deliveryUnknown = await markCheckRunFinalSettlementDelivery(
    fixture.registration.invocationId,
    staged.finalCustody!.deliverySha256,
    'unknown',
    { stateDirectory: fixture.state },
  );
  expect(deliveryUnknown.finalCustody?.delivery).toBe('unknown');
  await expect(
    stageCheckRunFinalSettlement(`${encodeCheckRunFinalSettlement(finalFor(fixture, 'settled'))}\n`, {
      stateDirectory: fixture.state,
    }),
  ).rejects.toThrow(/duplicate|replay/i);
  expect((await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state })).final).toEqual(
    original,
  );
});

test('queued cancellation wins before allocation and prevents a late spawn or second claim', async () => {
  const fixture = await preparedInvocation();
  const beforeClaim = await cancelCheckRunInvocation(
    fixture.registration.invocationId,
    fixture.registration.nonce,
    15,
    { stateDirectory: fixture.state },
  );
  expect(beforeClaim.phase).toBe('cancel-requested');
  await expect(claimCheckRunPreparedInvocation(fixture.descriptor, { stateDirectory: fixture.state })).rejects.toThrow(
    /cannot be claimed|cancel/i,
  );

  const queued = await preparedInvocation();
  await claimCheckRunPreparedInvocation(queued.descriptor, { stateDirectory: queued.state });
  await markCheckRunQueued(queued.registration.invocationId, queued.registration.nonce, {
    stateDirectory: queued.state,
    candidateWorkspace: queued.candidate,
    returns: [],
    snapshot: {
      workspace: queued.workspace,
      scratch: queued.scratch,
      sourceSha256: queued.registration.binding.sourceSha256,
      inputFiles: [],
    },
  });
  await cancelCheckRunInvocation(queued.registration.invocationId, queued.registration.nonce, 2, {
    stateDirectory: queued.state,
  });
  await expect(
    beginCheckRunAllocation(queued.registration.invocationId, queued.registration.nonce, {
      stateDirectory: queued.state,
    }),
  ).rejects.toThrow(/cancel/i);
  let spawns = 0;
  await expect(
    withCheckRunSpawnPermit(
      queued.registration.invocationId,
      queued.registration.nonce,
      'a',
      'never-allocated-run',
      () => {
        spawns += 1;
      },
      { stateDirectory: queued.state },
    ),
  ).rejects.toThrow(/cancel|physical/i);
  expect(spawns).toBe(0);
  expect(
    (await getCheckRunStatus(queued.registration.invocationId, { stateDirectory: queued.state })).physical,
  ).toBeNull();
});

test('transport identity uncertainty, absence, malformed identity, and PID reuse stay distinct', async () => {
  const identity = { pid: 4242, bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', start: '987654' };
  const noSignals: string[] = [];
  const unreadable = await reapRetainedTransportChild(identity, {
    platform: 'linux',
    readBootId: () => {
      throw new Error('inert boot read permission failure');
    },
    readProcStat: () => procStat(identity.pid, identity.start),
    sendSignal: (_pid, signal) => noSignals.push(signal),
  });
  expect(unreadable).toBe('unknown');
  expect(noSignals).toEqual([]);

  const absent = await reapRetainedTransportChild(identity, {
    platform: 'linux',
    readBootId: () => {
      throw new Error('boot ID unavailable');
    },
    readProcStat: () => {
      throw Object.assign(new Error('no such process'), { code: 'ENOENT' });
    },
    sendSignal: (_pid, signal) => noSignals.push(signal),
  });
  expect(absent).toBe('gone-or-replaced');
  expect(noSignals).toEqual([]);

  const malformed = await reapRetainedTransportChild(identity, {
    platform: 'linux',
    readBootId: () => identity.bootId,
    readProcStat: () => 'this is not a proc stat record',
    sendSignal: (_pid, signal) => noSignals.push(signal),
  });
  expect(malformed).toBe('unknown');

  const reused = await reapRetainedTransportChild(identity, {
    platform: 'linux',
    readBootId: () => identity.bootId,
    readProcStat: () => procStat(identity.pid, '111111'),
    sendSignal: (_pid, signal) => noSignals.push(signal),
  });
  expect(reused).toBe('gone-or-replaced');
  expect(noSignals).toEqual([]);

  let procReads = 0;
  const signals: string[] = [];
  const live = await reapRetainedTransportChild(identity, {
    platform: 'linux',
    readBootId: () => identity.bootId,
    readProcStat: () => {
      procReads += 1;
      return procStat(identity.pid, identity.start);
    },
    sendSignal: (_pid, signal) => signals.push(signal),
    now: () => 0,
    sleep: async () => undefined,
    termTimeoutMs: 0,
    killTimeoutMs: 0,
  });
  expect(live).toBe('live-same');
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(procReads).toBe(4);

  let unsupportedReads = 0;
  const unsupported = await reapRetainedTransportChild(identity, {
    platform: 'darwin',
    readBootId: () => {
      unsupportedReads += 1;
      return identity.bootId;
    },
    sendSignal: (_pid, signal) => noSignals.push(signal),
  });
  expect(unsupported).toBe('unknown');
  expect(unsupportedReads).toBe(0);
  expect(noSignals).toEqual([]);
});

test('separate-process reconciliation removes only an unregistered original snapshot intent', async () => {
  const root = fixtureRoot();
  const candidate = privateDirectory(root, 'candidate');
  const state = privateDirectory(root, 'state');
  const descriptorDirectory = privateDirectory(root, 'descriptor');
  const snapshots = privateDirectory(root, 'snapshots');
  const invocationId = randomUUID();
  const descriptor = join(descriptorDirectory, `${invocationId}.json`);
  const scratch = join(snapshots, `check-run-${invocationId}`);
  const decoyScratch = join(snapshots, `check-run-${randomUUID()}`);
  const workspace = join(scratch, 'workspace');
  mkdirSync(scratch, { mode: 0o700 });
  mkdirSync(decoyScratch, { mode: 0o700 });
  const intent = {
    schema: 1 as const,
    type: 'check-run-preparation-intent' as const,
    invocationId,
    descriptor,
    candidateWorkspace: candidate,
    snapshot: { workspace, scratch, sourceSha256: null, inputFiles: [] },
  };
  writeCheckRunPreparationIntent(checkRunPreparationIntentFile(descriptor), intent);
  const child = spawnSync(
    process.execPath,
    [settlementCli, 'reconcile', '--descriptor', descriptor, '--state-dir', state],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    invocationId,
    snapshotCustody: 'removed',
    preparationIntent: 'removed',
  });
  expect(existsSync(scratch)).toBe(false);
  expect(existsSync(decoyScratch)).toBe(true);
  expect(existsSync(checkRunPreparationIntentFile(descriptor))).toBe(false);
});

test('a separate process reads the exposed descriptor record without replacing its allocation', async () => {
  const fixture = await preparedInvocation();
  const child = spawnSync(
    process.execPath,
    [settlementCli, 'status', fixture.registration.invocationId, '--state-dir', fixture.state],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(child.status).toBe(0);
  const observed = JSON.parse(child.stdout) as Awaited<ReturnType<typeof getCheckRunStatus>>;
  expect(observed.phase).toBe('prepared');
  expect(observed.descriptor?.file).toBe(fixture.descriptor);
  expect(observed.final).toBeNull();
  expect(child.stdout).not.toContain('never-in-status');
  expect(existsSync(fixture.descriptor)).toBe(true);
  expect(statSync(fixture.state).mode & 0o077).toBe(0);
  await claimCheckRunPreparedInvocation(fixture.descriptor, { stateDirectory: fixture.state });
  await expect(claimCheckRunPreparedInvocation(fixture.descriptor, { stateDirectory: fixture.state })).rejects.toThrow(
    /cannot be claimed/i,
  );
  const stillOriginal = await getCheckRunStatus(fixture.registration.invocationId, { stateDirectory: fixture.state });
  expect(stillOriginal.physical).toBeNull();
  expect(stillOriginal.descriptor?.file).toBe(fixture.descriptor);
});

test('reconciliation requires the exact exposed descriptor bytes recorded before exposure', async () => {
  const fixture = await preparedInvocation();
  const original = readFileSync(fixture.descriptor);
  writeFileSync(fixture.descriptor, `${original.toString('utf8').trim()} \n`, { mode: 0o600 });
  await expect(
    reconcileCheckRunPreparationIntent(fixture.descriptor, undefined, { stateDirectory: fixture.state }),
  ).rejects.toThrow(/differs from the retained invocation/i);
});

function precommandCleanup(): RemoteCheckSettlement {
  return {
    schema: 1,
    host: 'a',
    run: 'original-run-1',
    native: null,
    preparedInputs: null,
    returns: { schema: 1, status: 'empty', entries: [], missing: [], failures: [] },
    cleanup: {
      schema: 1,
      host: 'a',
      run: 'original-run-1',
      status: 'verified',
      supervisorStopped: true,
      commandGroupTerminal: true,
      containersRemoved: true,
      runDirectoryRemoved: true,
      failures: [],
    },
    transportChildReaped: true,
  };
}

test.each(['gone-or-replaced', 'unknown'] as const)(
  'pre-PID slot-take failure retains verified physical cleanup separately from native outcome (original transport: %s)',
  async (transportIdentity) => {
    const fixture = await preparedInvocation();
    const options = { stateDirectory: fixture.state, force: true };
    await queueAndStart(fixture, false, transportIdentity === 'gone-or-replaced');
    mkdirSync(fixture.workspace, { recursive: true });
    writeFileSync(join(fixture.workspace, 'frozen.ts'), 'retained completed source');
    const originalFailure = 'check-run: remote transport failed during slot-take before a result';
    await setCheckRunUnknown(fixture.registration.invocationId, fixture.registration.nonce, originalFailure, options);
    const before = await getCheckRunStatus(fixture.registration.invocationId, options);
    let observations = 0;
    const recovered = await reconcileCheckRunInvocation(before.invocationId, {
      ...options,
      reconcilePhysical: async (physical, record) => {
        observations++;
        return reconcileCheckRunPhysicalCleanup(physical, record, precommandCleanup(), transportIdentity);
      },
    });
    expect(recovered.physicalCleanup).toMatchObject({
      schema: 1,
      invocationId: before.invocationId,
      binding: before.binding,
      physical: before.physical,
      remote: {
        status: 'verified',
        supervisorStopped: true,
        commandGroupTerminal: true,
        containersRemoved: true,
        runDirectoryRemoved: true,
      },
      reconciliationTransportChildReaped: true,
      transportIdentity,
      transportChildReaped: transportIdentity === 'gone-or-replaced',
    });
    expect(recovered.native).toBeNull();
    expect(recovered.final).toBeNull();
    expect(recovered.phase).toBe('unknown');
    expect(recovered.failure).toBe(originalFailure);
    expect(recovered.snapshot).toEqual(before.snapshot);
    expect(recovered.snapshotCustody).toBe('owned');
    expect(recovered.preparedExecution).toEqual(before.preparedExecution);
    expect(readFileSync(join(fixture.workspace, 'frozen.ts'), 'utf8')).toBe('retained completed source');
    const repeated = await reconcileCheckRunInvocation(before.invocationId, {
      ...options,
      reconcilePhysical: async () => {
        observations++;
        return { disposition: 'unknown', reason: 'later unavailable observation' };
      },
    });
    expect(repeated).toEqual(recovered);
    expect(await reconcileRegisteredCheckRun(before.invocationId, undefined, options)).toEqual(recovered);
    expect(observations).toBe(1);
    await expect(claimCheckRunPreparedInvocation(fixture.descriptor, options)).rejects.toThrow();
  },
);

test('incomplete or foreign precommand cleanup cannot discharge the original invocation custody', async () => {
  const fixture = await preparedInvocation();
  const options = { stateDirectory: fixture.state, force: true };
  await queueAndStart(fixture, false);
  const before = await getCheckRunStatus(fixture.registration.invocationId, options);
  const incomplete = precommandCleanup();
  incomplete.cleanup.commandGroupTerminal = false;
  for (const remote of [incomplete, { ...precommandCleanup(), host: 'b' }]) {
    const observed = await reconcileCheckRunInvocation(before.invocationId, {
      ...options,
      reconcilePhysical: async (physical, record) =>
        reconcileCheckRunPhysicalCleanup(physical, record, remote, 'gone-or-replaced'),
    });
    expect(observed.physicalCleanup).toBeUndefined();
    expect(observed.native).toBeNull();
    expect(observed.final).toBeNull();
    expect(observed.phase).toBe('unknown');
    expect(observed.snapshotCustody).toBe('owned');
  }
  const valid = reconcileCheckRunPhysicalCleanup(before.physical!, before, precommandCleanup(), 'gone-or-replaced');
  if (valid.disposition !== 'physical-cleanup') throw new Error('expected physical-only observation');
  const rejected = await reconcileCheckRunInvocation(before.invocationId, {
    ...options,
    reconcilePhysical: async () => ({
      ...valid,
      observation: { ...valid.observation, binding: { ...valid.observation.binding, sourceSha256: '9'.repeat(64) } },
    }),
  });
  expect(rejected.physicalCleanup).toBeUndefined();
  expect(rejected.failure).toContain('original physical cleanup is incomplete or mismatched');
});

function cleanupOnlyHosts() {
  return JSON.stringify({
    hosts: [
      {
        name: 'a',
        address: 'root@cleanup.example',
        identity: '/keys/fixture',
        performance: true,
        memoryMaxGiB: 16,
        cpuQuotaPercent: 800,
        slots: 8,
      },
    ],
  });
}

test('cleanup-only reconciliation survives a removed candidate and changed producer without executing or restoring returns', async () => {
  const configuration = cleanupOnlyHosts();
  const fixture = await preparedInvocation(true, { hostsSha256: digest(configuration) });
  const options = { stateDirectory: fixture.state };
  const hosts = join(fixture.root, 'hosts.json');
  writeFileSync(hosts, configuration);
  await queueAndStart(fixture, false, false);
  mkdirSync(fixture.workspace, { recursive: true });
  writeFileSync(join(fixture.workspace, 'frozen.ts'), 'original frozen source');
  rmSync(fixture.candidate, { recursive: true });
  await setCheckRunUnknown(
    fixture.registration.invocationId,
    fixture.registration.nonce,
    'remote-check: failed during slot take before a result',
    options,
  );
  const before = await getCheckRunStatus(fixture.registration.invocationId, options);
  let observations = 0;
  const dependencies = {
    reconcileRemote: async (request: Parameters<typeof import('./remote-check.ts').reconcileRemoteRun>[0]) => {
      observations++;
      expect(request.physical).toEqual(before.physical);
      expect(request.expectedSourceSha256).toBe(before.binding.sourceSha256);
      expect(request.returns).toEqual([]);
      expect(request.workspace).toBe(fixture.state);
      expect(request.allowedHosts).toEqual(['a']);
      expect('command' in request).toBe(false);
      return precommandCleanup();
    },
  };
  // Normal result receiving still rejects this retained old producer, without calling a transport.
  expect(
    (await reconcileRegisteredCheckRun(before.invocationId, hosts, options, dependencies)).physicalCleanup,
  ).toBeUndefined();
  expect(observations).toBe(0);
  const recovered = await reconcileRegisteredCheckRun(
    before.invocationId,
    hosts,
    { ...options, cleanupOnly: true },
    dependencies,
  );
  expect(observations).toBe(1);
  expect(recovered.physicalCleanup?.remote.status).toBe('verified');
  expect(recovered.physicalCleanup?.transportIdentity).toBe('unknown');
  expect(recovered.physicalCleanup?.transportChildReaped).toBe(false);
  expect(recovered.native).toBeNull();
  expect(recovered.final).toBeNull();
  expect(recovered.failure).toBe(before.failure);
  expect(recovered.binding).toEqual(before.binding);
  expect(recovered.snapshot).toEqual(before.snapshot);
  expect(recovered.snapshotCustody).toBe('owned');
  expect(readFileSync(join(fixture.workspace, 'frozen.ts'), 'utf8')).toBe('original frozen source');
  expect(
    await reconcileRegisteredCheckRun(before.invocationId, undefined, { ...options, cleanupOnly: true }, dependencies),
  ).toEqual(recovered);
  expect(observations).toBe(1);
  const cli = spawnSync(
    process.execPath,
    [settlementCli, 'reconcile', before.invocationId, '--cleanup-only', '--state-dir', fixture.state],
    { encoding: 'utf8' },
  );
  expect(cli.status).toBe(0);
  expect(JSON.parse(cli.stdout).physicalCleanup).toEqual(recovered.physicalCleanup);
});

test('cleanup-only reconciliation rejects foreign hosts and binding changes and retains incomplete custody as unknown', async () => {
  const configuration = cleanupOnlyHosts();
  const fixture = await preparedInvocation(true, { hostsSha256: digest(configuration) });
  const options = { stateDirectory: fixture.state, cleanupOnly: true };
  const hosts = join(fixture.root, 'hosts.json');
  await queueAndStart(fixture, false, false);
  await setCheckRunUnknown(
    fixture.registration.invocationId,
    fixture.registration.nonce,
    'original slot-take failure',
    options,
  );
  let observations = 0;
  const observer = async () => {
    observations++;
    return precommandCleanup();
  };
  writeFileSync(hosts, configuration + '\n');
  await expect(
    reconcileRegisteredCheckRun(fixture.registration.invocationId, hosts, options, { reconcileRemote: observer }),
  ).rejects.toThrow('host configuration differs');
  expect(observations).toBe(0);
  writeFileSync(hosts, configuration);
  const incomplete = precommandCleanup();
  incomplete.cleanup.containersRemoved = false;
  for (const remote of [incomplete, { ...precommandCleanup(), run: 'replacement-run' }]) {
    const unknown = await reconcileRegisteredCheckRun(fixture.registration.invocationId, hosts, options, {
      reconcileRemote: async () => remote,
    });
    expect(unknown.physicalCleanup).toBeUndefined();
    expect(unknown.phase).toBe('unknown');
    expect(unknown.failure).toBe('original slot-take failure');
    expect(unknown.native).toBeNull();
    expect(unknown.final).toBeNull();
  }
  const record = await getCheckRunStatus(fixture.registration.invocationId, options);
  const observed = reconcileCheckRunPhysicalCleanup(record.physical!, record, precommandCleanup(), 'unknown');
  if (observed.disposition !== 'physical-cleanup') throw new Error('expected cleanup observation');
  await expect(
    acceptCheckRunPhysicalCleanup(record.invocationId, { ...observed.observation, nonce: '0'.repeat(64) }, options),
  ).rejects.toThrow('original invocation binding');
  await expect(
    acceptCheckRunPhysicalCleanup(
      record.invocationId,
      { ...observed.observation, binding: { ...record.binding, argvSha256: '9'.repeat(64) } },
      options,
    ),
  ).rejects.toThrow('original invocation binding');
  expect((await getCheckRunStatus(record.invocationId, options)).physicalCleanup).toBeUndefined();
});

test('cleanup-only receiving preserves an existing native outcome and immutable final without accepting a new result', async () => {
  const configuration = cleanupOnlyHosts();
  const fixture = await preparedInvocation(true, { hostsSha256: digest(configuration) });
  const options = { stateDirectory: fixture.state };
  const hosts = join(fixture.root, 'hosts.json');
  writeFileSync(hosts, configuration);
  await queueAndStart(fixture);
  await acceptFinal(fixture, finalFor(fixture, 'unknown'));
  const before = await getCheckRunStatus(fixture.registration.invocationId, options);
  const after = await reconcileRegisteredCheckRun(
    before.invocationId,
    hosts,
    { ...options, cleanupOnly: true },
    {
      reconcileRemote: async (request) => {
        expect(request.returns).toEqual([]);
        return precommandCleanup();
      },
      reapTransport: async () => 'gone-or-replaced',
    },
  );
  expect(after.native).toEqual(before.native);
  expect(after.final).toEqual(before.final);
  expect(after.finalCustody).toEqual(before.finalCustody);
  expect(after.snapshot).toEqual(before.snapshot);
  expect(after.physicalCleanup?.remote.status).toBe('verified');
});

async function failedSnapshotFixture(
  exitCode = 70,
  cleanup: Partial<CheckRunFinalSettlement['cleanup']> = {},
  accept = true,
  allocatedScratchName?: string,
) {
  const root = fixtureRoot();
  const state = privateDirectory(root, 'state');
  const { candidate } = gitCandidate(root);
  mkdirSync(join(candidate, 'contracts'));
  const priorOutput = '{"prior":"caller source"}\n';
  writeFileSync(join(candidate, 'contracts/openapi.json'), priorOutput);
  git(candidate, ['add', 'contracts/openapi.json']);
  git(candidate, ['commit', '-m', 'fixture generated source']);
  const sourceRevision = git(candidate, ['rev-parse', 'HEAD']);
  const returns = ['contracts/openapi.json'];
  const scratch = allocatedScratchName === undefined ? undefined : join(candidate, '.temp', allocatedScratchName);
  const allocation = scratch === undefined ? undefined : { scratch, workspace: join(scratch, 'workspace') };
  const frozen = await prepareCandidateSnapshot(candidate, sourceRevision, undefined, returns, allocation);
  const snapshot = {
    workspace: frozen.workspace,
    scratch: frozen.scratch,
    sourceSha256: frozen.sourceHash,
    inputFiles: frozen.inputFiles,
  };
  const selected = {
    ...binding(),
    sourceRevision,
    indexTree: frozen.indexTree,
    sourceSha256: frozen.sourceHash,
    returnsSha256: digest(JSON.stringify(returns)),
  };
  const registration = await registerCheckRunInvocation(selected, {
    stateDirectory: state,
    candidateWorkspace: candidate,
    snapshot,
    returns,
  });
  const options = { stateDirectory: state };
  const physical = { host: 'b', run: 'failed-original-run-70' };
  const native = { exitCode, lifetimeFailure: false, receiptSha256: '6'.repeat(64) };
  await markCheckRunQueued(registration.invocationId, registration.nonce, options);
  await beginCheckRunAllocation(registration.invocationId, registration.nonce, options);
  await allocateCheckRunPhysical(registration.invocationId, registration.nonce, physical.host, physical.run, options);
  await withCheckRunSpawnPermit(
    registration.invocationId,
    registration.nonce,
    physical.host,
    physical.run,
    () => undefined,
    options,
  );
  let final: CheckRunFinalSettlement | null = null;
  if (accept) {
    await markCheckRunNativeTerminal(
      registration.invocationId,
      registration.nonce,
      { ...physical, ...native },
      options,
    );
    final = createCheckRunFinalSettlement({
      invocationId: registration.invocationId,
      nonce: registration.nonce,
      binding: selected,
      physical,
      native,
      preparedInputs: {
        status: 'unavailable',
        sourceSha256: null,
        manifestSha256: null,
        fileCount: 0,
        totalBytes: 0,
      },
      returns: {
        status: 'missing',
        declarationsSha256: selected.returnsSha256,
        entries: [],
        missing: returns,
        failures: ['original preparation produced no returned source'],
      },
      cleanup: {
        disposition: 'unknown',
        remote: 'verified',
        transportChild: 'reaped',
        source: 'verified',
        localWorktree: 'retained',
        failures: ['failed return recovery retains the local snapshot'],
        ...cleanup,
      },
      failures: { primary: [`original native exit ${exitCode}`, 'prepared inputs unavailable'], cleanup: [] },
    });
    await acceptCheckRunFinalSettlement(encodeCheckRunFinalSettlement(final), options);
  }
  const record = await getCheckRunStatus(registration.invocationId, options);
  const decision = {
    abandonReturns: true,
    bindingSha256: checkRunBindingHash(record.binding),
    physical,
    native,
    finalSha256: record.finalCustody?.originalFinalSha256 ?? '7'.repeat(64),
  };
  return { candidate, priorOutput, snapshot, registration, options, final, record, decision };
}

test('explicit failed snapshot discard retains native70, missing returns and immutable non-green final', async () => {
  const f = await failedSnapshotFixture();
  expect(basename(f.snapshot.scratch)).toMatch(
    /^check-run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9]{6}$/i,
  );
  expect(checkRunSnapshotReleaseKind(f.record)).toBeNull();
  const originalFinal = encodeCheckRunFinalSettlement(f.final!);
  const originalNative = f.record.native;
  writeFileSync(join(f.candidate, 'source.txt'), 'later caller work\n');
  git(f.candidate, ['add', 'source.txt']);
  git(f.candidate, ['commit', '-m', 'advance caller after the failed original']);
  const callerHead = git(f.candidate, ['rev-parse', 'HEAD']);
  expect(callerHead).not.toBe(f.record.binding.sourceRevision);
  const newerOutput = '{"newer":"subsequent generator output"}\n';
  writeFileSync(join(f.candidate, 'contracts/openapi.json'), newerOutput);
  const result = await discardRegisteredCheckRunFailedSnapshot(
    f.registration.invocationId,
    f.registration.nonce,
    true,
    f.options,
  );
  expect(result.snapshotCustody).toBe('removed');
  expect(existsSync(f.snapshot.workspace)).toBe(false);
  expect(existsSync(f.snapshot.scratch)).toBe(false);
  expect(readFileSync(join(f.candidate, 'contracts/openapi.json'), 'utf8')).toBe(newerOutput);
  expect(git(f.candidate, ['rev-parse', 'HEAD'])).toBe(callerHead);
  expect(result.binding).toEqual(f.record.binding);
  expect(result.returns).toEqual(f.record.returns);
  expect(result.finalCustody?.originalFinalSha256).toBe(f.record.finalCustody?.originalFinalSha256);
  expect(encodeCheckRunFinalSettlement(result.final!)).toBe(originalFinal);
  expect(result.native).toEqual(originalNative);
  expect(result.native?.exitCode).toBe(70);
  expect(result.final?.returns).toEqual(f.final!.returns);
  expect(result.phase).toBe('unknown');
  expect(result.finalCustody?.aggregate).not.toBe('settled');
  expect(checkRunSnapshotReleaseKind(result)).toBeNull();
});

test('failed snapshot discard refuses absent abandonment and changed nonce, binding, physical or native identity', async () => {
  const f = await failedSnapshotFixture();
  let removals = 0;
  const remove = () => {
    removals++;
  };
  await expect(
    discardCheckRunFailedSnapshot(f.registration.invocationId, randomUUID(), f.decision, remove, f.options),
  ).rejects.toThrow('nonce');
  for (const decision of [
    { ...f.decision, abandonReturns: false },
    { ...f.decision, bindingSha256: '8'.repeat(64) },
    { ...f.decision, physical: { ...f.decision.physical, run: 'replacement-run' } },
    { ...f.decision, native: { ...f.decision.native, exitCode: 1 } },
    { ...f.decision, native: { ...f.decision.native, receiptSha256: '9'.repeat(64) } },
    { ...f.decision, finalSha256: '0'.repeat(64) },
  ])
    await expect(
      discardCheckRunFailedSnapshot(f.registration.invocationId, f.registration.nonce, decision, remove, f.options),
    ).rejects.toThrow();
  expect(removals).toBe(0);
  expect((await getCheckRunStatus(f.registration.invocationId, f.options)).snapshotCustody).toBe('owned');
  expect(existsSync(f.snapshot.workspace)).toBe(true);
});

test('failed snapshot discard refuses success, active work and unknown remote, transport or source cleanup', async () => {
  const cases = [
    await failedSnapshotFixture(0),
    await failedSnapshotFixture(70, {}, false),
    await failedSnapshotFixture(70, { remote: 'unknown' }),
    await failedSnapshotFixture(70, { transportChild: 'unknown' }),
    await failedSnapshotFixture(70, { source: 'unknown' }),
  ];
  for (const f of cases) {
    let removals = 0;
    await expect(
      discardCheckRunFailedSnapshot(
        f.registration.invocationId,
        f.registration.nonce,
        f.decision,
        () => {
          removals++;
        },
        f.options,
      ),
    ).rejects.toThrow();
    expect(removals).toBe(0);
    expect(existsSync(f.snapshot.workspace)).toBe(true);
    expect((await getCheckRunStatus(f.registration.invocationId, f.options)).snapshotCustody).toBe('owned');
  }
});

test('failed snapshot removal failure retains exact ownership and can retry ordinary Git cleanup', async () => {
  const f = await failedSnapshotFixture();
  await expect(
    discardCheckRunFailedSnapshot(
      f.registration.invocationId,
      f.registration.nonce,
      f.decision,
      () => {
        throw new Error('owned removal unavailable');
      },
      f.options,
    ),
  ).rejects.toThrow('owned removal unavailable');
  const retained = await getCheckRunStatus(f.registration.invocationId, f.options);
  expect(retained.snapshotCustody).toBe('owned');
  expect(retained.final).toEqual(f.final);
  expect(existsSync(f.snapshot.workspace)).toBe(true);
  const retried = await discardRegisteredCheckRunFailedSnapshot(
    f.registration.invocationId,
    f.registration.nonce,
    true,
    f.options,
  );
  expect(retried.snapshotCustody).toBe('removed');
  expect(retried.final).toEqual(f.final);
});

test('failed snapshot discard refuses modified source and a replacement directory at the registered worktree path', async () => {
  const changed = await failedSnapshotFixture();
  writeFileSync(join(changed.snapshot.workspace, 'source.txt'), 'new local source must survive\n');
  await expect(
    discardRegisteredCheckRunFailedSnapshot(
      changed.registration.invocationId,
      changed.registration.nonce,
      true,
      changed.options,
    ),
  ).rejects.toThrow('source identity changed');
  expect(existsSync(changed.snapshot.workspace)).toBe(true);
  expect((await getCheckRunStatus(changed.registration.invocationId, changed.options)).snapshotCustody).toBe('owned');
  const replaced = await failedSnapshotFixture();
  git(replaced.candidate, ['worktree', 'remove', '--force', replaced.snapshot.workspace]);
  mkdirSync(replaced.snapshot.workspace);
  writeFileSync(join(replaced.snapshot.workspace, 'replacement.txt'), 'not owned by the failed attempt\n');
  await expect(
    discardRegisteredCheckRunFailedSnapshot(
      replaced.registration.invocationId,
      replaced.registration.nonce,
      true,
      replaced.options,
    ),
  ).rejects.toThrow();
  expect(readFileSync(join(replaced.snapshot.workspace, 'replacement.txt'), 'utf8')).toBe(
    'not owned by the failed attempt\n',
  );
  expect((await getCheckRunStatus(replaced.registration.invocationId, replaced.options)).snapshotCustody).toBe('owned');
});

test('a second failed discard waits for the original invocation fence and cannot remove after custody changed', async () => {
  const f = await failedSnapshotFixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let removals = 0;
  const first = discardCheckRunFailedSnapshot(
    f.registration.invocationId,
    f.registration.nonce,
    f.decision,
    async () => {
      removals++;
      enter();
      await held;
      git(f.candidate, ['worktree', 'remove', '--force', f.snapshot.workspace]);
      rmSync(f.snapshot.scratch, { recursive: true, force: true });
    },
    f.options,
  );
  await Promise.race([
    entered,
    first.then(() => {
      throw new Error('first discard completed before entering the owned removal callback');
    }),
  ]);
  let secondOutcome: Promise<PromiseSettledResult<unknown>> | undefined;
  try {
    const second = discardCheckRunFailedSnapshot(
      f.registration.invocationId,
      f.registration.nonce,
      f.decision,
      () => {
        removals++;
      },
      f.options,
    );
    // Observe immediately, but consume no pending assertion while the first owner holds the fence.
    secondOutcome = second.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    expect(removals).toBe(1);
    release();
    expect((await first).snapshotCustody).toBe('removed');
    const outcome = await secondOutcome;
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('second discard bypassed changed snapshot custody');
    expect(outcome.reason).toBeInstanceOf(Error);
    expect(String(outcome.reason)).toContain('retained terminal custody');
    expect(removals).toBe(1);
  } finally {
    release();
    await first.catch(() => undefined);
    await secondOutcome;
  }
});

test('failed snapshot CLI requires the original nonce and explicit return abandonment and reports the failed original', async () => {
  const f = await failedSnapshotFixture();
  const maintenance = spawnSync(
    process.execPath,
    [settlementCli, 'maintain', '--limit', '1', '--state-dir', f.options.stateDirectory],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  expect(maintenance.error).toBeUndefined();
  expect(maintenance.signal).toBeNull();
  expect(maintenance.status, maintenance.stderr).toBe(0);
  expect(JSON.parse(maintenance.stdout).accounting.removed).toBe(0);
  expect((await getCheckRunStatus(f.registration.invocationId, f.options)).snapshotCustody).toBe('owned');
  const argv = [settlementCli, 'discard-failed-snapshot', f.registration.invocationId, '--nonce', f.registration.nonce];
  const rejected = spawnSync(process.execPath, [...argv, '--state-dir', f.options.stateDirectory], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(rejected.error).toBeUndefined();
  expect(rejected.signal).toBeNull();
  expect(rejected.status).toBe(2);
  expect(rejected.stderr).toContain('--abandon-returns');
  expect(existsSync(f.snapshot.workspace)).toBe(true);
  const retired = spawnSync(process.execPath, [...argv, '--abandon-returns', '--state-dir', f.options.stateDirectory], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(retired.error).toBeUndefined();
  expect(retired.signal).toBeNull();
  expect(retired.status, retired.stderr).toBe(0);
  const record = JSON.parse(retired.stdout);
  expect(record.snapshotCustody).toBe('removed');
  expect(record.native.exitCode).toBe(70);
  expect(record.final).toEqual(f.final);
  expect(record.final.returns.status).toBe('missing');
  expect(record.phase).toBe('unknown');
});

test('failed snapshot discard admits the exact prepared allocation path produced by prepareCandidateSnapshot', async () => {
  const name = `check-run-${randomUUID()}`;
  const f = await failedSnapshotFixture(70, {}, true, name);
  expect(basename(f.snapshot.scratch)).toBe(name);
  const result = await discardRegisteredCheckRunFailedSnapshot(
    f.registration.invocationId,
    f.registration.nonce,
    true,
    f.options,
  );
  expect(result.snapshotCustody).toBe('removed');
  expect(existsSync(f.snapshot.workspace)).toBe(false);
  expect(existsSync(f.snapshot.scratch)).toBe(false);
  expect(result.final).toEqual(f.final);
  expect(result.native?.exitCode).toBe(70);
  expect(result.phase).toBe('unknown');
});

test('failed snapshot discard rejects unsupported suffixes even for registered source-matching Git worktrees', async () => {
  const stem = `check-run-${randomUUID()}`;
  for (const name of [`${stem}-`, `${stem}-abc12`, `${stem}-abc1234`, `${stem}-abc_12`, `${stem}-abc123-extra`]) {
    const f = await failedSnapshotFixture(70, {}, true, name);
    expect(git(f.snapshot.workspace, ['rev-parse', 'HEAD'])).toBe(f.record.binding.sourceRevision);
    await expect(
      discardRegisteredCheckRunFailedSnapshot(f.registration.invocationId, f.registration.nonce, true, f.options),
    ).rejects.toThrow('retained snapshot path does not match an exact check-run worktree');
    expect(existsSync(f.snapshot.workspace)).toBe(true);
    expect(existsSync(f.snapshot.scratch)).toBe(true);
    const retained = await getCheckRunStatus(f.registration.invocationId, f.options);
    expect(retained.snapshotCustody).toBe('owned');
    expect(retained.final).toEqual(f.final);
  }
});
