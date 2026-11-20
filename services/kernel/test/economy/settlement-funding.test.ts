import { expect, test } from 'bun:test';
import {
  acknowledgeWithdrawalHold,
  beginFunding,
  fundingEvidenceKey,
  markFundingDispatchUnknown,
  observeFunding,
  prepareFundingDispatch,
  type FundingDecision,
  type FundingIntent,
  type FundingObservation,
} from '../../src/economy/settlement/funding.ts';
import { planCreatorPosting, type PostingGroup } from '../../src/economy/settlement/posting.ts';

const intent: FundingIntent = {
  bookId: 'private-book',
  intentId: 'fund-1',
  walletId: 'wallet-1',
  assetId: 'demo-usd',
  units: '100',
  direction: 'withdrawal',
  provider: { namespace: 'deterministic:account-1', mode: 'test', destinationRef: 'destination-1' },
};
const expectedAttemptId = 'funding/private-book/fund-1';
const evidence = {
  attemptId: expectedAttemptId,
  provider: intent.provider,
  assetId: intent.assetId,
  units: intent.units,
};
const confirmation = { ...evidence, kind: 'confirmed', movementId: 'movement-1' } as const;

function created(direction: FundingIntent['direction'] = 'withdrawal') {
  const outcome = beginFunding({ ...intent, direction });
  if (outcome.kind !== 'created') throw new Error('Expected a newly admitted funding intent');
  return outcome;
}

function applied(decision: FundingDecision) {
  if (decision.kind !== 'applied') throw new Error(`Expected an applied transition, got ${decision.kind}`);
  return decision;
}

function submitted(direction: FundingIntent['direction'] = 'withdrawal') {
  const result = created(direction);
  const ready = result.reserve
    ? applied(acknowledgeWithdrawalHold(result.state, { ...result.reserve, protected: true })).state
    : result.state;
  const dispatch = prepareFundingDispatch(ready);
  if (dispatch.kind !== 'submit') throw new Error('Expected the initial submit action');
  return dispatch;
}

function expectBalanced(group: PostingGroup) {
  expect(group.assetId).toBe(intent.assetId);
  expect(group.postings.every((posting) => BigInt(posting.units) > 0n)).toBe(true);
  expect(
    group.postings.reduce(
      (total, posting) => total + BigInt(posting.units) * (posting.side === 'debit' ? 1n : -1n),
      0n,
    ),
  ).toBe(0n);
}

test('admission preserves exact units and immutable wallet, route and provider operands on replay', () => {
  const admitted = created();
  expect(Object.isFrozen(admitted.state.intent.provider)).toBe(true);
  expect(beginFunding(intent, admitted.state)).toEqual({ kind: 'replayed', state: admitted.state });
  expect(beginFunding({ ...intent, walletId: 'wallet-2' }, admitted.state)).toEqual({ kind: 'conflict' });
  expect(beginFunding({ ...intent, provider: { ...intent.provider, mode: 'live' } }, admitted.state)).toEqual({
    kind: 'conflict',
  });
  expect(beginFunding({ ...intent, units: '9007199254740993' })).toMatchObject({
    kind: 'created',
    state: { intent: { units: '9007199254740993' } },
  });
  for (const amount of ['0', '01', '1e2', '9223372036854775808']) {
    expect(beginFunding({ ...intent, units: amount })).toEqual({ kind: 'invalid' });
  }
});

