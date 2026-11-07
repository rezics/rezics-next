import { createIdentityNativeCommitRecorder } from '../../src/semantic/identity-adapters/native-commit.ts';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import type { CommandResult, CommandTransaction, CurrentCommand } from '../../src/command/command.ts';
import { IdentityEpochStoreError as ContractStoreError } from '../../src/semantic/contract/identity-errors.ts';
import type { NativeIdentityCapabilities } from '../../src/semantic/identity-adapter-port.ts';
import { createIdentityAdmissionOperations } from '../../src/semantic/identity-epoch-admission.ts';
import {
  createIdentityAdapterApplication,
  createNativeIdentityCapabilities,
  installIdentityAdapterRuntime,
} from '../../src/semantic/identity-adapter-runtime.ts';
import { IdentityEpochStoreError, identityEpochStore } from '../../src/semantic/identity-adapters/index.ts';
import type { IdentityIntent } from '../../src/semantic/identity-adapters/identity-epoch-contract.ts';
import { IdentityEpochStoreError as ClosureStoreError } from '../../src/semantic/identity-terminal-closure-errors.ts';
import { readIdentityMappings } from '../../src/semantic/identity-adapters/read.ts';
import { createIdentityRatingCommitParticipant } from '../../src/semantic/identity-rating-commit-participant.ts';
import {
  createReviewedPersonOperations,
  guardReviewedPersonIdentity,
  observeReviewedPersonIdentity,
} from '../../src/semantic/reviewed-person-identity.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

const original = '018f0000-0000-7000-8000-000000000001';
const pool = {} as Pool;
const unmerge: IdentityIntent = {
  kind: 'unmerge',
  original,
  undoJob: { jobId: original, epoch: 1n },
  verificationReceipt: null,
  release: 'r1',
};
const accountReceipt = {
  kind: 'account-agent.verify' as const,
  account: original,
  receipt: original,
};
const personRelease = {
  types: { 'schema:Person': { properties: ['wdt:P3180'] } },
  properties: { 'wdt:P3180': { datatype: 'external-id' } },
};

function tx(): CommandTransaction {
  return { query: async () => ({ rows: [] }) } as unknown as CommandTransaction;
}

function command(partition = 0): CurrentCommand {
  return {
    partition,
    basis: null,
    time: {} as CurrentCommand['time'],
    transactionId: 'tx-1',
    authorization: null,
  };
}

function noEffect<T>(value: T): CommandResult<T> {
  return Object.freeze({ value, events: Object.freeze([]) });
}

class Conflict extends Error {
  constructor(readonly partition: number) {
    super(`conflict ${partition}`);
  }
}

function fakeAdmission(label: string, calls: string[]): NativeIdentityCapabilities['admission'] {
  return {
    async prepareAdmission() {
      calls.push(`${label}:admission`);
      return { jobId: original, epoch: 1n };
    },
    async bindReceipt() {
      calls.push(`${label}:admission`);
      return {
        partition: 0,
        generation: '1',
        transactionId: 'tx-1',
        jobHome: 0,
        job: { jobId: original, epoch: 1n },
      };
    },
    async admitBound() {
      calls.push(`${label}:admission`);
      return noEffect({ jobId: original, epoch: 1n });
    },
    async guardReviewedPerson() {
      calls.push(`${label}:admission`);
    },
    identityHomeAvailable: (partition, after = '00000000-0000-0000-0000-000000000000') => ({
      type: 'home-available',
      data: { partition, after },
    }),
  };
}

