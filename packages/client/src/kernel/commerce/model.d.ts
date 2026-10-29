/**
 * Shared commerce types. Offers live in the creator account's partition; orders, their Stripe transactions and
 * entitlements live in the buyer account's partition. Amounts are integers in the currency's minor unit.
 */
/** Maximum balance transactions in one complete provider snapshot. */
export declare const MAX_ORDER_TRANSACTIONS = 256;
/** As in legacy: `pending` until Stripe settles the payment, `unknown` after a lost provider call or a mismatch. */
export type Settlement = 'pending' | 'paid' | 'failed' | 'unknown';
export type RevokeReason = 'refund' | 'dispute';
export type Offer = {
    id: string;
    creatorAccountId: string;
    targetSubjectId: string;
    title: string;
    /** ISO 4217, lowercase as Stripe writes it. */
    currency: string;
    unitAmountMinor: number;
    /** Stripe product tax code, for example `txcd_10302000` for e-books. */
    taxCode: string;
    /** The creator's share of Net Receipts: 9000 is 90%. */
    royaltyBasisPoints: number;
    state: 'active' | 'delisted';
    revision: number;
};
export type Order = {
    id: string;
    buyerAccountId: string;
    offerId: string;
    offerRevision: number;
    targetSubjectId: string;
    creatorAccountId: string;
    title: string;
    currency: string;
    unitAmountMinor: number;
    taxCode: string;
    royaltyBasisPoints: number;
    /** Checkout tax captured at paid fulfilment; older in-memory snapshots may omit it. */
    amountTaxMinor?: number | null;
    settlement: Settlement;
    checkoutSessionId: string | null;
    checkoutUrl: string | null;
    checkoutExpiresAt: string | null;
    /** The `observedAt` of the last Stripe snapshot applied to this order. */
    observedAt: string | null;
    createdAt: string;
    revision: number;
};
export type Entitlement = {
    id: string;
    accountId: string;
    offerId: string;
    orderId: string;
    targetSubjectId: string;
    grantedAt: string;
    revokedAt: string | null;
    revokeReason: RevokeReason | null;
    revision: number;
};
export type TransactionKind = 'charge' | 'refund' | 'refund_reversal' | 'dispute' | 'dispute_reversal';
/** One Stripe balance transaction for an order, in the settlement currency. */
export type StripeTransaction = {
    /** The balance transaction ID, `txn_…`. */
    id: string;
    kind: TransactionKind;
    /** The charge, refund or dispute it belongs to: `ch_…`, `re_…` or `du_…`. */
    sourceId: string;
    currency: string;
    /** Signed: positive when money reaches the balance, negative when it leaves. */
    amountMinor: number;
    feeMinor: number;
    /** Stripe's own `net`: `amountMinor - feeMinor`. */
    netMinor: number;
    feeDetails: {
        type: string;
        amountMinor: number;
        description: string | null;
    }[];
    /** Presentment to settlement currency rate, or null when they are the same. */
    exchangeRate: number | null;
    created: string;
};
export type RefundState = {
    id: string;
    status: string;
    amountMinor: number;
};
export type DisputeState = {
    id: string;
    status: string;
    amountMinor: number;
};
/** Untrusted provider routing metadata, never a native binding, buyer authority or payment snapshot. */
export type CheckoutLocator = {
    sessionId: string;
    clientReferenceId: string | null;
    metadataOrderId: string | null;
    livemode: boolean;
    mode: 'payment' | 'setup' | 'subscription';
    paymentIntentId: string | null;
};
/** Stripe's current state of one Checkout Session, read through the Stripe API, never taken from a webhook payload. */
export type CheckoutSnapshot = {
    sessionId: string;
    clientReferenceId: string | null;
    metadataOrderId: string | null;
    livemode: boolean;
    status: 'open' | 'complete' | 'expired';
    paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
    /** In the presentment currency. */
    currency: string | null;
    amountSubtotalMinor: number | null;
    amountTaxMinor: number | null;
    amountTotalMinor: number | null;
    paymentIntentId: string | null;
    paymentIntentStatus: string | null;
    chargeId: string | null;
    chargeAmountMinor: number | null;
    refunds: RefundState[];
    disputes: DisputeState[];
    transactions: StripeTransaction[];
    /** When the adapter read Stripe, from the trusted clock. */
    observedAt: string;
};
/** What the settlement rules read from the buyer's partition before applying a snapshot. */
export type SettlementState = {
    order: Order;
    entitlement: Entitlement | null;
    /** Snapshot balance transaction IDs already recorded for the order. */
    transactionIds: readonly string[];
};
export type EntitlementAction = {
    kind: 'none';
} | {
    kind: 'grant';
} | {
    kind: 'revoke';
    reason: RevokeReason;
} | {
    kind: 'restore';
}
/** A revoked entitlement's cause changed; it stays revoked. */
 | {
    kind: 'reason';
    reason: RevokeReason;
};
/** The settlement rules' output; the store writes a changed decision in one command. */
export type CheckoutDecision = {
    changed: false;
} | {
    changed: true;
    settlement: Settlement;
    paymentIntentId: string | null;
    observedAt: string;
    entitlement: EntitlementAction;
    newTransactions: StripeTransaction[];
};
export type CheckoutRequest = {
    orderId: string;
    buyerAccountId: string;
    title: string;
    currency: string;
    unitAmountMinor: number;
    taxCode: string;
    successUrl: string;
    cancelUrl: string;
    /** Unix seconds; Stripe accepts 30 minutes to 24 hours ahead. */
    expiresAt: number;
};
export type CheckoutSession = {
    id: string;
    url: string;
    expiresAt: string;
};
/** Additive factory capability; existing injected StripePort implementations need not implement it. */
export interface StripeCheckoutLocatorPort {
    readCheckoutLocator(sessionId: string): Promise<CheckoutLocator>;
}
export interface StripePort {
    /** Retrying with the same idempotency key returns the same session for 24 hours. */
    createCheckoutSession(request: CheckoutRequest, idempotencyKey: string): Promise<CheckoutSession>;
    readCheckout(sessionId: string): Promise<CheckoutSnapshot>;
    /** The Checkout Session that created a PaymentIntent, or null when it is not one of ours. */
    findCheckoutSession(paymentIntentId: string): Promise<string | null>;
}
/** Stripe refused the request: nothing was created, and retrying the same request cannot succeed. */
export declare class StripeRejectedError extends Error {
    constructor(message: string);
}
/** The outcome is unknown: the request may or may not have taken effect at Stripe. */
export declare class StripeUnavailableError extends Error {
    constructor(message: string);
}
export declare const HANDLED_STRIPE_EVENTS: readonly ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired', 'charge.refunded', 'charge.refund.updated', 'refund.created', 'refund.updated', 'refund.failed', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'];
export type HandledStripeEvent = (typeof HANDLED_STRIPE_EVENTS)[number];
/** What a verified webhook event hands to durable work: identifiers only, never the payload's state. */
export type StripeEventRef = {
    eventId: string;
    type: HandledStripeEvent;
    /** Unix seconds, from the event. */
    created: number;
    livemode: boolean;
    /** Set for `checkout.session.*` events. */
    sessionId: string | null;
    /** Set for charge, refund and dispute events. */
    paymentIntentId: string | null;
};