test('withdrawal protects the exact hold before submission and reconciles the original attempt after uncertainty', () => {
  const result = created();
  expect(result.state.phase).toBe('awaiting_hold');
  expect(prepareFundingDispatch(result.state)).toEqual({ kind: 'not_ready' });
  expect(observeFunding(result.state, confirmation)).toEqual({ kind: 'not_ready' });
  if (!result.reserve) throw new Error('Expected the reserve action');
  const hold = { ...result.reserve, protected: true };
  expect(acknowledgeWithdrawalHold(result.state, { ...hold, protected: false })).toEqual({ kind: 'conflict' });
  expect(acknowledgeWithdrawalHold(result.state, { ...hold, units: '99' })).toEqual({ kind: 'conflict' });
  const ready = applied(acknowledgeWithdrawalHold(result.state, hold)).state;
  expect(acknowledgeWithdrawalHold(ready, hold)).toEqual({ kind: 'replayed' });
  const dispatch = prepareFundingDispatch(ready);
  if (dispatch.kind !== 'submit') throw new Error('Expected the initial submit action');
  expect(dispatch.attempt.attemptId).toBe(expectedAttemptId);
  expect(prepareFundingDispatch(dispatch.state)).toMatchObject({ kind: 'reconcile', attempt: dispatch.attempt });
  const unknown = markFundingDispatchUnknown(dispatch.state, dispatch.attempt.attemptId);
  expect(unknown).toMatchObject({ kind: 'applied', state: { phase: 'unknown' } });
  expect(unknown).not.toHaveProperty('effect');
  expect(prepareFundingDispatch(applied(unknown).state)).toMatchObject({
    kind: 'reconcile',
    attempt: dispatch.attempt,
  });
  expect(observeFunding(applied(unknown).state, { ...evidence, kind: 'pending' })).toEqual({ kind: 'unchanged' });
});

test('confirmed withdrawal captures once by provider movement and rejects conflicting observations', () => {
  const state = submitted().state;
  expect(observeFunding(state, { ...confirmation, provider: { ...intent.provider, destinationRef: 'other' } })).toEqual(
    { kind: 'unrelated' },
  );
  expect(observeFunding(state, { ...confirmation, provider: { ...intent.provider, mode: 'live' } })).toEqual({
    kind: 'unrelated',
  });
  const outcome = applied(observeFunding(state, confirmation));
  expect(outcome.state).toMatchObject({ phase: 'confirmed', confirmedMovementId: confirmation.movementId });
  expect(outcome.receipt?.key).toEqual(fundingEvidenceKey(confirmation));
  const effect = outcome.effect;
  if (effect?.kind !== 'post' || !outcome.receipt)
    throw new Error('Expected a confirmed posting and its evidence receipt');
  expect(effect.capture).toMatchObject({ holdId: expectedAttemptId, units: '100' });
  expect(effect.group.postings.map((posting) => [posting.account.role, posting.side])).toEqual([
    ['wallet', 'debit'],
    ['provider_clearing', 'credit'],
  ]);
  expectBalanced(effect.group);
  const replay = { existingReceipt: outcome.receipt };
  expect(observeFunding(outcome.state, confirmation, replay)).toEqual({ kind: 'replayed' });
  expect(observeFunding(outcome.state, { ...confirmation, units: '99' }, replay)).toEqual({ kind: 'conflict' });
  expect(observeFunding(outcome.state, { ...confirmation, movementId: 'another-movement' })).toEqual({
    kind: 'conflict',
  });
});

test('a definitive withdrawal refusal releases once and conflicts with a subsequent confirmation', () => {
  const refusal = { ...evidence, kind: 'refused', evidenceId: 'refusal-1' } as const;
  const unknown = applied(markFundingDispatchUnknown(submitted().state, expectedAttemptId)).state;
  const outcome = applied(observeFunding(unknown, refusal));
  expect(outcome).toMatchObject({
    state: { phase: 'refused' },
    effect: { kind: 'release_hold', reservation: { units: '100' } },
  });
  if (!outcome.receipt) throw new Error('Expected the refusal evidence receipt');
  expect(observeFunding(outcome.state, refusal, { existingReceipt: outcome.receipt })).toEqual({ kind: 'replayed' });
  expect(observeFunding(outcome.state, confirmation)).toEqual({ kind: 'conflict' });
});

