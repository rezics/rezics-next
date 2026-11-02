import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import type { WorkClient } from '../../src/work/client.ts';
import {
  claimOperationalWorkOriginal,
  debitOperationalWorkAttempt,
  fundOperationalWorkOriginal,
  OPERATIONAL_WORK_LOCAL_DECLARATION,
  sumOperationalWork,
} from '../../src/history/operational-work-budget.ts';
import { ProblemError } from '../../src/http/problem.ts';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import {
  MEMBERS_PREPARATION_CHILDREN,
  declareMembersPreparationParent,
  transferMembersPreparationBudget,
  type MembersPreparationDeclarations,
} from '../../src/library/members-preparation-budget.ts';

const axes = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
] as const;
const cost = (amount: number): WorkDimensions => ({
  candidateKeys: amount,
  nativeRows: amount,
  identityMetadataRows: amount,
  emptySeeks: amount,
  nativePoints: amount,
  witnessKeys: amount,
  statements: amount,
  bytes: amount,
});
const declarations = (): MembersPreparationDeclarations =>
  Object.fromEntries(MEMBERS_PREPARATION_CHILDREN.map((name) => [name, cost(2)])) as MembersPreparationDeclarations;
const parent = (amount = MEMBERS_PREPARATION_CHILDREN.length * 2, deadline = Date.now() + 60000) =>
  new NativeCollectionWork({ reservationId: 'one-c3-parent', remaining: cost(amount) }, deadline);

test('History uses one transferred parent allocation across bounded attempts without borrowing cleanup', () => {
  const pool = {} as Pool;
  const work = {} as WorkClient;
  const original = new NativeCollectionWork(
    {
      reservationId: 'funded-history-parent',
      remaining: sumOperationalWork(OPERATIONAL_WORK_LOCAL_DECLARATION, cost(2)),
    },
    Date.now() + 60_000,
  );
  const funded = original.transferChildren({ history: OPERATIONAL_WORK_LOCAL_DECLARATION, cleanup: cost(2) });
  const history = fundOperationalWorkOriginal(funded.children.history, pool, work, original.deadlineAt);
  expect(funded.children.history.receipt().used).toEqual(OPERATIONAL_WORK_LOCAL_DECLARATION);
  expect(funded.children.cleanup.available('statements')).toBe(2);
  expect(() => fundOperationalWorkOriginal(funded.children.history, pool, work, original.deadlineAt)).toThrow();
  claimOperationalWorkOriginal(history, pool, work, original.deadlineAt);
  for (let attempt = 0; attempt < 3; attempt++) debitOperationalWorkAttempt(history);
  expect(() => debitOperationalWorkAttempt(history)).toThrow('attempt-bound');
  expect(funded.finish().used).toEqual(OPERATIONAL_WORK_LOCAL_DECLARATION);
});

test('History refuses underfunded axes and binds its single-use original to the exact executor resources', () => {
  const pool = {} as Pool;
  const work = {} as WorkClient;
  const deadline = Date.now() + 60_000;
  for (const axis of axes) {
    const remaining = { ...OPERATIONAL_WORK_LOCAL_DECLARATION, [axis]: OPERATIONAL_WORK_LOCAL_DECLARATION[axis] - 1 };
    // History declares no candidate/identity/witness keys; negative budgets cannot be constructed.
    if (remaining[axis] < 0) continue;
    const original = new NativeCollectionWork({ reservationId: 'underfunded-history', remaining }, deadline);
    expect(() => fundOperationalWorkOriginal(original, pool, work, deadline)).toThrow();
    expect(original.receipt().used).toEqual(cost(0));
  }
  const original = new NativeCollectionWork(
    {
      reservationId: 'history-binding',
      remaining: OPERATIONAL_WORK_LOCAL_DECLARATION,
    },
    deadline,
  );
  expect(() => fundOperationalWorkOriginal(original, pool, work, deadline + 1)).toThrow('deadline');
  const history = fundOperationalWorkOriginal(original, pool, work, deadline);
  for (const [p, w, d, token] of [
    [{} as Pool, work, deadline, history],
    [pool, {} as WorkClient, deadline, history],
    [pool, work, deadline + 1, history],
    [pool, work, deadline, { ...history }],
  ] as const)
    expect(() => claimOperationalWorkOriginal(token, p, w, d)).toThrow('original-unavailable');
  expect(claimOperationalWorkOriginal(history, pool, work, deadline)).toBe(history);
  expect(() => claimOperationalWorkOriginal(history, pool, work, deadline)).toThrow('original-unavailable');
});
function dispatch(work: NativeCollectionWork, amount: number) {
  const reserved = work.reserve(cost(amount));
  reserved.dispatch();
  reserved.settle();
}

test('every required child must be declared and funded before any checkout can begin', () => {
  for (const missing of MEMBERS_PREPARATION_CHILDREN) {
    const original = parent();
    expect(() => transferMembersPreparationBudget(original, 'key', { ...declarations(), [missing]: null })).toThrow(
      ProblemError,
    );
    expect(original.receipt().used).toEqual(cost(0));
    expect(original.available('statements')).toBe(MEMBERS_PREPARATION_CHILDREN.length * 2);
    // Refusal allocated nothing; a later complete declaration can still be transferred.
    expect(transferMembersPreparationBudget(original, 'key', declarations()).children[missing]).toBeInstanceOf(
      NativeCollectionWork,
    );
  }
  for (const axis of axes) {
    const original = parent();
    const declared = declarations();
    expect(() =>
      transferMembersPreparationBudget(original, 'key', {
        ...declared,
        sourceVerify: { ...declared.sourceVerify!, [axis]: 3 },
      }),
    ).toThrow(ProblemError);
    expect(original.available(axis)).toBe(MEMBERS_PREPARATION_CHILDREN.length * 2);
  }
});

