import type { StripeEventRef } from './model.ts';

/** ADR-0033's general queue for durable workflows; commerce adds no queue of its own. */
export const WORKFLOWS_QUEUE = 'workflows';

/** Reads the event's Checkout Session from Stripe and applies it to its order in the buyer's partition. */
export const STRIPE_EVENT_WORKFLOW = 'commerce.stripeEvent';
/** Applies a resolved Checkout Session in a workflow owned by that session and verified Stripe event. */
export const CHECKOUT_SYNC_WORKFLOW = 'commerce.checkoutSync';
/** Settles an order whose Checkout Session was never recorded or whose creation outcome is unknown. */
export const ORDER_RECONCILE_WORKFLOW = 'commerce.reconcileOrder';

/** The workflow ID is the event deduplication: a redelivered event finds its existing workflow. */
export function stripeEventWorkflowId(eventId: string): string {
  return `stripe:${eventId}`;
}

export function checkoutWorkflowId(sessionId: string, eventId: string): string {
  return `checkout:${sessionId}:${eventId}`;
}

export function orderReconcileWorkflowId(orderId: string): string {
  return `order:${orderId}:reconcile`;
}

/** Idempotency key of a workflow step's command, as ADR-0033 fixes it. */
export function stepCommandKey(workflowId: string, step: string): string {
  return `wf:${workflowId}:${step}`;
}

/** The API process only enqueues; a worker process runs the workflows. */
export type CommerceWork = {
  enqueueStripeEvent(event: StripeEventRef): Promise<void>;
};