function capabilities(overrides: Partial<NativeIdentityCapabilities> = {}): NativeIdentityCapabilities {
  const base: NativeIdentityCapabilities = {
    read: {
      async withReadTransaction(_pool, read) {
        return read({
          query: async () => ({ rows: [] }),
        } as never);
      },
    },
    command: {
      currentCommand: () => command(),
      currentCommandResources: () => ({ deadline: Date.now() + 5_000 }),
      async runCommand(_pool, _options, body) {
        return body(tx());
      },
      registerCommandCallback() {},
      noEffect,
      deadlineClient: (tx) => tx,
      IdempotencyConflictError: Conflict,
    },
    routing: {
      importedTupleRoute: () => 0,
    },
    slots: {
      async effectiveGlobalSlotFacts() {
        return { facts: [], basis: null };
      },
      isAccessUnavailable: () => false,
      editorialConflict: () => new Error('editorial'),
    },
    ratingReview: {
      subjectChanged: () => new Error('subject_changed'),
      identityEpochChanged: () => new Error('identity_epoch_changed'),
      pending: () => new Error('pending'),
      moved: () => new Error('moved'),
      absent: () => new Error('absent'),
      undisclosed: () => new Error('undisclosed'),
      unavailable: () => new Error('unavailable'),
      foreignControl: () => new Error('foreign-control'),
    },
    reviewedPerson: {
      async observe() {
        return null;
      },
      async guard() {},
    },
    admission: fakeAdmission('base', []),
    accountIdentity: {
      async readSource() {
        return {
          input: { intent: unmerge, receipt: accountReceipt },
          partition: 0,
          epoch: 1,
          position: 1n,
          transactionId: 'tx-1',
          digest: 'd',
          workflowId: 'w',
          roles: [],
        };
      },
      async loadSource() {
        throw new Error('loadSource unused');
      },
      assertSource() {},
      async readTechnicalSource() {
        return null;
      },
      async verifyReversalSettlement() {
        return false;
      },
      classifyUnavailability: () => false,
    },
  };
  return { ...base, ...overrides, read: { ...base.read, ...overrides.read } };
}

test('ordinary identity, reviewed Person and Rating participant use the same constructed native capabilities', async () => {
  const reads: string[] = [];
  const agentReads: string[] = [];
  const caps = capabilities({
    read: {
      async withReadTransaction(_pool, read) {
        reads.push('mapping');
        return read({ query: async () => ({ rows: [] }) } as never);
      },
    },
    accountIdentity: {
      async readSource() {
        agentReads.push('source');
        return {
          input: { intent: unmerge, receipt: accountReceipt },
          partition: 0,
          epoch: 1,
          position: 1n,
          transactionId: 'tx-1',
          digest: 'd',
          workflowId: 'w',
          roles: [],
        };
      },
      async loadSource() {
        throw new Error('loadSource unused');
      },
      assertSource() {},
      async readTechnicalSource() {
        return null;
      },
      async verifyReversalSettlement() {
        return false;
      },
      classifyUnavailability: () => false,
    },
  });
  try {
    const port = installIdentityAdapterRuntime(caps);

    expect(
      await port.store.prepareAdmission(pool, {}, { intent: unmerge, receipt: { kind: 'erased' } as never }),
    ).toEqual({
      jobId: original,
      epoch: 1n,
    });
    expect(
      await identityEpochStore().prepareAdmission(pool, {}, { intent: unmerge, receipt: { kind: 'erased' } as never }),
    ).toEqual({
      jobId: original,
      epoch: 1n,
    });

    const mappings = await readIdentityMappings(pool, [original]);
    expect(reads.length).toBeGreaterThan(0);
    expect(mappings).toEqual([{ state: 'unavailable', reason: 'bootstrap' }]);

    await expect(
      observeReviewedPersonIdentity(tx(), original, { source: 'vndb', externalId: 's1' }, new Uint8Array(32), {
        types: {},
        properties: {},
      } as never),
    ).resolves.toBeNull();
    await expect(
      guardReviewedPersonIdentity(
        tx(),
        {
          endpoints: [
            {
              subject: original,
              revision: 1,
              securityRevision: '1',
              source: 'vndb',
              externalId: 's1',
              claimTransactionId: original,
              property: 'wdt:P3180',
              value: 's1',
            },
            {
              subject: original,
              revision: 1,
              securityRevision: '1',
              source: 'vndb',
              externalId: 's2',
              claimTransactionId: original,
              property: 'wdt:P3180',
              value: 's2',
            },
          ],
        },
        new Uint8Array(32),
        { types: {}, properties: {} } as never,
      ),
    ).rejects.toThrow('atomic_guard_unavailable');

    const participant = createIdentityRatingCommitParticipant();
    expect(() => participant.prepare({ version: 1 } as never)).toThrow(TypeError);
    await expect(participant.admit(tx(), {} as never)).rejects.toThrow('Unknown identity rating commit preparation');

    expect(IdentityEpochStoreError).toBe(ContractStoreError);
    expect(ClosureStoreError).toBe(ContractStoreError);
    expect(await identityEpochStore().findJob(tx(), accountReceipt)).toBeNull();
    expect(agentReads).toEqual(['source']);
  } finally {
    installIdentityAdapterRuntime(createNativeIdentityCapabilities());
  }
});

