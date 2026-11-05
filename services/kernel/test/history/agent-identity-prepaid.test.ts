import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { WorkClient } from '../../src/work/client.ts';
import { HistoryRegistry } from '../../src/history/registry.ts';
import {
  withPrepaidAgentIdentityHistoryUnit,
  withAgentIdentityHistoryUnit,
  currentAgentIdentityHistoryUnit,
} from '../../src/history/agent-identity-retirement.ts';
import {
  accountHistoryWork,
  accountHistoryWorkDeclaration,
  addNativeWork,
  nativeWork,
  IDENTITY_HISTORY_ACCOUNTS_DECLARATION,
  IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK,
} from '../../src/history/agent-identity-inventory-work.ts';
import { identitySourceConsumerNativeWork } from '../../src/semantic/identity-source-consumer-maintenance.ts';
import {
  type IdentityOriginalSourceContext,
  type PrepaidAgentIdentityHistoryUnit,
} from '../../src/access/identity-original-admission.ts';

// This sentinel supplies no native result, transaction, original or positive receipt.
function noIO() {
  let attempts = 0;
  const pool = {
    connect() {
      attempts++;
      throw new Error('unexpected native dispatch');
    },
  } as unknown as Pool;
  return {
    deps: { pool, client: {} as WorkClient, registry: new HistoryRegistry(), env: {}, clock: () => new Date() },
    attempts: () => attempts,
  };
}

const callable: PrepaidAgentIdentityHistoryUnit = withPrepaidAgentIdentityHistoryUnit;

test('The installed Accounts entry refuses manufactured, copied, missing and expired original grants before dispatch', async () => {
  const f = noIO();
  let called = 0;
  for (const original of [undefined, {}, Object.freeze({})]) {
    for (const deadline of [Date.now() + 5000, Date.now() - 1]) {
      const publicParent = {
        original,
        originalId: 'public-original',
        jobId: 'public-job',
        position: {},
        deadline,
        native: IDENTITY_HISTORY_ACCOUNTS_DECLARATION().local.command,
        library: {},
      } as unknown as IdentityOriginalSourceContext;
      for (const parent of [publicParent, Object.freeze({ ...publicParent })])
        await expect(
          callable(f.deps, parent, async () => {
            called++;
          }),
        ).rejects.toThrow('private-grant-unavailable');
    }
  }
  expect(called).toBe(0);
  expect(f.attempts()).toBe(0);
});

test('Prepaid refusal never consults environment funding or opens independent configured maintenance', async () => {
  const f = noIO();
  const deps = {
    ...f.deps,
    env: { KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_ROWS: 'invalid-independent-budget' },
  };
  await expect(callable(deps, {} as IdentityOriginalSourceContext, async () => {})).rejects.toThrow(
    'private-grant-unavailable',
  );
  expect(f.attempts()).toBe(0);
});

test('A nested prepaid entry poisons the existing unit without native work or replacement funding', async () => {
  const f = noIO();
  await withAgentIdentityHistoryUnit(f.deps, { deadline: Date.now() + 5000 }, async (funded) => {
    const before = identitySourceConsumerNativeWork(f.deps.pool, funded.identityConsumerWork, funded.deadline);
    await expect(callable(f.deps, {} as IdentityOriginalSourceContext, async () => {})).rejects.toThrow(
      'identity-history-unit-reentered',
    );
    expect(() => currentAgentIdentityHistoryUnit()).toThrow('identity-history-unit-reentered');
    expect(identitySourceConsumerNativeWork(f.deps.pool, funded.identityConsumerWork, funded.deadline)).toEqual(before);
  });
  expect(f.attempts()).toBe(0);
});

test('Known local SQL has all eight explicit axes; copied five-field bounds and unknown SQL cannot price a prepaid dispatch', () => {
  const d = IDENTITY_HISTORY_ACCOUNTS_DECLARATION();
  expect(d.axes).toHaveLength(8);
  expect(d.engineRequests).toBe(0);
  for (const [name, amount] of Object.entries(IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK)) {
    const declared = accountHistoryWorkDeclaration(amount)!;
    expect(declared).toEqual(d.local[name]!);
    expect(Object.keys(declared).sort()).toEqual([...d.axes].sort());
    expect(declared.candidateKeys).toBe(0);
    expect(declared.identityMetadataRows).toBe(0);
    expect(declared.witnessKeys).toBe(0);
    expect(accountHistoryWorkDeclaration({ ...amount })).toBeUndefined();
  }
  expect(accountHistoryWorkDeclaration(nativeWork(1, 1, 1, 64))).toBeUndefined();
  const known = accountHistoryWork(1, 1, 1, 64, 1);
  expect(accountHistoryWorkDeclaration(addNativeWork(known, known))!.emptySeeks).toBe(2);
  expect(accountHistoryWorkDeclaration(addNativeWork(known, nativeWork(0, 0, 1, 0)))).toBeUndefined();
  expect(d.missingTerms.some((term) => term.startsWith('LibraryAllReachedCalls:'))).toBe(true);
  expect(d.missingTerms.some((term) => term.startsWith('RecoveryReceivingEnrollment:'))).toBe(true);
  expect('work' in d).toBe(false); // An incomplete subdeclaration cannot pass original admission as a total.
});

test('The SDK declaration prices separate COMMIT and failure ROLLBACK slots without cancellation', () => {
  const d = IDENTITY_HISTORY_ACCOUNTS_DECLARATION();
  const names = ['rollback', 'begin', 'settings', 'lock', 'retire', 'commit'] as const;
  const sum = (axis: (typeof d.axes)[number]) => names.reduce((n, name) => n + d.sdk[name]![axis], 0);
  expect(sum('statements')).toBe(17);
  expect(d.sdk.rollback!.statements).toBe(1);
  expect(d.sdk.commit!.statements).toBe(1);
  expect(d.sdk.retire!.emptySeeks).toBe(5);
  for (const axis of d.axes) {
    expect(Number.isSafeInteger(sum(axis))).toBe(true);
    expect(sum(axis)).toBeGreaterThanOrEqual(0);
  }
});
