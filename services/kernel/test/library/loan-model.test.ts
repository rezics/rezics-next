import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { loanDueBoundary } from '../../src/library/loan-date.ts';
import {
  assertLoanCopyOperand,
  assertLoanOwner,
  createLoanRecord,
  extendLoanRecord,
  loanState,
  LoanConflictError,
  LoanInvalidError,
  LoanNotFoundError,
  MAX_LOAN_REVISION,
  parseLoanCreate,
  parseLoanExtend,
  parseLoanReturn,
  returnLoanRecord,
} from '../../src/library/loan-model.ts';

const accountId = newId(31),
  copyId = newId(31),
  id = newId(31);
const boundary = loanDueBoundary(new Date('2026-11-04T16:00:00.000Z'));
const draft = {
  copyId,
  copyRevision: 7,
  direction: 'lent' as const,
  counterparty: { kind: 'name' as const, name: '  @Alice 王  ' },
  startedOn: '2026-11-01',
  dueOn: '2026-11-03',
};
const make = (changes = {}) => createLoanRecord({ id, accountId }, parseLoanCreate({ ...draft, ...changes }));

function invalid(run: () => unknown, field: string) {
  try {
    run();
    throw new Error('Accepted invalid input');
  } catch (error) {
    expect(error).toBeInstanceOf(LoanInvalidError);
    expect(error).toHaveProperty('field', field);
  }
}
function conflict(run: () => unknown, reason: string) {
  try {
    run();
    throw new Error('Accepted a conflicting write');
  } catch (error) {
    expect(error).toBeInstanceOf(LoanConflictError);
    expect(error).toHaveProperty('reason', reason);
  }
}

test('both directions select an exact copy and capture detached immutable private name operands', () => {
  for (const direction of ['lent', 'borrowed'] as const) {
    const input = { ...draft, direction, counterparty: { ...draft.counterparty } };
    const captured = parseLoanCreate(input),
      record = createLoanRecord({ id, accountId }, captured);
    input.counterparty.name = 'replacement';
    expect(record).toEqual({
      id,
      accountId,
      copyId,
      direction,
      counterparty: draft.counterparty,
      startedOn: draft.startedOn,
      dueOn: draft.dueOn,
      returnedOn: null,
      revision: 1,
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.counterparty)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.counterparty)).toBe(true);
  }
});

test('names never become identities; a person reference must be explicitly tagged and routable', () => {
  const personId = newId(999);
  expect(make({ counterparty: { kind: 'person', personId } }).counterparty).toEqual({ kind: 'person', personId });
  for (const name of ['', '   ', '\uD800', 'a\u0000b', 'Alice\nBob', '😀'.repeat(301)])
    invalid(() => make({ counterparty: { kind: 'name', name } }), 'counterparty.name');
  expect(make({ counterparty: { kind: 'name', name: '😀'.repeat(300) } }).counterparty).toEqual({
    kind: 'name',
    name: '😀'.repeat(300),
  });
  invalid(() => make({ counterparty: { kind: 'name', name: 'Alice', personId } }), 'counterparty.personId');
  invalid(() => make({ counterparty: { kind: 'person', personId, name: 'Alice' } }), 'counterparty.name');
  invalid(() => make({ counterparty: { kind: 'person', personId: '@alice' } }), 'counterparty.personId');
});

test('closed commands reject forged owner, wrong identity, missing revisions and impossible date order', () => {
  invalid(() => parseLoanCreate({ ...draft, accountId: newId(31) }), 'accountId');
  invalid(() => make({ copyId: 'work-title' }), 'copyId');
  invalid(() => make({ direction: 'purchase' }), 'direction');
  invalid(() => make({ dueOn: '2026-10-31' }), 'dueOn');
  invalid(() => make({ copyRevision: undefined }), 'copyRevision');
  for (const revision of [0, -1, 1.5, MAX_LOAN_REVISION + 1, '1', undefined])
    invalid(() => parseLoanExtend({ revision, dueOn: '2026-11-06' }), 'revision');
  invalid(() => parseLoanReturn({ revision: 1, returnedOn: '2026-11-04', dueOn: null }), 'dueOn');
});

