import type { Kernel } from '@rezics/client';

type SubjectSummary = NonNullable<
  Kernel['~Routes']['v1']['offers'][':offerId']['get']['response'][200]['offer']['subject']
>;

/**
 * COMMERCE_DRIVER is an absolute path or file URL exporting
 * createCommerceDriver(): Promise<CommerceDriver>. Each factory call owns an isolated,
 * migrated PostgreSQL database, real Auth/Access personas with real Auth-issued
 * tokens, and a real DBOS executor running the production commerce workflows.
 * Every HTTP request goes through createKernel(...).handle, including webhooks.
 * close stops the executor/server and removes database, tokens and installed faults.
 *
 * Stripe is a local fake HTTP server serving Stripe's documented object shapes.
 * The production Stripe adapter is configured with that host; it is never mocked.
 * Fake controls change Stripe state as Stripe would, never commerce rows. Events
 * are serialized Stripe Event bytes. The suite signs those exact bytes with the
 * test secret using Stripe's t=...,v1=... scheme and delivers them over HTTP.
 *
 * The driver only maps transport and inspects authoritative rows, CloudEvents and
 * DBOS workflows. It never implements settlement, entitlement or authorization
 * rules, substitutes an in-memory commerce model, or writes offers with SQL.
 * Offers and offer revisions are provisioned through the trusted module command.
 * buyer, other and refunded are distinct active accounts with standing order:create
 * authority; anonymous has no token; suspended has real suspended credentials.
 * refunded starts empty: the suite buys and refunds as that account.
 */
export type Persona = 'buyer' | 'other' | 'refunded' | 'anonymous' | 'suspended';
export type Settlement = 'pending' | 'paid' | 'failed' | 'unknown';
export interface OfferView extends Pick<OfferFixture, 'id' | 'targetSubjectId' | 'title' | 'currency' | 'unitAmountMinor' | 'state'> {
  subject: SubjectSummary | null;
}
export interface OfferFixture {
  id: string; targetSubjectId: string; title: string; currency: string;
  unitAmountMinor: number; state: 'active' | 'delisted';
  creatorAccountId: string; taxCode: string; royaltyBasisPoints: number; revision: number;
}
export interface OrderView {
  id: string; offerId: string; settlement: Settlement; checkoutUrl: string | null;
  checkoutExpiresAt: string | null; entitlementId: string | null; createdAt: string;
}
export interface OrderReadView extends OrderView {
  title: string; targetSubjectId: string; subject: SubjectSummary | null;
}
export interface EntitlementView {
  id: string; offerId: string; orderId: string; targetSubjectId: string;
  grantedAt: string; revokedAt: string | null; revokeReason: 'refund' | 'dispute' | null;
  active: boolean; summary: SubjectSummary | null;
}
export interface OrderRow {
  id: string; buyerAccountId: string; route: number; partition: number; offerId: string;
  offerRevision: number; creatorAccountId: string; title: string; currency: string;
  unitAmountMinor: number; taxCode: string; royaltyBasisPoints: number;
  settlement: Settlement; checkoutSessionId: string | null; checkoutUrl: string | null;
}
export interface Inspection {
  orders: OrderRow[];
  entitlements: (Omit<EntitlementView, 'summary'> & { accountId: string; route: number; partition: number })[];
  events: { id: string; type: string; data: Record<string, string> }[];
  workflows: { id: string; name: string; status: string }[];
  transactions: { id: string; orderId: string; kind: string; amountMinor: number }[];
}
export type StripeEventType =
  | 'checkout.session.completed' | 'checkout.session.async_payment_succeeded'
  | 'checkout.session.async_payment_failed' | 'checkout.session.expired'
  | 'charge.refunded' | 'charge.dispute.created' | 'charge.dispute.updated' | 'charge.dispute.closed';
export interface StripeCreate {
  sessionId: string;
  idempotencyKey: string;
  parameters: {
    mode: string; client_reference_id: string;
    metadata: { order_id: string; account_id: string };
    payment_intent_data: { metadata: { order_id: string } };
    line_items: { quantity: number; price_data: {
      currency: string; unit_amount: number; product_data: { name: string; tax_code: string };
    } }[];
    expires_at: number; success_url: string; cancel_url: string;
    managed_payments?: { enabled: boolean }; automatic_tax?: { enabled: boolean };
  };
}
export interface CommerceDriver {
  readonly accounts: Record<Exclude<Persona, 'anonymous'>, { id: string; route: number; partition: number }>;
  /** Valid, absent routable IDs, not malformed IDs that could trigger validation. */
  readonly unknown: { offerId: string; orderId: string; entitlementId: string };
  readonly configuration: { webhookSecret: string; successUrl: string; cancelUrl: string };
  setTime(instant: string): Promise<void>;
  now(): string;
  configureCheckout(input: { managedPayments: boolean }): Promise<void>;
  provisionOffer(input?: { unitAmountMinor?: number }): Promise<OfferFixture>;
  reviseOffer(id: string, input: { unitAmountMinor?: number; state?: 'delisted' }): Promise<OfferFixture>;
  /** Raw Response, preserving HTTP status, body and headers without outcome normalization. */
  request(as: Persona, input: {
    method: 'GET' | 'POST'; path: string; headers?: Record<string, string>;
    body?: unknown; rawBody?: Uint8Array;
  }): Promise<Response>;
  inspect(): Promise<Inspection>;
  /** Idempotently hold the actual executor before dequeuing work; HTTP enqueue remains live. */
  holdWork(): Promise<void>;
  /** Resume and await all enqueued commerce work, including reconciliation, without sleeps. */
  settle(): Promise<void>;
  stripe: {
    /** Captured adapter requests; repeated calls may share a sessionId. */
    creates(): Promise<StripeCreate[]>;
    sessions(): Promise<{ id: string }[]>;
    /** Reject creates nothing; lose creates a session but drops its response, once. */
    failNextCreate(mode: 'reject' | 'lose'): Promise<void>;
    pay(sessionId: string): Promise<void>;
    completeUnpaid(sessionId: string): Promise<void>;
    asyncPay(sessionId: string): Promise<void>;
    failPayment(sessionId: string): Promise<void>;
    expire(sessionId: string): Promise<void>;
    /** Stripe-originated refund; remaining refunds the outstanding charge including tax. No rezics HTTP endpoint. */
    refund(sessionId: string, amountMinor: number | 'remaining'): Promise<void>;
    dispute(sessionId: string, status: 'needs_response' | 'won' | 'lost' | 'warning_needs_response'): Promise<void>;
    /**
     * Serialize a fresh event with supplied ID and the fake's current object.
     * payloadPaymentStatus changes only the serialized payload, never current Stripe state.
     */
    event(input: {
      id: string; type: StripeEventType; sessionId: string; payloadPaymentStatus?: 'paid';
    }): Promise<Uint8Array>;
  };
  /**
   * Seed unrelated orders to this total, across partitions and for unrelated accounts
   * sharing the buyer's partition. Preserve tested accounts' visible rows and offers.
   */
  seedUnrelatedOrders(total: number): Promise<void>;
  /**
   * Observe actual SQL statements and PostgreSQL buffers attributable to the callback's
   * request, excluding fixture/inspection SQL and asynchronous worker work. Counts are
   * instrumentation, never constants or estimates; do not replay a mutation to measure it.
   */
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; statements: number; buffers: number }>;
  close(): Promise<void>;
}
