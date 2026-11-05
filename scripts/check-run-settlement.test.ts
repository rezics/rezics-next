import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptCheckRunFinalSettlement,
  allocateCheckRunPhysical,
  beginCheckRunAllocation,
  cancelCheckRunInvocation,
  claimCheckRunPreparedInvocation,
  createCheckRunFinalSettlement,
  decodeCheckRunSettlement,
  getCheckRunStatus,
  markCheckRunNativeTerminal,
  markCheckRunQueued,
  reconcileCheckRunInvocation,
  registerCheckRunInvocation,
  persistCheckRunPreparedInvocation,
  withCheckRunSpawnPermit,
  type CheckRunInvocationBinding,
} from './check-run-settlement.ts';

const directories: string[] = [];
const temporaryRoot = join(import.meta.dir, '..', '.temp');

function stateDirectory(): string {
  mkdirSync(temporaryRoot, { recursive: true });
  const path = mkdtempSync(join(temporaryRoot, `check-run-settlement-${randomUUID()}-`));
  chmodSync(path, 0o700);
  directories.push(path);
  return path;
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
    returnsSha256: '4'.repeat(64),
  };
}

const preparedInputs = {
  status: 'verified' as const,
  sourceSha256: 'c'.repeat(64),
  manifestSha256: '5'.repeat(64),
  fileCount: 11,
  totalBytes: 2048,
};