test('a withdrawal return is separately posted, linked, and bounded by the original movement', () => {
  const state = submitted().state;
  const returned = {
    ...evidence,
    kind: 'returned',
    movementId: 'return-1',
    originalMovementId: 'movement-1',
    units: '40',
  } as const;
  expect(observeFunding(state, returned)).toEqual({ kind: 'not_ready' });
  const confirmed = applied(observeFunding(state, confirmation)).state;
  expect(observeFunding(confirmed, { ...returned, originalMovementId: 'unrelated-movement' })).toEqual({
    kind: 'conflict',
  });
  const partialReturn = applied(observeFunding(confirmed, returned));
  const effect = partialReturn.effect;
  if (effect?.kind !== 'post' || !partialReturn.receipt)
    throw new Error('Expected a return posting and evidence receipt');
  expect(partialReturn.state).toMatchObject({ phase: 'confirmed', reversedUnits: '40' });
  expect(effect.capture).toBeUndefined();
  expect(effect.group.postings.map((posting) => [posting.account.role, posting.side])).toEqual([
    ['provider_clearing', 'debit'],
    ['wallet', 'credit'],
  ]);
  expectBalanced(effect.group);
  expect(observeFunding(partialReturn.state, returned, { existingReceipt: partialReturn.receipt })).toEqual({
    kind: 'replayed',
  });
  expect(observeFunding(partialReturn.state, { ...returned, movementId: 'return-2', units: '61' })).toEqual({
    kind: 'conflict',
  });
  expect(observeFunding(partialReturn.state, { ...returned, movementId: 'return-2', units: '60' })).toMatchObject({
    kind: 'applied',
    state: { phase: 'reversed', reversedUnits: '100' },
  });
});

test('deposit confirmation credits the wallet, and chargeback shortfall posts a receivable', () => {
  const deposited = applied(observeFunding(submitted('deposit').state, confirmation));
  if (deposited.effect?.kind !== 'post') throw new Error('Expected the deposit posting');
  expect(deposited.effect.group.postings.map((posting) => [posting.account.role, posting.side])).toEqual([
    ['provider_clearing', 'debit'],
    ['wallet', 'credit'],
  ]);
  expectBalanced(deposited.effect.group);
  const chargeback: FundingObservation = {
    ...evidence,
    kind: 'chargeback',
    movementId: 'chargeback-1',
    originalMovementId: 'movement-1',
  };
  expect(observeFunding(deposited.state, chargeback)).toEqual({ kind: 'not_ready' });
  const outcome = applied(observeFunding(deposited.state, chargeback, { recoverableWalletUnits: '30' }));
  if (outcome.effect?.kind !== 'post') throw new Error('Expected a chargeback posting');
  expect(outcome.state.phase).toBe('reversed');
  expect(outcome.effect.chargebackShortfall).toBe('70');
  expect(outcome.effect.group.postings.map(({ account, side, units }) => [account.role, side, units])).toEqual([
    ['wallet', 'debit', '30'],
    ['chargeback_receivable', 'debit', '70'],
    ['provider_clearing', 'credit', '100'],
  ]);
  expectBalanced(outcome.effect.group);
});

test('creator accrual recognizes a payable separately from cash payout and late return', () => {
  const base = { assetId: intent.assetId, creatorId: 'creator-1', units: '30' };
  const accrual = planCreatorPosting({ ...base, kind: 'accrual', expenseAccountId: 'creator-fees' });
  const payout = planCreatorPosting({ ...base, kind: 'payout', clearingAccountId: 'provider-1' });
  const returned = planCreatorPosting({ ...base, kind: 'payout_return', clearingAccountId: 'provider-1' });
  if (!accrual || !payout || !returned) throw new Error('Expected the creator postings');
  expect(accrual.postings.map(({ account }) => account.role)).toEqual(['creator_expense', 'creator_payable']);
  expect(payout.postings.map(({ account }) => account.role)).toEqual(['creator_payable', 'provider_clearing']);
  expect(returned.postings.map(({ account }) => account.role)).toEqual(['provider_clearing', 'creator_payable']);
  for (const group of [accrual, payout, returned]) expectBalanced(group);
});
