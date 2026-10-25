import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import { STRIPE_EVENT_WORKFLOW, stripeEventWorkflowId, WORKFLOWS_QUEUE, type CommerceWork } from './work-contract.ts';

export function createCommerceWork(client: DBOSClient): CommerceWork {
  return {
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
}
