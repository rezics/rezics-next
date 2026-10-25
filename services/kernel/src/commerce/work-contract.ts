import type { StripeEventRef } from './model.ts';

/** One partitioned DBOS queue: at most one workflow runs at a time for each partition key. */
export const COMMERCE_QUEUE = 'commerce';
export const COMMERCE_QUEUE_OPTIONS = { partitionConcurrency: 1 } as const;

/** Resolves the Checkout Session of a verified event, then enqueues the session's sync. */
export const STRIPE_EVENT_WORKFLOW = 'commerce.stripeEvent';
/** Reads the session's current state from Stripe and applies it to its order in the buyer's partition. */
export const CHECKOUT_SYNC_WORKFLOW = 'commerce.syncCheckout';
/** Settles an order whose Checkout Session was never recorded or whose creation outcome is unknown. */
export const ORDER_RECONCILE_WORKFLOW = 'commerce.reconcileOrder';

/** The workflow ID is the event deduplication: a redelivered event finds its existing workflow. */
export function stripeEventWorkflowId(eventId: string): string {
  return `stripe:${eventId}`;
}
export function stripeEventPartitionKey(eventId: string): string {
  return `stripe:${eventId}`;
}

export function checkoutSyncWorkflowId(sessionId: string, eventId: string): string {
  return `checkout:${sessionId}:${eventId}`;
}
/** Every sync of one Checkout Session runs in its own queue partition, one at a time. */
export function checkoutSyncPartitionKey(sessionId: string): string {
  return sessionId;
}

export function orderReconcileWorkflowId(orderId: string): string {
  return `order:${orderId}:reconcile`;
}
export function orderReconcilePartitionKey(orderId: string): string {
  return `order:${orderId}`;
}

/** Idempotency key of a workflow step's command, as ADR-0033 fixes it. */
export function stepCommandKey(workflowId: string, step: string): string {
  return `wf:${workflowId}:${step}`;
}

/** The API process only enqueues; a worker process runs the workflows. */
export type CommerceWork = {
  enqueueStripeEvent(event: StripeEventRef): Promise<void>;
};
