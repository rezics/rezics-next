import type { StripeEventRef } from './model.ts';
/** ADR-0033's general queue for durable workflows; commerce adds no queue of its own. */
export declare const WORKFLOWS_QUEUE = "workflows";
/** Reads the event's Checkout Session from Stripe and applies it to its order in the buyer's partition. */
export declare const STRIPE_EVENT_WORKFLOW = "commerce.stripeEvent";
/** Applies a resolved Checkout Session in a workflow owned by that session and verified Stripe event. */
export declare const CHECKOUT_SYNC_WORKFLOW = "commerce.checkoutSync";
/** Settles an order whose Checkout Session was never recorded or whose creation outcome is unknown. */
export declare const ORDER_RECONCILE_WORKFLOW = "commerce.reconcileOrder";
/** Rechecks a pending order once its Checkout Session has expired. */
export declare const EXPIRY_SYNC_WORKFLOW = "commerce.expirySync";
/** Internal service caller; every separately named repair is a distinct durable trigger. */
export declare const KNOWN_ORDER_REPAIR_WORKFLOW = "commerce.repairOrder";
export declare function checkoutPartitionKey(provider: Readonly<{
    accountNamespace: string;
    livemode: boolean;
}>, sessionId: string): string;
export declare function knownOrderRepairWorkflowId(orderId: string, name: string): string;
/** The workflow ID is the event deduplication: a redelivered event finds its existing workflow. */
export declare function stripeEventWorkflowId(eventId: string): string;
export declare function checkoutWorkflowId(sessionId: string, eventId: string): string;
export declare function orderReconcileWorkflowId(orderId: string): string;
export declare function orderExpiryWorkflowId(orderId: string): string;
/** Idempotency key of a workflow step's command, as ADR-0033 fixes it. */
export declare function stepCommandKey(workflowId: string, step: string): string;
/** The API process only enqueues; a worker process runs the workflows. */
export type CommerceWork = {
    enqueueStripeEvent(event: StripeEventRef): Promise<void>;
};