test('one key transfers all children once and siblings cannot borrow a spent or unused reservation', () => {
  const original = parent();
  const funded = transferMembersPreparationBudget(original, 'exact-preparation-key', declarations());
  for (const axis of axes) expect(original.available(axis)).toBe(0);
  expect(() => transferMembersPreparationBudget(original, 'exact-preparation-key', declarations())).toThrow(
    ProblemError,
  );
  dispatch(funded.children.sourceResolve, 2);
  expect(() => dispatch(funded.children.sourceResolve, 1)).toThrow(ProblemError);
  expect(funded.children.sourceVerify.available('nativeRows')).toBe(2);
  // Retry and rollback use their own prepaid children, including when no result is returned.
  dispatch(funded.children.retry, 1);
  dispatch(funded.children.rollback, 1);
  for (const child of Object.values(funded.children)) expect(child.receipt().reservationId).toBe('one-c3-parent');
  expect(funded.finish().used).toEqual(cost(4));
  expect(() => funded.finish()).toThrow('already finished');
  expect(() => dispatch(funded.children.cleanup, 1)).toThrow('allocation is closed');
  expect(() => funded.children.cleanup.reserve(cost(1), true)).toThrow('allocation is closed');
  expect(() => transferMembersPreparationBudget(original, 'exact-preparation-key', declarations())).toThrow(
    ProblemError,
  );
});

test('completion waits for in-flight child work and records charged work without reporting unused capacity', () => {
  const original = parent();
  const declared = declarations();
  const funded = transferMembersPreparationBudget(original, 'key', declared);
  // A caller changing its declaration after transfer cannot increase a child or the parent.
  Object.assign(declared.cleanup!, cost(100));
  expect(funded.children.cleanup.available('statements')).toBe(2);
  const inFlight = funded.children.members.reserve(cost(1));
  const zeroWork = funded.children.cleanup.reserve(cost(0));
  inFlight.dispatch();
  expect(() => funded.finish()).toThrow('still in flight');
  for (const axis of axes) expect(original.available(axis)).toBe(0);
  inFlight.settle();
  // Even a declared zero-cost operation has to settle before its child can close.
  expect(() => funded.finish()).toThrow('still in flight');
  zeroWork.cancel();
  expect(funded.finish().used).toEqual(cost(1));
  for (const axis of axes) expect(original.available(axis)).toBe(MEMBERS_PREPARATION_CHILDREN.length * 2 - 1);
});

test('invalid or overflowing declarations cannot partially transfer a finite parent', () => {
  for (const amount of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const original = parent();
    expect(() => original.transferChildren({ members: cost(1), cleanup: cost(amount) })).toThrow(TypeError);
    expect(original.available('bytes')).toBe(MEMBERS_PREPARATION_CHILDREN.length * 2);
  }
  const original = parent(Number.MAX_SAFE_INTEGER);
  expect(() => original.transferChildren({ members: cost(Number.MAX_SAFE_INTEGER), cleanup: cost(1) })).toThrow(
    'overflow',
  );
  expect(original.available('bytes')).toBe(Number.MAX_SAFE_INTEGER);
});

test('failed child receipts stay charged and poison the parent after settlement', async () => {
  const original = parent();
  const funded = transferMembersPreparationBudget(original, 'key', declarations());
  await expect(
    funded.children.sourceResolve.compose(async () => {
      throw new Error('Source failed');
    }),
  ).rejects.toThrow('Source failed');
  expect(funded.finish().used).toEqual(cost(2));
  expect(() => original.assertReady()).toThrow('Source failed');
  expect(() => dispatch(funded.children.sourceVerify, 1)).toThrow('allocation is closed');
});

test('the complete declaration includes constant History prices and cannot assume a missing Source price', () => {
  const declared = declareMembersPreparationParent(declarations());
  expect(declared.children.historyRegistration.statements).toBe(464);
  expect(declared.children.receivingReadback.statements).toBe(429);
  expect(declared.children.members.statements).toBeLessThanOrEqual(16);
  const original = new NativeCollectionWork(
    { reservationId: 'original', remaining: declared.total },
    Date.now() + 60000,
  );
  const funded = transferMembersPreparationBudget(original, 'key', declared.children);
  for (const axis of axes) expect(original.available(axis)).toBe(0);
  expect(funded.children.historyRegistration.deadlineAt).toBe(original.deadlineAt);
  expect(funded.finish().used).toEqual(cost(0));
  expect(() => declareMembersPreparationParent({ ...declarations(), sourceResolve: null })).toThrow(ProblemError);
  expect(() => declareMembersPreparationParent({ ...declarations(), members: cost(17) })).toThrow(
    'Members preparation body exceeds 16 statements',
  );
  expect(() => declareMembersPreparationParent({ ...declarations(), sourceVerify: cost(Infinity) })).toThrow(TypeError);
});

test('expiration refuses initial and transferred work before checkout without extending the original deadline', () => {
  const original = parent();
  const other = parent(MEMBERS_PREPARATION_CHILDREN.length * 2, original.deadlineAt);
  const funded = transferMembersPreparationBudget(original, 'key', declarations());
  const now = spyOn(Date, 'now').mockReturnValue(original.deadlineAt);
  try {
    expect(() => dispatch(funded.children.sourceResolve, 1)).toThrow(ProblemError);
    expect(() => transferMembersPreparationBudget(other, 'other', declarations())).toThrow(ProblemError);
    expect(funded.finish().used).toEqual(cost(0));
  } finally {
    now.mockRestore();
  }
});
