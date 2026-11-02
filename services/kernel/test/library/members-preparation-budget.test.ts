import { expect, test } from 'bun:test';
import { ProblemError } from '../../src/http/problem.ts';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import {
  MEMBERS_PREPARATION_CHILDREN,
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
