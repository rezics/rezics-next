import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { CommandResult, CommandTransaction, CurrentCommand } from '../../src/command/command.ts';
import { IdentityEpochStoreError as ContractStoreError } from '../../src/semantic/contract/identity-errors.ts';
import type { NativeIdentityCapabilities } from '../../src/semantic/identity-adapter-port.ts';
import { installIdentityAdapterRuntime } from '../../src/semantic/identity-adapter-runtime.ts';
import { IdentityEpochStoreError, identityEpochStore } from '../../src/semantic/identity-adapters/index.ts';
import type { IdentityIntent } from '../../src/semantic/identity-adapters/identity-epoch-contract.ts';
import { IdentityEpochStoreError as ClosureStoreError } from '../../src/semantic/identity-terminal-closure-errors.ts';
import { readIdentityMappings } from '../../src/semantic/identity-adapters/read.ts';
import { createIdentityRatingCommitParticipant } from '../../src/semantic/identity-rating-commit-participant.ts';
import {
  guardReviewedPersonIdentity,
  observeReviewedPersonIdentity,
} from '../../src/semantic/reviewed-person-identity.ts';

const original = '018f0000-0000-7000-8000-000000000001';
const pool = {} as Pool;
const unmerge: IdentityIntent = {
  kind: 'unmerge',
  original,
  undoJob: { jobId: original, epoch: 1n },
  verificationReceipt: null,
  release: 'r1',
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

function capabilities(overrides: Partial<NativeIdentityCapabilities> = {}): NativeIdentityCapabilities {
  const reads: Array<string> = [];
  const noEffect = <T>(value: T): CommandResult<T> => Object.freeze({ value, events: Object.freeze([]) });
  class Conflict extends Error {
    constructor(readonly partition: number) {
      super(`conflict ${partition}`);
    }
  }
  const base: NativeIdentityCapabilities = {
    read: {
      async withReadTransaction(_pool, read) {
        reads.push('home');
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
    admission: {
      async prepareAdmission() {
        return { jobId: original, epoch: 1n };
      },
      async bindReceipt() {
        return {
          partition: 0,
          generation: '1',
          transactionId: 'tx-1',
          jobHome: 0,
          job: { jobId: original, epoch: 1n },
        };
      },
      async admitBound() {
        return noEffect({ jobId: original, epoch: 1n });
      },
      async guardReviewedPerson() {},
      identityHomeAvailable: (partition, after = '00000000-0000-0000-0000-000000000000') => ({
        type: 'home-available',
        data: { partition, after },
      }),
    },
    accountIdentity: {
      async readSource() {
        return {
          input: { intent: unmerge, receipt: { kind: 'account-agent.verify', account: original, receipt: original } },
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
          input: { intent: unmerge, receipt: { kind: 'account-agent.verify', account: original, receipt: original } },
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
    expect(
      await identityEpochStore().findJob(tx(), {
        kind: 'account-agent.verify',
        account: original,
        receipt: original,
      }),
    ).toBeNull();
    expect(agentReads).toEqual(['source']);
  } finally {
    installIdentityAdapterRuntime();
  }
});
