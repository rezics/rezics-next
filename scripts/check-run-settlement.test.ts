import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptCheckRunFinalSettlement,
  allocateCheckRunPhysical,
  cancelCheckRunInvocation,
  createCheckRunFinalSettlement,
  decodeCheckRunSettlement,
  getCheckRunStatus,
  markCheckRunNativeTerminal,
  markCheckRunQueued,
  reconcileCheckRunInvocation,
  registerCheckRunInvocation,
  withCheckRunSpawnPermit,
  type CheckRunInvocationBinding,
} from './check-run-settlement.ts';

const directories: string[] = [];

function stateDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), `check-run-settlement-${randomUUID()}-`));
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