test('live native capabilities report Access unavailability as boolean', () => {
  const caps = createNativeIdentityCapabilities();
  expect(caps.accountIdentity.classifyUnavailability(new Error('other'))).toBe(false);
  expect(caps.accountIdentity.classifyUnavailability(new AccessUnavailableError('deadline'))).toBe(true);
});

function witnessingLeaves(
  label: string,
  calls: string[],
  options: { beforeRead?: () => Promise<void>; beforeCommand?: () => Promise<void> } = {},
): Omit<NativeIdentityCapabilities, 'reviewedPerson' | 'admission'> {
  const home = partitionOf(routeOf(original)!);
  return {
    read: {
      async withReadTransaction(_pool, read) {
        calls.push(`${label}:read`);
        if (options.beforeRead) await options.beforeRead();
        return read({
          query: async () => ({ rows: [] }),
        } as never);
      },
    },
    command: {
      currentCommand: () => {
        calls.push(`${label}:command`);
        return command(home);
      },
      currentCommandResources: () => ({ deadline: Date.now() + 5_000 }),
      async runCommand(_pool, _options, body) {
        calls.push(`${label}:command`);
        if (options.beforeCommand) await options.beforeCommand();
        return body(tx());
      },
      registerCommandCallback(_tx, callback) {
        calls.push(`${label}:deferred`);
        void callback('tx-1');
      },
      noEffect,
      deadlineClient: (held) => {
        calls.push(`${label}:rating`);
        return held;
      },
      IdempotencyConflictError: Conflict,
    },
    routing: {
      importedTupleRoute: () => {
        calls.push(`${label}:command`);
        return (home + 1) * 16;
      },
    },
    slots: {
      async effectiveGlobalSlotFacts() {
        return { facts: [], basis: null };
      },
      isAccessUnavailable: () => false,
      editorialConflict: () => new Error(`${label}:editorial`),
    },
    ratingReview: {
      subjectChanged: () => {
        calls.push(`${label}:rating`);
        return new Error(`${label}:subject_changed`);
      },
      identityEpochChanged: () => {
        calls.push(`${label}:rating`);
        return new Error(`${label}:identity_epoch_changed`);
      },
      pending: () => new Error(`${label}:pending`),
      moved: () => new Error(`${label}:moved`),
      absent: () => new Error(`${label}:absent`),
      undisclosed: () => new Error(`${label}:undisclosed`),
      unavailable: () => new Error(`${label}:unavailable`),
      foreignControl: () => new Error(`${label}:foreign-control`),
    },
    accountIdentity: {
      async readSource() {
        calls.push(`${label}:account`);
        return {
          input: { intent: unmerge, receipt: accountReceipt },
          partition: home,
          epoch: 1,
          position: 1n,
          transactionId: 'tx-1',
          digest: 'd',
          workflowId: 'w',
          roles: [],
        };
      },
      async loadSource() {
        throw new Error('loadSource unused');
      },
      assertSource() {},
      async readTechnicalSource() {
        return null;
      },
      async verifyReversalSettlement() {
        return false;
      },
      classifyUnavailability: () => false,
    },
  };
}

function completeCapabilities(
  leaves: Omit<NativeIdentityCapabilities, 'reviewedPerson' | 'admission'>,
): NativeIdentityCapabilities {
  const capabilities = { ...leaves } as NativeIdentityCapabilities;
  Object.assign(capabilities, { reviewedPerson: createReviewedPersonOperations(capabilities) });
  const admission = createIdentityAdmissionOperations(capabilities);
  Object.assign(capabilities, {
    admission: Object.freeze({
      prepareAdmission: admission.prepareAdmission,
      bindReceipt: admission.bindReceipt,
      admitBound: admission.admitBound,
      guardReviewedPerson: admission.guardReviewedPerson,
      identityHomeAvailable: admission.identityHomeAvailable,
    }),
  });
  return Object.freeze(capabilities);
}

