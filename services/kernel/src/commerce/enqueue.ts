import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import {
  STRIPE_EVENT_WORKFLOW,
  stripeEventWorkflowId,
  WORKFLOWS_QUEUE,
  KNOWN_ORDER_REPAIR_WORKFLOW,
  knownOrderRepairWorkflowId,
  type CommerceWork,
} from './work-contract.ts';
import { classifyStripeEvent, verifyStripeEvent } from './webhook.ts';
import { routeOf } from '../route/route.ts';

export function createCommerceWork(client: DBOSClient) {
  const work: CommerceWork = {
    async enqueueStripeEvent(ref) {
      await client.enqueue(
        {
          workflowName: STRIPE_EVENT_WORKFLOW,
          queueName: WORKFLOWS_QUEUE,
          workflowID: stripeEventWorkflowId(ref.eventId),
          workflowIDReusePolicy: 'return-existing',
        },
        ref,
      );
    },
  };
  return {
    ...work,
    /** Internal service operation. No buyer identity or public action is synthesized. */
    async enqueueKnownOrderRepair(orderId: string, name: string): Promise<string> {
      if (routeOf(orderId) === null) throw new TypeError('A routable order is required');
      const workflowID = knownOrderRepairWorkflowId(orderId, name);
      await client.enqueue(
        {
          workflowName: KNOWN_ORDER_REPAIR_WORKFLOW,
          workflowID,
          workflowIDReusePolicy: 'return-existing',
          queueName: WORKFLOWS_QUEUE,
        },
        orderId,
      );
      return workflowID;
    },
    /** A finite outage page of original signed deliveries. Retain only its event-ID continuation. */
    async recoverSignedEventPage(
      page: readonly { raw: Uint8Array; signature: string }[],
      secrets: readonly string[],
      receivedAt = Date.now(),
    ) {
      if (
        page.length > 100 ||
        page.some(({ raw, signature }) => raw.byteLength > 256 * 1024 || signature.length > 16 * 1024)
      )
        throw new TypeError('Stripe recovery page exceeds the intake bounds');
      // Verify/classify the whole bounded page before durable dispatch; never trust saved event state.
      const refs = [];
      for (const delivery of page) {
        const event = await verifyStripeEvent(delivery.raw, delivery.signature, secrets, receivedAt);
        const ref = classifyStripeEvent(event);
        if (ref) refs.push(ref);
      }
      for (const ref of refs) await work.enqueueStripeEvent(ref);
      return { count: refs.length, afterEventId: refs.at(-1)?.eventId ?? null };
    },
  };
}
