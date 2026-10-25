import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import {
  COMMERCE_QUEUE,
  STRIPE_EVENT_WORKFLOW,
  stripeEventPartitionKey,
  stripeEventWorkflowId,
  type CommerceWork,
} from './work-contract.ts';

export function createCommerceWork(client: DBOSClient): CommerceWork {
  return {
    async enqueueStripeEvent(ref) {
      await client.enqueue(
        {
          workflowName: STRIPE_EVENT_WORKFLOW,
          queueName: COMMERCE_QUEUE,
          workflowID: stripeEventWorkflowId(ref.eventId),
          queuePartitionKey: stripeEventPartitionKey(ref.eventId),
          workflowIDReusePolicy: 'return-existing',
        },
        ref,
      );
    },
  };
}