test('two constructed applications retain independent capabilities across store, read, admission and nested work', async () => {
  const calls: string[] = [];
  let releaseA!: () => void;
  let releaseB!: () => void;
  const gateA = new Promise<void>((resolve) => (releaseA = resolve));
  const gateB = new Promise<void>((resolve) => (releaseB = resolve));
  const capsA = completeCapabilities(witnessingLeaves('app-a', calls, { beforeRead: () => gateA }));
  const capsB = completeCapabilities(witnessingLeaves('app-b', calls, { beforeRead: () => gateB }));
  const applicationA = createIdentityAdapterApplication(capsA);
  const applicationB = createIdentityAdapterApplication(capsB);
  try {
    installIdentityAdapterRuntime(capsB);

    const pendingA = applicationA.store.prepareAdmission(pool, {}, { intent: unmerge, receipt: accountReceipt });
    const pendingB = applicationB.store.prepareAdmission(pool, {}, { intent: unmerge, receipt: accountReceipt });
    releaseB();
    await expect(pendingB).rejects.toThrow(IdentityEpochStoreError);
    releaseA();
    await expect(pendingA).rejects.toThrow(IdentityEpochStoreError);

    expect(calls.filter((call) => call.startsWith('app-a:'))).toEqual(
      expect.arrayContaining(['app-a:command', 'app-a:account', 'app-a:read']),
    );
    expect(calls.filter((call) => call.startsWith('app-b:'))).toEqual(
      expect.arrayContaining(['app-b:command', 'app-b:account', 'app-b:read']),
    );

    const mappingsA = await applicationA.read.readIdentityMappings(pool, [original]);
    const mappingsB = await readIdentityMappings(pool, [original]);
    expect(mappingsA).toEqual([{ state: 'unavailable', reason: 'bootstrap' }]);
    expect(mappingsB).toEqual([{ state: 'unavailable', reason: 'bootstrap' }]);

    await expect(
      applicationA.reviewedPerson.guard(
        tx(),
        {
          endpoints: [
            {
              subject: original,
              revision: 1,
              securityRevision: '1',
              source: 'vndb',
              externalId: 's1',
              claimTransactionId: original,
              property: 'wdt:P3180',
              value: 's1',
            },
            {
              subject: original,
              revision: 1,
              securityRevision: '1',
              source: 'vndb',
              externalId: 's2',
              claimTransactionId: original,
              property: 'wdt:P3180',
              value: 's2',
            },
          ],
        },
        new Uint8Array(32),
        personRelease as never,
      ),
    ).rejects.toThrow('atomic_guard_unavailable');

    await expect(applicationA.ratingParticipant.admit(tx(), {} as never)).rejects.toThrow(
      'Unknown identity rating commit preparation',
    );
    await expect(applicationB.ratingParticipant.admit(tx(), {} as never)).rejects.toThrow(
      'Unknown identity rating commit preparation',
    );

    const retained = await applicationA.store.findJob(tx(), accountReceipt);
    expect(retained).toBeNull();
    expect(calls.filter((call) => call === 'app-a:account').length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((call) => call === 'app-a:command').length).toBeGreaterThanOrEqual(2);
    expect(applicationA.store).not.toBe(identityEpochStore());
    expect(applicationA.ratingParticipant).not.toBe(applicationB.ratingParticipant);
  } finally {
    installIdentityAdapterRuntime(createNativeIdentityCapabilities());
  }
});

test('native commit leaves retain one transaction callback and purpose across capability sets', async () => {
  const callbacks: Array<(transactionId: string) => void | Promise<void>> = [];
  const writes: unknown[][] = [];
  const transaction = {
    async query(_sql: string, params: unknown[]) {
      writes.push(params);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as CommandTransaction;
  const base = capabilities();
  const native = {
    ...base,
    command: {
      ...base.command,
      registerCommandCallback(_tx: CommandTransaction, callback: (transactionId: string) => void | Promise<void>) {
        callbacks.push(callback);
      },
    },
  };
  const first = createIdentityNativeCommitRecorder(native);
  const second = createIdentityNativeCommitRecorder({ ...native });
  expect(callbacks).toHaveLength(0);
  first(transaction, 'admission');
  second(transaction, 'admission');
  expect(callbacks).toHaveLength(1);
  expect(writes).toEqual([]);
  expect(() => second(transaction, 'different-purpose')).toThrow('Conflicting identity native commit purposes');
  await callbacks[0]!('tx-committed');
  expect(writes).toEqual([[0, 'tx-committed', 'admission']]);

  const unavailable = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as CommandTransaction;
  first(unavailable, 'admission');
  expect(callbacks).toHaveLength(2);
  await expect(callbacks[1]!('tx-unavailable')).rejects.toBeInstanceOf(ContractStoreError);
});
