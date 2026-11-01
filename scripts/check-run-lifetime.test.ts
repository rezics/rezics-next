import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { reconcileCheckRunPreparationIntent, reconcileRegisteredCheckRun } from './check-run.ts';
import {
  acceptCheckRunFinalSettlement,
  allocateCheckRunPhysical,
  beginCheckRunAllocation,
  cancelCheckRunInvocation,
  claimCheckRunPreparedInvocation,
  checkRunPreparationIntentFile,
  createCheckRunFinalSettlement,
  encodeCheckRunFinalSettlement,
  getCheckRunStatus,
  markCheckRunFinalSettlementDelivery,
  markCheckRunNativeTerminal,
  markCheckRunQueued,
  persistCheckRunPreparedInvocation,
  reconcileCheckRunInvocation,
  registerCheckRunInvocation,
  reapRetainedTransportChild,
  stageCheckRunFinalSettlement,
  withCheckRunSpawnPermit,
  writeCheckRunPreparationIntent,
  type CheckRunFinalSettlement,
  type CheckRunInvocationBinding,
  type CheckRunRegistration,
  type CheckRunTransportChildIdentity,
} from './check-run-settlement.ts';

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

async function preparedInvocation(): Promise<InvocationFixture> {
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
  const registration = await registerCheckRunInvocation(binding(), {
    stateDirectory: state,
    invocationId,
    candidateWorkspace: candidate,
    snapshot,
    returns: [],
    preparationIntent,
    descriptorFile: descriptor,
  });
  const preparedDescriptor = await persistCheckRunPreparedInvocation(registration, {
    stateDirectory: state,
    candidateWorkspace: candidate,
    snapshot,
    returns: [],
    descriptorFile: descriptor,
    execution: { schema: 1, originalEnvironment: { SECRET_FIXTURE: 'never-in-status' } },
  });
  expect(preparedDescriptor.invocationId).toBe(registration.invocationId);
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

async function queueAndStart(fixture: InvocationFixture): Promise<void> {
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
  await withCheckRunSpawnPermit(
    registration.invocationId,
    registration.nonce,
    'a',
    'original-run-1',
    () => ({ pid: transportChild.pid }),
    { stateDirectory: state },
    () => transportChild,
  );
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

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

test('Original prepared invocation retains durable input and cleanup custody across cancellation process loss unreadable child identity and unknown final reconciliation without replay replacement allocation lost cleanup reference or false settlement', async () => {
  const fixture = await preparedInvocation();
  await queueAndStart(fixture);
  const original = finalFor(fixture, 'unknown');
  const originalRecord = await acceptFinal(fixture, original);
  expect(originalRecord.final).toEqual(original);
  expect(originalRecord.finalCustody?.reconciliation).toBe('unknown');

  let observedPhysical: { host: 'a' | 'b'; run: string } | undefined;
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
