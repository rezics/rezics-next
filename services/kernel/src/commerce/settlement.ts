import {
  MAX_ORDER_TRANSACTIONS,
  type CheckoutDecision,
  type CheckoutSnapshot,
  type EntitlementAction,
  type Settlement,
  type SettlementState,
  type StripeTransaction,
} from './model.ts';

/** A snapshot belongs to another session or contradicts an already paid order. */
export class CheckoutMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutMismatchError';
  }
}

/** Sanitized reconciliation failure; never include provider payloads or another order's identity. */
export class MovementIntegrityError extends CheckoutMismatchError {
  constructor() {
    super('Conflicting immutable payment movement evidence');
    this.name = 'MovementIntegrityError';
  }
}

/** Descriptions are mutable; fee classification and amounts determine the captured royalty basis. */
export function movementEconomics(transaction: StripeTransaction): string {
  return JSON.stringify([
    transaction.kind,
    transaction.sourceId,
    transaction.currency,
    transaction.amountMinor,
    transaction.feeMinor,
    transaction.netMinor,
    transaction.exchangeRate,
    new Date(transaction.created).toISOString(),
    transaction.feeDetails.map(({ type, amountMinor }) => JSON.stringify([type, amountMinor])).sort(),
  ]);
}

/** Compare only incoming keys. Identical copies in a batch also represent one movement. */
function newMovements(state: SettlementState, transactions: readonly StripeTransaction[]): StripeTransaction[] {
  const retained = new Map(state.retainedTransactions.map((transaction) => [transaction.id, transaction]));
  const incoming = new Map<string, StripeTransaction>();
  for (const transaction of transactions) {
    const previous = retained.get(transaction.id);
    const copy = incoming.get(transaction.id);
    const economics = movementEconomics(transaction);
    if (
      (previous && (previous.orderId !== state.order.id || movementEconomics(previous) !== economics)) ||
      (copy && movementEconomics(copy) !== economics)
    )
      throw new MovementIntegrityError();
    if (!previous && !copy) incoming.set(transaction.id, transaction);
  }
  return [...incoming.values()];
}

/** Reject before opening a command, including when a trusted port supplies a snapshot directly. */
export function assertTransactionBound(transactions: readonly unknown[]): void {
  if (transactions.length > MAX_ORDER_TRANSACTIONS) {
    throw new CheckoutMismatchError('Checkout exceeds the order transaction limit');
  }
}

function settlementFor(state: SettlementState, snapshot: CheckoutSnapshot): Settlement {
  const { order } = state;
  let settlement: Settlement = 'pending';
  if (snapshot.status === 'complete') {
    if (snapshot.paymentStatus !== 'unpaid') {
      const mismatch =
        snapshot.paymentStatus === 'no_payment_required' ||
        snapshot.clientReferenceId !== order.id ||
        snapshot.metadataOrderId !== order.id ||
        snapshot.currency !== order.currency ||
        snapshot.amountSubtotalMinor !== order.unitAmountMinor;
      if (mismatch && order.settlement === 'paid') {
        throw new CheckoutMismatchError('Paid Checkout identity or price differs from the order');
      }
      settlement = mismatch ? 'unknown' : 'paid';
    } else if (
      snapshot.paymentIntentStatus === 'requires_payment_method' ||
      snapshot.paymentIntentStatus === 'canceled'
    ) {
      settlement = 'failed';
    }
  } else if (snapshot.status === 'expired' && snapshot.paymentStatus !== 'paid') {
    settlement = 'failed';
  }
  return order.settlement === 'paid' ? 'paid' : settlement;
}

const countedRefundStatuses = new Set(['pending', 'requires_action', 'succeeded']);
const nonRevokingDisputeStatuses = new Set([
  'won',
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'prevented',
]);

/** Decide from the current provider snapshot without performing effects or mutating the input. */
export function decideCheckout(
  state: SettlementState,
  snapshot: CheckoutSnapshot,
  precedence: 'legacy-time' | 'admitted-revision' = 'legacy-time',
): CheckoutDecision {
  assertTransactionBound(snapshot.transactions);
  if (snapshot.sessionId !== state.order.checkoutSessionId) {
    throw new CheckoutMismatchError('Checkout Session differs from the recorded session');
  }
  const newTransactions = newMovements(state, snapshot.transactions);
  if (
    precedence === 'legacy-time' &&
    state.order.observedAt !== null &&
    Date.parse(snapshot.observedAt) < Date.parse(state.order.observedAt)
  ) {
    return { changed: false };
  }

  const settlement = settlementFor(state, snapshot);
  let refundedAmount = 0;
  for (const refund of snapshot.refunds) {
    if (countedRefundStatuses.has(refund.status)) refundedAmount += refund.amountMinor;
  }
  const fullyRefunded = snapshot.chargeAmountMinor !== null && refundedAmount >= snapshot.chargeAmountMinor;
  const revokingDispute = snapshot.disputes.some((dispute) => !nonRevokingDisputeStatuses.has(dispute.status));
  const desired = settlement === 'paid' && !fullyRefunded && !revokingDispute;
  const reason = fullyRefunded ? 'refund' : 'dispute';

  let entitlement: EntitlementAction = { kind: 'none' };
  if (state.entitlement === null) {
    if (desired) entitlement = { kind: 'grant' };
  } else if (state.entitlement.revokedAt === null) {
    if (!desired) entitlement = { kind: 'revoke', reason };
  } else if (desired) {
    entitlement = { kind: 'restore' };
  } else if (state.entitlement.revokeReason !== reason) {
    entitlement = { kind: 'reason', reason };
  }

  if (settlement === state.order.settlement && entitlement.kind === 'none' && newTransactions.length === 0) {
    return { changed: false };
  }
  return {
    changed: true,
    settlement,
    paymentIntentId: snapshot.paymentIntentId,
    observedAt: snapshot.observedAt,
    entitlement,
    newTransactions,
  };
}
