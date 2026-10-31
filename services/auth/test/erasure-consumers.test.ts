import { expect, test } from 'bun:test';
import { registrationActivationResult, registrationExpiryResult } from '../src/native-proof-minimization.ts';

const claim = { accountId: 'original-account', handle: 'original-handle' };
const source = {
  accountId: claim.accountId,
  receiptId: 'original-native-receipt',
  minimumAuthnEpoch: '2',
  kind: 'tombstone',
  priorOperatorAccountId: null,
};
const operator = {
  operatorAccountId: 'living-operator',
  subjectAccountId: claim.accountId,
  reservationId: 'original-operator-slot',
};

test('expiry proof accepts only exact native source, handle and original responsibility returns', () => {
  expect(registrationExpiryResult(claim, source, claim)).toEqual({
    outcome: 'expired',
    sourceResult: source,
    handleResult: claim,
  });
  const responsibility = { retired: operator, released: operator };
  expect(registrationExpiryResult(claim, source, claim, operator, responsibility)).toEqual({
    outcome: 'expired',
    sourceResult: source,
    handleResult: claim,
    responsibilityResult: responsibility,
  });
  expect(registrationExpiryResult(claim, source, claim, operator)).toBeNull();
  expect(
    registrationExpiryResult(claim, source, claim, operator, {
      retired: operator,
      released: { ...operator, reservationId: 'replacement-slot' },
    }),
  ).toBeNull();
  expect(registrationExpiryResult(claim, source, { ...claim, handle: 'replacement-handle' })).toBeNull();
});

test('missing or unknown actual source result remains pending rather than becoming terminal expiry', () => {
  for (const unavailable of [
    null,
    undefined,
    {},
    { state: 'deleted' },
    { status: 'SUCCESS' },
    { outcome: 'expired' },
    { ...source, accountId: 'another-account' },
    { ...source, minimumAuthnEpoch: '0' },
    { ...source, kind: 'fence' },
  ]) {
    expect(registrationExpiryResult(claim, unavailable, claim)).toBeNull();
  }
  expect(registrationExpiryResult(claim, source, null)).toBeNull();
});

test('unknown activation replies never replace the last actual committed result', () => {
  expect(registrationActivationResult({ accountId: claim.accountId })).toBe(true);
  for (const value of [null, undefined, {}, { accountId: '' }, { accountId: claim.accountId, status: 'SUCCESS' }])
    expect(registrationActivationResult(value)).toBe(false);
});