function finalMessage(registration: Awaited<ReturnType<typeof registerCheckRunInvocation>>) {
  return createCheckRunFinalSettlement({
    invocationId: registration.invocationId,
    nonce: registration.nonce,
    binding: registration.binding,
    physical: { host: 'a', run: 'physical-run-abc123' },
    native: { exitCode: 0, lifetimeFailure: false, receiptSha256: '6'.repeat(64) },
    preparedInputs,
    returns: {
      status: 'empty',
      declarationsSha256: registration.binding.returnsSha256,
      entries: [],
      missing: [],
      failures: [],
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
  });
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test('final bounded authenticated invocation binding rejects replay mismatch and partial messages', async () => {
  const state = stateDirectory();
  const registered = await registerCheckRunInvocation(binding(), { stateDirectory: state });
  await markCheckRunQueued(registered.invocationId, registered.nonce, { stateDirectory: state });
  await allocateCheckRunPhysical(registered.invocationId, registered.nonce, 'a', 'physical-run-abc123', {
    stateDirectory: state,
  });
  await markCheckRunNativeTerminal(
    registered.invocationId,
    registered.nonce,
    { host: 'a', run: 'physical-run-abc123', exitCode: 0, receiptSha256: '6'.repeat(64) },
    { stateDirectory: state },
  );
  const message = finalMessage(registered);
  const encoded = JSON.stringify(message);
  const expected = {
    invocationId: registered.invocationId,
    nonce: registered.nonce,
    binding: registered.binding,
    physical: { host: 'a', run: 'physical-run-abc123' },
    nativeTerminalSeen: true,
  };
  expect(decodeCheckRunSettlement(encoded, expected)).toEqual(message);
  expect(() => decodeCheckRunSettlement(`${encoded} ${encoded}`, expected)).toThrow();
  expect(() => decodeCheckRunSettlement(' '.repeat(65 * 1024), expected)).toThrow();
  expect(() => decodeCheckRunSettlement(encoded.slice(0, -1), expected)).toThrow();
  expect(() => decodeCheckRunSettlement(encoded, { ...expected, nonce: randomUUID() })).toThrow();
  expect(() => decodeCheckRunSettlement(encoded, { ...expected, invocationId: randomUUID() })).toThrow();
  expect(() =>
    decodeCheckRunSettlement(encoded, {
      ...expected,
      binding: { ...registered.binding, sourceRevision: '9'.repeat(40) },
    }),
  ).toThrow();
  expect(() =>
    decodeCheckRunSettlement(encoded, {
      ...expected,
      binding: { ...registered.binding, argvSha256: '8'.repeat(64) },
    }),
  ).toThrow();
  expect(() => decodeCheckRunSettlement(encoded, { ...expected, nativeTerminalSeen: false })).toThrow();
  await acceptCheckRunFinalSettlement(encoded, { stateDirectory: state });
  await expect(acceptCheckRunFinalSettlement(encoded, { stateDirectory: state })).rejects.toThrow(/duplicate|replay/i);
  const retained = await getCheckRunStatus(registered.invocationId, { stateDirectory: state });
  expect(retained.final).toEqual(message);
});

test('durable queued and in-flight cancellation and reconciliation retain unknown custody without a replacement command', async () => {
  const state = stateDirectory();
  const queued = await registerCheckRunInvocation(binding(), { stateDirectory: state });
  await markCheckRunQueued(queued.invocationId, queued.nonce, { stateDirectory: state });
  await cancelCheckRunInvocation(queued.invocationId, queued.nonce, 15, { stateDirectory: state });
  let queuedSpawns = 0;
  await expect(
    withCheckRunSpawnPermit(
      queued.invocationId,
      queued.nonce,
      'a',
      'queued-run-never-started',
      () => {
        queuedSpawns += 1;
        return 'spawned';
      },
      { stateDirectory: state },
    ),
  ).rejects.toThrow(/cancel/i);
  expect(queuedSpawns).toBe(0);

  const active = await registerCheckRunInvocation(binding(), { stateDirectory: state });
  await markCheckRunQueued(active.invocationId, active.nonce, { stateDirectory: state });
  await allocateCheckRunPhysical(active.invocationId, active.nonce, 'b', 'physical-run-in-flight', {
    stateDirectory: state,
  });
  let spawns = 0;
  await withCheckRunSpawnPermit(
    active.invocationId,
    active.nonce,
    'b',
    'physical-run-in-flight',
    () => {
      spawns += 1;
      return 'spawned';
    },
    { stateDirectory: state },
  );
  await cancelCheckRunInvocation(active.invocationId, active.nonce, 2, { stateDirectory: state });
  const observations: Array<{ host: string; run: string }> = [];
  const unknown = await reconcileCheckRunInvocation(active.invocationId, {
    stateDirectory: state,
    reconcilePhysical: async (physical) => {
      observations.push(physical);
      return { disposition: 'unknown', reason: 'mock host evidence unavailable' };
    },
  });
  expect(observations).toEqual([{ host: 'b', run: 'physical-run-in-flight' }]);
  expect(unknown.phase).toBe('unknown');
  expect(unknown.snapshot).toBeDefined();
  expect(spawns).toBe(1);
  const repeated = await reconcileCheckRunInvocation(active.invocationId, {
    stateDirectory: state,
    reconcilePhysical: async () => {
      throw new Error('unknown custody must not allocate or replace the original run');
    },
  });
  expect(repeated.phase).toBe('unknown');
  expect((await getCheckRunStatus(active.invocationId, { stateDirectory: state })).physical).toEqual({
    host: 'b',
    run: 'physical-run-in-flight',
  });
});

test('prepared descriptor records the prior binding, claims once, and fences queued cancellation', async () => {
  const state = stateDirectory();
  const candidateRoot = mkdtempSync(join(temporaryRoot, `check-run-prepared-candidate-${randomUUID()}-`));
  directories.push(candidateRoot);
  const selectedBinding = {
    ...binding(),
    returnsSha256: (await import('node:crypto')).createHash('sha256').update('[]').digest('hex'),
  };
  const registration = await registerCheckRunInvocation(selectedBinding, {
    stateDirectory: state,
    candidateWorkspace: candidateRoot,
  });
  const descriptorFile = join(state, 'caller.json');
  const descriptor = await persistCheckRunPreparedInvocation(registration, {
    stateDirectory: state,
    candidateWorkspace: candidateRoot,
    snapshot: {
      workspace: join(candidateRoot, '.temp', 'frozen'),
      scratch: join(candidateRoot, '.temp', 'scratch'),
      sourceSha256: selectedBinding.sourceSha256,
      inputFiles: ['src/input.ts'],
    },
    returns: [],
    descriptorFile,
    execution: { secretEnvironment: 'private-only' },
  });
  const record = await getCheckRunStatus(registration.invocationId, { stateDirectory: state });
  expect(record.phase).toBe('prepared');
  expect(record.binding).toEqual(selectedBinding);
  expect(record.snapshot?.workspace).toBe(join(candidateRoot, '.temp', 'frozen'));
  expect(record.preparedExecution).toBeDefined();
  expect(record.descriptor?.file).toBe(descriptorFile);
  expect(JSON.stringify(record)).not.toContain('private-only');
  expect(descriptor).toMatchObject({ schema: 1, type: 'check-run-preparation', binding: selectedBinding });

  const symlinkedDescriptor = join(state, 'descriptor-link.json');
  symlinkSync(descriptorFile, symlinkedDescriptor);
  await expect(claimCheckRunPreparedInvocation(symlinkedDescriptor, { stateDirectory: state })).rejects.toThrow(
    /private regular file|readable/i,
  );
  chmodSync(descriptorFile, 0o644);
  await expect(claimCheckRunPreparedInvocation(descriptorFile, { stateDirectory: state })).rejects.toThrow(
    /owner-only/i,
  );
  chmodSync(descriptorFile, 0o600);

  const claimed = await claimCheckRunPreparedInvocation(descriptorFile, { stateDirectory: state });
  expect(claimed.record.phase).toBe('claimed');
  expect(claimed.execution).toEqual({ secretEnvironment: 'private-only' });
  await expect(claimCheckRunPreparedInvocation(descriptorFile, { stateDirectory: state })).rejects.toThrow(/claim/i);
  await markCheckRunQueued(registration.invocationId, registration.nonce, {
    stateDirectory: state,
    candidateWorkspace: candidateRoot,
    returns: [],
    snapshot: record.snapshot!,
  });
  await allocateCheckRunPhysical(registration.invocationId, registration.nonce, 'a', 'prepared-queued-run', {
    stateDirectory: state,
  });
  await cancelCheckRunInvocation(registration.invocationId, registration.nonce, 15, { stateDirectory: state });
  let spawnCount = 0;
  await expect(
    withCheckRunSpawnPermit(
      registration.invocationId,
      registration.nonce,
      'a',
      'prepared-queued-run',
      () => {
        spawnCount += 1;
      },
      { stateDirectory: state },
    ),
  ).rejects.toThrow(/cancel/i);
  expect(spawnCount).toBe(0);
  const retained = await reconcileCheckRunInvocation(registration.invocationId, { stateDirectory: state });
  expect(retained.phase).toBe('unknown');
  expect(retained.snapshot?.workspace).toBe(record.snapshot?.workspace);
  expect(retained.snapshotCustody).toBe('owned');

  const abandoned = await registerCheckRunInvocation(selectedBinding, {
    stateDirectory: state,
    candidateWorkspace: candidateRoot,
  });
  const abandonedDescriptor = join(state, 'abandoned.json');
  await persistCheckRunPreparedInvocation(abandoned, {
    stateDirectory: state,
    candidateWorkspace: candidateRoot,
    snapshot: {
      workspace: join(candidateRoot, '.temp', 'abandoned-frozen'),
      scratch: join(candidateRoot, '.temp', 'abandoned-scratch'),
      sourceSha256: selectedBinding.sourceSha256,
      inputFiles: ['src/input.ts'],
    },
    returns: [],
    descriptorFile: abandonedDescriptor,
    execution: { run: 'must-not-start' },
  });
  await cancelCheckRunInvocation(abandoned.invocationId, abandoned.nonce, 15, { stateDirectory: state });
  await expect(claimCheckRunPreparedInvocation(abandonedDescriptor, { stateDirectory: state })).rejects.toThrow(
    /cannot be claimed/i,
  );
  const abandonedState = await reconcileCheckRunInvocation(abandoned.invocationId, {
    stateDirectory: state,
    force: true,
  });
  expect(abandonedState.phase).toBe('cancelled');
  expect(abandonedState.snapshot?.workspace).toBe(join(candidateRoot, '.temp', 'abandoned-frozen'));
});

test('an unknown earlier invocation does not block a new registration or require reconciliation first', async () => {
  const state = stateDirectory();
  const earlier = await registerCheckRunInvocation(binding(), { stateDirectory: state });
  await markCheckRunQueued(earlier.invocationId, earlier.nonce, { stateDirectory: state });
  await allocateCheckRunPhysical(earlier.invocationId, earlier.nonce, 'a', 'unknown-earlier-run', {
    stateDirectory: state,
  });
  const unknown = await reconcileCheckRunInvocation(earlier.invocationId, {
    stateDirectory: state,
    reconcilePhysical: async () => ({ disposition: 'unknown', reason: 'mock host evidence unavailable' }),
  });
  expect(unknown.phase).toBe('unknown');

  const next = await registerCheckRunInvocation(binding(), { stateDirectory: state });
  expect(next.invocationId).not.toBe(earlier.invocationId);
  const leftover = await reconcileCheckRunInvocation(earlier.invocationId, {
    stateDirectory: state,
    reconcilePhysical: async () => {
      throw new Error('unknown earlier runs must not be reconciled to prevent a later invocation');
    },
  });
  expect(leftover.phase).toBe('unknown');
  expect(leftover.invocationId).toBe(earlier.invocationId);
  expect((await getCheckRunStatus(next.invocationId, { stateDirectory: state })).phase).toBe('registered');
});

test('queueing rejects an unclaimed prepared invocation and preserves claimed identity behind cancellation fencing', async () => {
  const state = stateDirectory();
  const candidateRoot = mkdtempSync(join(temporaryRoot, `check-run-queue-candidate-${randomUUID()}-`));
  directories.push(candidateRoot);
  const selectedBinding = {
    ...binding(),
    returnsSha256: (await import('node:crypto')).createHash('sha256').update('[]').digest('hex'),
  };
  const registration = await registerCheckRunInvocation(selectedBinding, {
    stateDirectory: state,
    candidateWorkspace: candidateRoot,
  });
  const descriptorFile = join(state, 'queueing.json');
  const snapshot = {
    workspace: join(candidateRoot, '.temp', 'original-frozen'),
    scratch: join(candidateRoot, '.temp', 'original-scratch'),
    sourceSha256: selectedBinding.sourceSha256,
    inputFiles: ['src/input.ts'],
  };
  await persistCheckRunPreparedInvocation(registration, {
    stateDirectory: state,
    candidateWorkspace: candidateRoot,
    snapshot,
    returns: [],
    descriptorFile,
    execution: { command: ['bun', 'test'] },
  });

  await expect(
    markCheckRunQueued(registration.invocationId, registration.nonce, {
      stateDirectory: state,
      candidateWorkspace: candidateRoot,
      returns: [],
      snapshot,
    }),
  ).rejects.toThrow(/cannot queue from prepared/i);
  const unclaimed = await getCheckRunStatus(registration.invocationId, { stateDirectory: state });
  expect(unclaimed.phase).toBe('prepared');
  expect(unclaimed.snapshot).toEqual({ ...snapshot, sourceSha256: selectedBinding.sourceSha256 });
  expect(unclaimed.physical).toBeNull();

  await claimCheckRunPreparedInvocation(descriptorFile, { stateDirectory: state });
  const substitutedSnapshot = {
    ...snapshot,
    workspace: join(candidateRoot, '.temp', 'substituted-frozen'),
  };
  await expect(
    markCheckRunQueued(registration.invocationId, registration.nonce, {
      stateDirectory: state,
      candidateWorkspace: candidateRoot,
      returns: [],
      snapshot: substitutedSnapshot,
    }),
  ).rejects.toThrow(/cannot be rebound/i);
  const claimed = await getCheckRunStatus(registration.invocationId, { stateDirectory: state });
  expect(claimed.phase).toBe('claimed');
  expect(claimed.invocationId).toBe(registration.invocationId);
  expect(claimed.binding).toEqual(selectedBinding);
  expect(claimed.candidateWorkspace).toBe(candidateRoot);
  expect(claimed.snapshot).toEqual(unclaimed.snapshot);

  await markCheckRunQueued(registration.invocationId, registration.nonce, {
    stateDirectory: state,
    candidateWorkspace: candidateRoot,
    returns: [],
    snapshot,
  });
  await cancelCheckRunInvocation(registration.invocationId, registration.nonce, 15, { stateDirectory: state });
  await expect(
    beginCheckRunAllocation(registration.invocationId, registration.nonce, { stateDirectory: state }),
  ).rejects.toThrow(/cancel/i);
  const fenced = await getCheckRunStatus(registration.invocationId, { stateDirectory: state });
  expect(fenced.invocationId).toBe(registration.invocationId);
  expect(fenced.snapshot).toEqual(unclaimed.snapshot);
  expect(fenced.physical).toBeNull();
  expect(fenced.cancellation.requested).toBe(true);
});