test('exact ownership is checked before revision, including foreign accounts sharing the same route', () => {
  const input = parseLoanCreate(draft),
    copy = { id: copyId, accountId, revision: 7, status: 'owned', disposedOn: null };
  expect(() => assertLoanCopyOperand(accountId, input, copy)).not.toThrow();
  for (const foreign of [null, { ...copy, accountId: newId(31), revision: 99 }, { ...copy, id: newId(31) }])
    expect(() => assertLoanCopyOperand(accountId, input, foreign)).toThrow(LoanNotFoundError);
  expect(() => assertLoanOwner(newId(31), make())).toThrow(LoanNotFoundError);
  expect(() => createLoanRecord({ id: newId(32), accountId }, input)).toThrow(LoanNotFoundError);
  conflict(() => assertLoanCopyOperand(accountId, input, { ...copy, revision: 8 }), 'stale_revision');
  conflict(() => assertLoanCopyOperand(accountId, input, { ...copy, status: 'disposed' }), 'copy_unavailable');
  conflict(() => assertLoanCopyOperand(accountId, input, { ...copy, disposedOn: '2026-11-02' }), 'copy_unavailable');
});

test('extension preserves the original snapshot and stale edits cannot overwrite return or extension', () => {
  const original = make(),
    command = parseLoanExtend({ revision: 1, dueOn: '2026-11-06' });
  const extended = extendLoanRecord(original, command);
  expect(original.dueOn).toBe('2026-11-03');
  expect(extended).toEqual({ ...original, dueOn: '2026-11-06', revision: 2 });
  conflict(() => extendLoanRecord(extended, command), 'stale_revision');
  conflict(
    () => returnLoanRecord(extended, parseLoanReturn({ revision: 1, returnedOn: '2026-11-04' }), boundary),
    'stale_revision',
  );
  for (const dueOn of ['2026-10-31', '2026-11-02', '2026-11-03'])
    invalid(() => extendLoanRecord(original, parseLoanExtend({ revision: 1, dueOn })), 'dueOn');
  invalid(() => parseLoanExtend({ revision: 1, dueOn: null }), 'dueOn');
});

test('undated and due-today records stay distinct; an undated loan can receive its first due day', () => {
  const undated = make({ dueOn: null });
  const { dueOn: _omitted, ...withoutDue } = draft;
  expect(parseLoanCreate(withoutDue).dueOn).toBeNull();
  expect(loanState(undated, boundary)).toBe('undated');
  expect(loanState(make(), boundary)).toBe('overdue');
  expect(loanState(make({ dueOn: boundary.today }), boundary)).toBe('due');
  expect(extendLoanRecord(undated, parseLoanExtend({ revision: 1, dueOn: draft.startedOn })).dueOn).toBe(
    draft.startedOn,
  );
});

test('actual early return is terminal; a new repeated return is a conflict, not a replay', () => {
  const original = make({ dueOn: '2026-12-01' });
  const command = parseLoanReturn({ revision: 1, returnedOn: '2026-11-02' });
  const returned = returnLoanRecord(original, command, boundary);
  expect(returned).toEqual({ ...original, returnedOn: '2026-11-02', revision: 2 });
  expect(loanState(returned, boundary)).toBe('returned');
  expect(original.returnedOn).toBeNull();
  conflict(() => returnLoanRecord(returned, command, boundary), 'stale_revision');
  conflict(() => returnLoanRecord(returned, { ...command, revision: 2 }, boundary), 'returned');
  conflict(() => extendLoanRecord(returned, { revision: 2, dueOn: '2027-01-01' }), 'returned');
  for (const returnedOn of ['2026-10-31', '2026-11-05'])
    invalid(() => returnLoanRecord(original, parseLoanReturn({ revision: 1, returnedOn }), boundary), 'returnedOn');
  conflict(
    () =>
      extendLoanRecord(
        { ...original, revision: MAX_LOAN_REVISION },
        { revision: MAX_LOAN_REVISION, dueOn: '2027-01-01' },
      ),
    'revision_exhausted',
  );
});
