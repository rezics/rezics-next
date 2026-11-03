import { DBOS } from '@dbos-inc/dbos-sdk';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import type { Access } from '../request/access.ts';
import type { WorkContext } from '../work/registry.ts';
import type { ReviewCensusStep } from './review-census.ts';
import { createReviewDiscoverySource } from './review-discovery.ts';

export const REVIEW_CENSUS_WORKFLOW = 'content.review-census.sweep';
export const REVIEW_CENSUS_SCHEDULE = 'content.review-census.hourly';
export const REVIEW_CENSUS_BATCH_PAGES = 8;
const partitionWorkflow = 'content.review-census.partition';
const concurrency = 8;

/** Bound one partition's maintenance turn. The next turn resumes the installation's
 * committed signed frontier; no workflow-local cursor supplies population evidence. */
export async function maintainReviewCensusBatch(
  partition: number,
  step: (partition: number) => Promise<ReviewCensusStep>,
): Promise<ReviewCensusStep> {
  let result: ReviewCensusStep;
  for (let page = 0; page < REVIEW_CENSUS_BATCH_PAGES; page++) {
    result = await step(partition);
    if (result.state !== 'progress' && result.state !== 'changed') return result;
  }
  return result!;
}

/** Registered by Content's default supervisor. Every owner read gets its own
 * deadline and releases its connections before the next durable step. */
export function registerReviewCensusWork(
  context: WorkContext,
  access: Access,
  partitions: readonly number[],
): void {
  const page = DBOS.registerStep(
    async (partition: number) => {
      const source = createReviewDiscoverySource(
        {
          pool: context.pool,
          access,
          tokens: readMembershipWorkConfig(context.env).referenceKeys,
        },
        () => ({ actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 }),
      );
      return source.maintainCensus(partition);
    },
    {
      name: 'content.review-census.page',
      retriesAllowed: true,
      intervalSeconds: 1,
      backoffRate: 2,
      maxAttempts: 10,
    },
  );
  const maintain = DBOS.registerWorkflow(
    (partition: number) => maintainReviewCensusBatch(partition, page),
    { name: partitionWorkflow },
  );
  DBOS.registerWorkflow(
    async (_scheduledDate: Date, _context: unknown) => {
      const sweep = DBOS.workflowID!;
      for (let offset = 0; offset < partitions.length; offset += concurrency) {
        // Children execute directly: placing them behind their waiting parent on
        // the maintenance queue would deadlock overlapping sweeps.
        const handles = await Promise.all(
          partitions.slice(offset, offset + concurrency).map((partition) =>
            DBOS.startWorkflow(maintain, { workflowID: `${sweep}:partition:${partition}` })(partition),
          ),
        );
        await Promise.all(handles.map((handle) => handle.getResult()));
      }
    },
    { name: REVIEW_CENSUS_WORKFLOW },
  );
}
