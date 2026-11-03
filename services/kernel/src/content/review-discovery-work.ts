import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkContext } from '../work/registry.ts';
import { WORK_APPLICATION } from '../work/client.ts';
import {
  createReviewDiscoveryDispatchEffect,
  createReviewDiscoveryEffect,
  processReviewDiscoveryPage,
} from './review-discovery-lifecycle.ts';
import type { ReviewDiscoveryWork } from './review-discovery-events.ts';

export const REVIEW_DISCOVERY_WORKFLOW = 'content.review-discovery.invalidate';

/** Mounted by createContentWork, hence also by registerContent in the default worker.
 * Each step owns at most one identity page and releases all checkouts before yielding. */
export function registerReviewDiscoveryWork(context: WorkContext): void {
  const page = DBOS.registerStep((ref: ReviewDiscoveryWork) => processReviewDiscoveryPage(context.pool, ref), {
    name: 'content.review-discovery.page',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 10,
  });
  DBOS.registerWorkflow(
    async (ref: ReviewDiscoveryWork) => {
      while (!(await page(ref)).complete) {
        // Cursor and receiving effects are durable; replaying any page is idempotent.
      }
    },
    { name: REVIEW_DISCOVERY_WORKFLOW },
  );
  context.addEffects([
    createReviewDiscoveryEffect(context.pool),
    createReviewDiscoveryDispatchEffect(context.pool, async (ref) => {
      await context.client.enqueue(
        {
          applicationName: WORK_APPLICATION,
          workflowName: REVIEW_DISCOVERY_WORKFLOW,
          workflowID: `${REVIEW_DISCOVERY_WORKFLOW}:${ref.route}:${ref.id}`,
          workflowIDReusePolicy: 'return-existing',
          queueName: 'effects',
        },
        ref,
      );
    }),
  ]);
}
