import { expect, test } from 'bun:test';
import { StripeUnavailableError } from '../../src/commerce/model.ts';
import type {
  CheckoutDecision,
  CheckoutSnapshot,
  SettlementState,
  StripeTransaction,
} from '../../src/commerce/model.ts';
import { CheckoutMismatchError, decideCheckout, MovementIntegrityError } from '../../src/commerce/settlement.ts';

const time = (second: number) => `2026-10-25T00:00:${String(second).padStart(2, '0')}.000Z`;

function initial(): SettlementState {
  return {
    order: {
      id: 'order',
      buyerAccountId: 'buyer',
      offerId: 'offer',
      offerRevision: 1,
      targetSubjectId: 'subject',
      creatorAccountId: 'creator',
      title: 'Book',
      currency: 'usd',
      unitAmountMinor: 1000,
      taxCode: 'txcd_10302000',
      royaltyBasisPoints: 9000,
      settlement: 'pending',
      checkoutSessionId: 'cs_order',
      checkoutUrl: null,
      checkoutExpiresAt: null,
      observedAt: null,
      createdAt: time(0),
      revision: 1,
    },
    entitlement: null,
    transactionIds: [],
    retainedTransactions: [],
  };
}

function snapshot(patch: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot {
  return {
    sessionId: 'cs_order',
    clientReferenceId: 'order',
    metadataOrderId: 'order',
    livemode: false,
    status: 'complete',
    paymentStatus: 'paid',
    currency: 'usd',
    amountSubtotalMinor: 1000,
    amountTaxMinor: 100,
    amountTotalMinor: 1100,
    paymentIntentId: 'pi_order',
    paymentIntentStatus: 'succeeded',
    chargeId: 'ch_order',
    chargeAmountMinor: 1100,
    refunds: [],
    disputes: [],
    transactions: [],
    observedAt: time(1),
    ...patch,
  };
}

function transaction(id: string): StripeTransaction {
  return {
    id,
    kind: 'charge',
    sourceId: 'ch_order',
    currency: 'usd',
    amountMinor: 1100,
    feeMinor: 50,
    netMinor: 1050,
    feeDetails: [],
    exchangeRate: null,
    created: time(1),
  };
}

/** Fold only the state fields provided by the frozen store contract. */
function apply(state: SettlementState, decision: CheckoutDecision): SettlementState {
  if (!decision.changed) return state;
  const next = structuredClone(state);
  next.order.settlement = decision.settlement;
  next.order.observedAt = decision.observedAt;
  next.transactionIds = [...state.transactionIds, ...decision.newTransactions.map(({ id }) => id)];
  next.retainedTransactions = [
    ...state.retainedTransactions,
    ...decision.newTransactions.map((transaction) => ({ ...transaction, orderId: state.order.id })),
  ];
  switch (decision.entitlement.kind) {
    case 'grant':
      next.entitlement = {
        id: 'entitlement',
        accountId: 'buyer',
        offerId: 'offer',
        orderId: 'order',
        targetSubjectId: 'book',
        grantedAt: decision.observedAt,
        revokedAt: null,
        revokeReason: null,
        revision: 1,
      };
      break;
    case 'revoke':
      next.entitlement!.revokedAt = decision.observedAt;
      next.entitlement!.revokeReason = decision.entitlement.reason;
      break;
    case 'restore':
      next.entitlement!.revokedAt = null;
      next.entitlement!.revokeReason = null;
      break;
    case 'reason':
      next.entitlement!.revokeReason = decision.entitlement.reason;
      break;
    case 'none':
      break;
  }
  return next;
}

function paid(): SettlementState {
  return apply(initial(), decideCheckout(initial(), snapshot()));
}

const settlementCases: {
  name: string;
  patch: Partial<CheckoutSnapshot>;
  settlement: string;
  action: string;
  changed?: false;
}[] = [
  // https://docs.stripe.com/api/checkout/sessions/object.md — status and payment_status.
  { name: 'immediate pay', patch: {}, settlement: 'paid', action: 'grant' },
  // https://docs.stripe.com/api/payment_intents/object.md — processing.
  {
    name: 'async pending',
    patch: { paymentStatus: 'unpaid', paymentIntentStatus: 'processing' },
    settlement: 'pending',
    action: 'none',
    changed: false,
  },
  // https://docs.stripe.com/api/payment_intents/object.md — succeeded.
  { name: 'async succeeded', patch: { paymentIntentStatus: 'succeeded' }, settlement: 'paid', action: 'grant' },
  // https://docs.stripe.com/api/payment_intents/object.md — requires_payment_method.
  {
    name: 'async failed',
    patch: { paymentStatus: 'unpaid', paymentIntentStatus: 'requires_payment_method' },
    settlement: 'failed',
    action: 'none',
  },
  // https://docs.stripe.com/api/payment_intents/object.md — canceled.
  {
    name: 'async canceled',
    patch: { paymentStatus: 'unpaid', paymentIntentStatus: 'canceled' },
    settlement: 'failed',
    action: 'none',
  },
  // https://docs.stripe.com/api/checkout/sessions/object.md — expired.
  { name: 'expired', patch: { status: 'expired', paymentStatus: 'unpaid' }, settlement: 'failed', action: 'none' },
  // https://docs.stripe.com/api/checkout/sessions/object.md — open.
  {
    name: 'open',
    patch: { status: 'open', paymentStatus: 'unpaid' },
    settlement: 'pending',
    action: 'none',
    changed: false,
  },
  // https://docs.stripe.com/api/checkout/sessions/object.md — amount_subtotal.
  { name: 'amount mismatch', patch: { amountSubtotalMinor: 999 }, settlement: 'unknown', action: 'none' },
  // https://docs.stripe.com/api/checkout/sessions/object.md — currency.
  { name: 'currency mismatch', patch: { currency: 'eur' }, settlement: 'unknown', action: 'none' },
  // https://docs.stripe.com/api/checkout/sessions/object.md — client_reference_id.
  { name: 'reference mismatch', patch: { clientReferenceId: 'another' }, settlement: 'unknown', action: 'none' },
  // https://docs.stripe.com/api/checkout/sessions/object.md — metadata.
  { name: 'metadata mismatch', patch: { metadataOrderId: null }, settlement: 'unknown', action: 'none' },
  // https://docs.stripe.com/api/checkout/sessions/object.md — no_payment_required.
  {
    name: 'no payment required',
    patch: { paymentStatus: 'no_payment_required' },
    settlement: 'unknown',
    action: 'none',
  },
];

for (const row of settlementCases) {
  test(`settlement: ${row.name}`, () => {
    if (row.changed === false) {
      expect(decideCheckout(initial(), snapshot(row.patch))).toEqual({ changed: false });
    } else {
      expect(decideCheckout(initial(), snapshot(row.patch))).toMatchObject({
        changed: true,
        settlement: row.settlement,
        entitlement: { kind: row.action },
      });
    }
  });
}

test('async payment can progress from pending to success or failure', () => {
  const waiting = snapshot({ paymentStatus: 'unpaid', paymentIntentStatus: 'processing' });
  const state = apply(initial(), decideCheckout(initial(), waiting));
  expect(decideCheckout(state, snapshot({ observedAt: time(2) }))).toMatchObject({
    settlement: 'paid',
    entitlement: { kind: 'grant' },
  });
  expect(
    decideCheckout(
      state,
      snapshot({ observedAt: time(2), paymentStatus: 'unpaid', paymentIntentStatus: 'requires_payment_method' }),
    ),
  ).toMatchObject({ settlement: 'failed', entitlement: { kind: 'none' } });
});

test('any non-paid settlement can become paid, and paid never downgrades', () => {
  for (const settlement of ['pending', 'failed', 'unknown'] as const) {
    const state = initial();
    state.order.settlement = settlement;
    expect(decideCheckout(state, snapshot())).toMatchObject({ settlement: 'paid', entitlement: { kind: 'grant' } });
  }
  const state = paid();
  const next = apply(
    state,
    decideCheckout(state, snapshot({ status: 'expired', paymentStatus: 'unpaid', observedAt: time(2) })),
  );
  expect(next.order.settlement).toBe('paid');
  expect(next.entitlement?.revokedAt).toBeNull();
});

test('wrong session throws even when stale; paid identity and price mismatches throw', () => {
  expect(() => decideCheckout(paid(), snapshot({ sessionId: 'cs_other', observedAt: time(0) }))).toThrow(
    CheckoutMismatchError,
  );
  for (const row of settlementCases.filter(({ settlement }) => settlement === 'unknown')) {
    expect(() => decideCheckout(paid(), snapshot({ ...row.patch, observedAt: time(2) }))).toThrow(
      CheckoutMismatchError,
    );
  }
});

const refundCases = [
  // https://docs.stripe.com/api/refunds/object.md — pending.
  { status: 'pending', amount: 1100, revoked: true },
  // https://docs.stripe.com/api/refunds/object.md — requires_action.
  { status: 'requires_action', amount: 1100, revoked: true },
  // https://docs.stripe.com/api/refunds/object.md — succeeded.
  { status: 'succeeded', amount: 1100, revoked: true },
  // https://docs.stripe.com/api/refunds/object.md — failed.
  { status: 'failed', amount: 1100, revoked: false },
  // https://docs.stripe.com/api/refunds/object.md — canceled.
  { status: 'canceled', amount: 1100, revoked: false },
  // https://docs.stripe.com/api/refunds/object.md — amount is the refunded amount.
  { status: 'succeeded', amount: 1000, revoked: false },
];

for (const row of refundCases) {
  test(`refund ${row.status}, amount ${row.amount}`, () => {
    const state = paid();
    const decision = decideCheckout(
      state,
      snapshot({ observedAt: time(2), refunds: [{ id: 're_one', status: row.status, amountMinor: row.amount }] }),
    );
    const next = apply(state, decision);
    expect(next.entitlement?.revokedAt !== null).toBe(row.revoked);
    if (row.revoked) expect(decision).toMatchObject({ entitlement: { kind: 'revoke', reason: 'refund' } });
  });
}

test('several refunds reaching the taxed charge amount revoke; failed refunds restore', () => {
  const refunds = [
    { id: 're_one', status: 'succeeded', amountMinor: 600 },
    { id: 're_two', status: 'pending', amountMinor: 500 },
  ];
  const state = paid();
  const revoked = apply(state, decideCheckout(state, snapshot({ observedAt: time(2), refunds })));
  expect(revoked.entitlement?.revokeReason).toBe('refund');
  expect(
    decideCheckout(
      revoked,
      snapshot({ observedAt: time(3), refunds: [refunds[0]!, { ...refunds[1]!, status: 'failed' }] }),
    ),
  ).toMatchObject({ entitlement: { kind: 'restore' } });
});

test('a refund before the first paid snapshot never grants', () => {
  const decision = decideCheckout(
    initial(),
    snapshot({ refunds: [{ id: 're_one', status: 'succeeded', amountMinor: 1100 }] }),
  );
  expect(decision).toMatchObject({ settlement: 'paid', entitlement: { kind: 'none' } });
  expect(apply(initial(), decision).entitlement).toBeNull();
});

const disputeCases = [
  // https://docs.stripe.com/api/disputes/object.md — needs_response.
  { status: 'needs_response', revokes: true },
  // https://docs.stripe.com/api/disputes/object.md — under_review.
  { status: 'under_review', revokes: true },
  // Stripe 23.1.0 / 2026-10-28.endive: an appeal is still an unresolved adverse outcome.
  { status: 'appeal_needs_response', revokes: true },
  { status: 'appeal_under_review', revokes: true },
  // https://docs.stripe.com/api/disputes/object.md — lost.
  { status: 'lost', revokes: true },
  // https://docs.stripe.com/api/disputes/object.md — won.
  { status: 'won', revokes: false },
  // https://docs.stripe.com/api/disputes/object.md — warning_needs_response.
  { status: 'warning_needs_response', revokes: false },
  // https://docs.stripe.com/api/disputes/object.md — warning_under_review.
  { status: 'warning_under_review', revokes: false },
  // https://docs.stripe.com/api/disputes/object.md — warning_closed.
  { status: 'warning_closed', revokes: false },
  // https://docs.stripe.com/api/disputes/object.md — prevented.
  { status: 'prevented', revokes: false },
];

for (const row of disputeCases) {
  test(`dispute ${row.status}`, () => {
    const state = paid();
    const decision = decideCheckout(
      state,
      snapshot({ observedAt: time(2), disputes: [{ id: 'du_one', status: row.status, amountMinor: 1 }] }),
    );
    expect(apply(state, decision).entitlement?.revokedAt !== null).toBe(row.revokes);
    if (row.revokes) expect(decision).toMatchObject({ entitlement: { kind: 'revoke', reason: 'dispute' } });
  });
}

test('won restores a dispute revocation; a full refund takes priority and updates its reason', () => {
  const state = paid();
  const disputes = [{ id: 'du_one', status: 'needs_response', amountMinor: 1100 }];
  const revoked = apply(state, decideCheckout(state, snapshot({ observedAt: time(2), disputes })));
  const won = snapshot({ observedAt: time(3), disputes: [{ ...disputes[0]!, status: 'won' }] });
  expect(decideCheckout(revoked, won)).toMatchObject({ entitlement: { kind: 'restore' } });
  const refunds = [{ id: 're_one', status: 'succeeded', amountMinor: 1100 }];
  expect(decideCheckout(revoked, { ...won, refunds })).toMatchObject({
    entitlement: { kind: 'reason', reason: 'refund' },
  });
  const refunded = apply(revoked, decideCheckout(revoked, { ...won, refunds }));
  expect(
    apply(refunded, decideCheckout(refunded, { ...won, observedAt: time(4), refunds })).entitlement?.revokeReason,
  ).toBe('refund');
});

test('stale snapshots are ignored and applying the same snapshot twice is idempotent', () => {
  const state = paid();
  expect(decideCheckout(state, snapshot({ observedAt: time(0), transactions: [transaction('txn_old')] }))).toEqual({
    changed: false,
  });
  expect(decideCheckout(state, snapshot())).toEqual({ changed: false });
});

test('new transactions alone change the decision, retain order and exclude recorded IDs', () => {
  const state = paid();
  state.transactionIds = ['txn_old'];
  state.retainedTransactions = [{ ...transaction('txn_old'), orderId: state.order.id }];
  const current = snapshot({ transactions: [transaction('txn_two'), transaction('txn_old'), transaction('txn_one')] });
  const decision = decideCheckout(state, current);
  expect(decision).toMatchObject({
    changed: true,
    entitlement: { kind: 'none' },
    newTransactions: [transaction('txn_two'), transaction('txn_one')],
  });
  expect(decideCheckout(apply(state, decision), current)).toEqual({ changed: false });
});

test('a PaymentIntent-only difference is no change, including with the same observation time', () => {
  const state = initial();
  state.order.observedAt = time(1);
  const current = snapshot({ paymentStatus: 'unpaid', paymentIntentStatus: 'processing' });
  const decision = decideCheckout(state, current);
  expect(decision).toEqual({ changed: false });
  expect(decideCheckout(apply(state, decision), current)).toEqual({ changed: false });
});

test('generated histories and every subsequence ending at the latest snapshot converge', () => {
  // Stripe sources: checkout/sessions/object.md, refunds/object.md, disputes/object.md.
  // Histories follow a completed payment; balance transactions accumulate while refund/dispute statuses evolve.
  let seed = 0x12345678;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const outcome = (state: SettlementState) => ({
    settlement: state.order.settlement,
    active: state.entitlement !== null && state.entitlement.revokedAt === null,
    transactions: [...new Set(state.transactionIds)].sort(),
  });
  for (let trial = 0; trial < 100; trial++) {
    const history = Array.from({ length: 5 }, (_, index) =>
      snapshot({
        observedAt: time(index + 1),
        refunds: [
          {
            id: 're_one',
            status: refundCases[random() % refundCases.length]!.status,
            amountMinor: random() % 2 ? 1100 : 500,
          },
        ],
        disputes: [{ id: 'du_one', status: disputeCases[random() % disputeCases.length]!.status, amountMinor: 1100 }],
        transactions: Array.from({ length: index + 1 }, (_, n) => transaction(`txn_${n}`)),
      }),
    );
    const last = history.at(-1)!;
    const expected = outcome(apply(initial(), decideCheckout(initial(), last)));
    for (let mask = 0; mask < 16; mask++) {
      let state = initial();
      for (const [index, current] of history.entries()) {
        if (index === 4 || mask & (1 << index)) state = apply(state, decideCheckout(state, current));
      }
      expect(outcome(state)).toEqual(expected);
    }
  }
});

test('immutable movement replay normalizes fee order and ignores mutable descriptions', () => {
  const movement = {
    ...transaction('txn_replay'),
    feeDetails: [
      { type: 'stripe_fee', amountMinor: 40, description: 'old' },
      { type: 'tax', amountMinor: 10, description: null },
    ],
  };
  const state = apply(initial(), decideCheckout(initial(), snapshot({ transactions: [movement] })));
  const replay = {
    ...movement,
    feeDetails: [...movement.feeDetails].reverse().map((fee) => ({ ...fee, description: 'new' })),
  };
  expect(decideCheckout(state, snapshot({ transactions: [replay], observedAt: '2026-11-25T00:00:00Z' }))).toEqual({
    changed: false,
  });
  expect(state.retainedTransactions).toEqual([{ ...movement, orderId: state.order.id }]);
});

test('retained movement economics and association conflicts fail without changing settlement state', () => {
  const movement = transaction('txn_integrity');
  const state = apply(initial(), decideCheckout(initial(), snapshot({ transactions: [movement] })));
  const before = structuredClone(state);
  const conflicts: Partial<StripeTransaction>[] = [
    { amountMinor: 1101, netMinor: 1051 },
    { currency: 'eur' },
    { sourceId: 'ch_other' },
    { feeMinor: 51, netMinor: 1049 },
    { netMinor: 1051 },
    { exchangeRate: 1.1 },
    { created: time(2) },
    { kind: 'refund' },
    { feeDetails: [{ type: 'withheld_tax', amountMinor: 50, description: null }] },
  ];
  for (const conflict of conflicts) {
    // Old observation time cannot conceal a contradiction of retained financial evidence.
    expect(() =>
      decideCheckout(state, snapshot({ transactions: [{ ...movement, ...conflict }], observedAt: time(0) })),
    ).toThrow(MovementIntegrityError);
    expect(state).toEqual(before);
  }
  expect(() =>
    decideCheckout(
      { ...state, order: { ...state.order, id: 'another_order' } },
      snapshot({ transactions: [movement] }),
    ),
  ).toThrow(MovementIntegrityError);
});

test('repeated keys in one snapshot have one effect and conflicting copies fail', () => {
  const movement = transaction('txn_batch');
  expect(decideCheckout(initial(), snapshot({ transactions: [movement, structuredClone(movement)] }))).toMatchObject({
    changed: true,
    newTransactions: [movement],
  });
  expect(() =>
    decideCheckout(initial(), snapshot({ transactions: [movement, { ...movement, sourceId: 'ch_other' }] })),
  ).toThrow(MovementIntegrityError);
});

test('unsupported adverse statuses are unavailable and preserve both active and revoked entitlements', () => {
  const active = paid();
  const revoked = apply(
    active,
    decideCheckout(
      active,
      snapshot({
        observedAt: time(2),
        disputes: [{ id: 'du_one', status: 'lost', amountMinor: 1100 }],
      }),
    ),
  );
  for (const state of [initial(), active, revoked]) {
    for (const patch of [
      { refunds: [{ id: 're_one', status: 'future_status', amountMinor: 1100 }] },
      { disputes: [{ id: 'du_one', status: 'future_status', amountMinor: 1100 }] },
    ]) {
      const before = structuredClone(state);
      expect(() => decideCheckout(state, snapshot({ observedAt: time(3), ...patch }))).toThrow(StripeUnavailableError);
      expect(state).toEqual(before);
    }
  }
});

test('Previously revoked paid order is never restored when required current payment associations or adverse evidence are missing', () => {
  const active = paid();
  const revoked = apply(
    active,
    decideCheckout(
      active,
      snapshot({
        observedAt: time(2),
        refunds: [{ id: 're_one', status: 'pending', amountMinor: 1100 }],
      }),
    ),
  );
  for (const patch of [
    { paymentIntentId: null, paymentIntentStatus: null, chargeId: null, chargeAmountMinor: null },
    { chargeId: null, chargeAmountMinor: null },
    { chargeAmountMinor: null },
    { paymentIntentStatus: 'processing', paymentStatus: 'unpaid' as const },
    { status: 'expired' as const, paymentStatus: 'unpaid' as const },
    { refunds: [{ id: 're_one', status: 'unknown', amountMinor: 1100 }] },
    { refunds: Array.from({ length: 101 }, (_, n) => ({ id: `re_${n}`, status: 'failed', amountMinor: 1 })) },
  ]) {
    const before = structuredClone(revoked);
    expect(() => decideCheckout(revoked, snapshot({ observedAt: time(3), ...patch }))).toThrow(StripeUnavailableError);
    expect(revoked).toEqual(before);
    expect(revoked.order.settlement).toBe('paid');
    expect(revoked.entitlement?.revokedAt).not.toBeNull();
  }
});

test('Complete paid evidence with no balance availability still permits the correct entitlement decision', () => {
  const current = snapshot({ transactions: [] });
  const decision = decideCheckout(initial(), current);
  expect(decision).toMatchObject({ settlement: 'paid', entitlement: { kind: 'grant' }, newTransactions: [] });
  const active = apply(initial(), decision);
  const revoked = apply(
    active,
    decideCheckout(
      active,
      snapshot({
        observedAt: time(2),
        disputes: [{ id: 'du_one', status: 'lost', amountMinor: 1100 }],
      }),
    ),
  );
  const won = snapshot({ observedAt: time(3), disputes: [{ id: 'du_one', status: 'won', amountMinor: 1100 }] });
  const restored = apply(revoked, decideCheckout(revoked, won));
  expect(restored.entitlement?.id).toBe(revoked.entitlement?.id);
  expect(restored.entitlement?.revokedAt).toBeNull();
  expect(restored.transactionIds).toEqual([]);
  const full = { id: 're_one', status: 'requires_action', amountMinor: 1100 };
  expect(decideCheckout(revoked, { ...won, refunds: [full] })).toMatchObject({
    entitlement: { kind: 'reason', reason: 'refund' },
    newTransactions: [],
  });
  expect(decideCheckout(revoked, { ...won, refunds: [{ ...full, status: 'failed' }] })).toMatchObject({
    entitlement: { kind: 'restore' },
    newTransactions: [],
  });
  expect(
    decideCheckout(revoked, {
      ...won,
      refunds: [{ ...full, status: 'failed' }],
      disputes: [...won.disputes, { id: 'du_two', status: 'under_review', amountMinor: 1 }],
    }),
  ).toEqual({ changed: false });
});
