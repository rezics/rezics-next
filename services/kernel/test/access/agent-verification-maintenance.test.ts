import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { AgentIdentityMaintenancePort } from '../../src/access/adapters/index.ts';
import { agentIdentityMaintenance, bindAgentIdentityMaintenance } from '../../src/access/adapters/bind.ts';
import { mergeVerifiedAgent } from '../../src/access/agent-verification.ts';
import { loadAccountIdentitySource } from '../../src/access/agent-verification-identity.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { IdentityEpochStoreError } from '../../src/semantic/contract/index.ts';
import { IdentityEpochStoreError as NativeIdentityError } from '../../src/semantic/identity-terminal-closure-errors.ts';

const account = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const receipt = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const unused = (): never => {
  throw new Error('Unexpected identity producer call');
};

function fake(overrides: Partial<AgentIdentityMaintenancePort>): AgentIdentityMaintenancePort {
  return {
    runTerminalCommand: unused,
    accountAgentId: unused,
    activeRelease: unused,
    withReadTransaction: unused,
    verifyAccountAgent: unused,
    unverifyAccountAgent: unused,
    store: unused,
    jobPartition: unused,
    resume: unused,
    waitPublished: unused,
    readOriginal: unused,
    readUndo: unused,
    lookupBinding: unused,
    acceptedBinding: unused,
    verifyCustody: unused,
    activeMaintenance: unused,
    currentMaintenance: unused,
    isLiveMaintenance: unused,
    isPrepaidMaintenance: unused,
    reserveNativeWork: unused,
    originalUnavailable: unused,
    acceptedBindingDeclaration: unused,
    retainedReferenceDeclaration: unused,
    retainedReference: unused,
    readPublishedScope: unused,
    ...overrides,
  };
}

test('verification forwards the native Pool and exact reviewed receipt through the composed producer', async () => {
  const pool = {} as Pool;
  const failure = new Error('producer failed');
  const received: unknown[] = [];
  const previous = agentIdentityMaintenance();
  const dispose = bindAgentIdentityMaintenance(
    fake({
      async verifyAccountAgent(native, input) {
        received.push(native, input);
        throw failure;
      },
    }),
  );
  try {
    await expect(
      mergeVerifiedAgent(pool, {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        state: 'approving',
        decisionReceiptId: receipt,
        accountId: account,
        accountKind: 'actor',
        catalogueSubjectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        requestedBy: account,
        receiptId: receipt,
      }),
    ).rejects.toBe(failure);
    expect(received).toEqual([
      pool,
      {
        account,
        catalogue: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        receipt,
      },
    ]);
  } finally {
    dispose();
  }
  expect(agentIdentityMaintenance()).toBe(previous);
});

test('original source load retains the caller deadline and original home on the terminal-fenced command', async () => {
  const pool = {} as Pool;
  const deadline = Date.now() + 4000;
  const failure = new Error('terminal unavailable');
  const observed: unknown[] = [];
  const dispose = bindAgentIdentityMaintenance(
    fake({
      runTerminalCommand(native, options) {
        observed.push(native, options);
        throw failure;
      },
    }),
  );
  try {
    await expect(
      withRequestDeadline(deadline, () =>
        loadAccountIdentitySource(pool, {
          kind: 'account-agent.verify',
          account,
          receipt,
        }),
      ),
    ).rejects.toBe(failure);
    expect(observed).toEqual([pool, { partition: partitionOf(routeOf(account)!), deadline }]);
  } finally {
    dispose();
  }
});

test('native failures and pure contract consumers share the same error identity', () => {
  const failure = new NativeIdentityError('identity_epoch_unavailable', 'pending');
  expect(failure).toBeInstanceOf(IdentityEpochStoreError);
  expect(failure.code).toBe('identity_epoch_unavailable');
});
