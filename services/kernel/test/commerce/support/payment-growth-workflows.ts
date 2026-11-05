import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import {
  KNOWN_ORDER_REPAIR_WORKFLOW,
  STRIPE_EVENT_WORKFLOW,
  knownOrderRepairWorkflowId,
  stripeEventWorkflowId,
} from '../../../src/commerce/work-contract.ts';
import type { StripeEventRef } from '../../../src/commerce/model.ts';
import type { createCommerceWork } from '../../../src/commerce/enqueue.ts';
import { newId, routeOf } from '../../../src/route/route.ts';

type CommerceWork = ReturnType<typeof createCommerceWork>;
type WorkflowSeed = {
  workflowId: string;
  workflowName: string;
  enqueue(): Promise<void>;
};

const batchSize = 64;

async function enqueueAndVerify(client: DBOSClient, seeds: readonly WorkflowSeed[]) {
  const ids = seeds.map(({ workflowId }) => workflowId);
  if (new Set(ids).size !== ids.length) throw new Error('Payment growth workflow IDs must be independent');

  for (let offset = 0; offset < seeds.length; offset += batchSize) {
    const batch = seeds.slice(offset, offset + batchSize);
    await Promise.all(
      batch.map(async ({ workflowId, enqueue }) => {
        await enqueue();
        await client.retrieveWorkflow(workflowId).getResult();
      }),
    );

    const statuses = await client.listWorkflows({
      workflowIDs: batch.map(({ workflowId }) => workflowId),
      loadInput: false,
      loadOutput: false,
      limit: batch.length,
    });
    const byId = new Map(statuses.map((status) => [status.workflowID, status]));
    if (statuses.length !== batch.length || byId.size !== batch.length)
      throw new Error(`DBOS recorded ${statuses.length} of ${batch.length} seeded payment growth workflows`);

    for (const seed of batch) {
      const status = byId.get(seed.workflowId);
      if (
        status?.status !== 'SUCCESS' ||
        status.workflowName !== seed.workflowName ||
        typeof status.completedAt !== 'number'
      )
        throw new Error(`DBOS workflow ${seed.workflowId} did not complete as ${seed.workflowName}`);
    }
  }
}

export function createPaymentGrowthWorkflowSeeder(client: DBOSClient, work: CommerceWork) {
  return {
    async providerEvents(sessionId: string, from: number, to: number) {
      const created = Math.floor(Date.now() / 1000);
      const seeds = Array.from({ length: to - from }, (): WorkflowSeed => {
        const eventId = `evt_growth${Bun.randomUUIDv7().replaceAll('-', '')}`;
        const ref: StripeEventRef = {
          eventId,
          type: 'checkout.session.completed',
          created,
          livemode: false,
          sessionId,
          paymentIntentId: null,
        };
        return {
          workflowId: stripeEventWorkflowId(eventId),
          workflowName: STRIPE_EVENT_WORKFLOW,
          enqueue: () => work.enqueueStripeEvent(ref),
        };
      });
      await enqueueAndVerify(client, seeds);
    },

    async unrelatedHistory(orderIdSeed: string, from: number, to: number) {
      const route = routeOf(orderIdSeed);
      if (route === null) throw new Error('Payment growth repair seed must have a route');
      const seeds = Array.from({ length: to - from }, (): WorkflowSeed => {
        const orderId = newId(route);
        const name = `growth${Bun.randomUUIDv7().replaceAll('-', '')}`;
        const workflowId = knownOrderRepairWorkflowId(orderId, name);
        return {
          workflowId,
          workflowName: KNOWN_ORDER_REPAIR_WORKFLOW,
          async enqueue() {
            const enqueuedId = await work.enqueueKnownOrderRepair(orderId, name);
            if (enqueuedId !== workflowId)
              throw new Error('Commerce repair enqueue returned an unexpected workflow ID');
          },
        };
      });
      await enqueueAndVerify(client, seeds);
    },
  };
}
