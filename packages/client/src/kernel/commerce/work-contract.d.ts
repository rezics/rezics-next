import type { StripeEventRef } from './model.ts';
/** ADR-0033's general queue for durable workflows; commerce adds no queue of its own. */
export declare const WORKFLOWS_QUEUE = "workflows";
/** Reads the event's Checkout Session from Stripe and applies it to its order in the buyer's partition. */
export declare const STRIPE_EVENT_WORKFLOW = "commerce.stripeEvent";
/** Settles an order whose Checkout Session was never recorded or whose creation outcome is unknown. */
export declare const ORDER_RECONCILE_WORKFLOW = "commerce.reconcileOrder";
/** The workflow ID is the event deduplication: a redelivered event finds its existing workflow. */
export declare function stripeEventWorkflowId(eventId: string): string;
export declare function orderReconcileWorkflowId(orderId: string): string;
/** Idempotency key of a workflow step's command, as ADR-0033 fixes it. */
export declare function stepCommandKey(workflowId: string, step: string): string;
/** The API process only enqueues; a worker process runs the workflows. */
export type CommerceWork = {
    enqueueStripeEvent(event: StripeEventRef): Promise<void>;
};
