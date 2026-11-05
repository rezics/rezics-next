import { DBOS } from '@dbos-inc/dbos-sdk';
import { withReadTransaction } from '../semantic/read.ts';
import { runOperationalTransaction, enqueueIntent } from '../command/operational.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import {
  recoverCreatorSale,
  bootstrapCreatorSalesHome,
  bootstrapCreatorSalesIntentsHome,
} from '../commerce/creator-sales-work.ts';
import { recoverSubjectListing, bootstrapSubjectListingHome } from '../library/listing.ts';
import { LiveCopyPendingError } from './live-copy.ts';
import { CommandUnavailableError } from './unavailable.ts';

const WORKFLOW = 'access.liveCopy.recover';
type Sweep = { accounts: []; partition: number; root: string; segment: number };
/** Maintained native pending index, not an account/history scan. Every result is a locator.
 * The dispatch timestamp only bounds scheduler work; it NEVER consumes a lifecycle hold. */
export async function recoverLiveCopyPartition(
  context: Pick<WorkContext, 'pool' | 'client'>,
  partition: number,
): Promise<boolean> {
  if (!Number.isInteger(partition) || partition < 0 || partition >= 4096)
    throw new TypeError('Invalid live copy recovery home');
  try {
    return await recoverHome(context, partition);
  } catch (error) {
    // These native evidence gaps keep the original frontier/hold unchanged. Returning
    // false advances only this scheduler sweep, never coverage or a terminal result.
    if (
      error instanceof LiveCopyPendingError ||
      (error instanceof CommandUnavailableError && ['fenced', 'moved'].includes(error.reason))
    )
      return false;
    throw error;
  }
}
async function recoverHome(context: Pick<WorkContext, 'pool' | 'client'>, partition: number): Promise<boolean> {
  const pending = await withReadTransaction(
    context.pool,
    async (tx) =>
      (
        await tx.query<{
          route: number;
          transition_id: string;
          module: string;
        }>(
          `SELECT route,transition_id,module FROM access.live_copy_transition
      WHERE route BETWEEN $1 AND $2 AND state='pending' AND next_run<=now()
      ORDER BY route,next_run,transition_id LIMIT 1`,
          [partition * 16, partition * 16 + 15],
        )
      ).rows[0],
  );
  if (!pending) {
    try {
      if (await bootstrapSubjectListingHome(context, partition)) return true;
    } catch (error) {
      if (!(error instanceof LiveCopyPendingError)) throw error;
    }
    try {
      if (await bootstrapCreatorSalesHome(context, partition)) return true;
    } catch (error) {
      if (!(error instanceof LiveCopyPendingError)) throw error;
    }
    return bootstrapCreatorSalesIntentsHome(context, partition);
  }
  await runOperationalTransaction(
    context.pool,
    { mode: 'work-step', partition, kind: WORKFLOW, accounts: [], workClient: context.client },
    async (tx) => {
      await tx.query(
        `UPDATE access.live_copy_transition SET next_run=now()+interval '10 minutes'
      WHERE route=$1 AND transition_id=$2 AND state='pending'`,
        [pending.route, pending.transition_id],
      );
    },
  );
  const locator = { route: pending.route, transitionId: pending.transition_id };
  if (pending.module === 'commerce.creator-sale') await recoverCreatorSale(context, locator);
  else if (pending.module === 'library.subject-listing') await recoverSubjectListing(context, locator);
  else throw new Error('Unknown native live copy module');
  return true;
}
export async function registerLiveCopyRecovery(context: WorkContext) {
  const advance = DBOS.registerStep((partition: number) => recoverLiveCopyPartition(context, partition), {
    name: 'access.liveCopy.page',
    ...COMMAND_STEP_RETRIES,
  });
  const continuation = DBOS.registerStep(
    async (input: Sweep) => {
      if (
        !input ||
        !Array.isArray(input.accounts) ||
        input.accounts.length ||
        !Number.isInteger(input.partition) ||
        input.partition < 0 ||
        input.partition >= 4096
      )
        throw new TypeError('Invalid live copy sweep');
      await runOperationalTransaction(
        context.pool,
        { mode: 'work-step', partition: input.partition, kind: WORKFLOW, accounts: [], workClient: context.client },
        (tx) =>
          enqueueIntent(tx, {
            queue: 'maintenance',
            workflowName: WORKFLOW,
            workflowId: `${input.root}:${input.segment}`,
            input,
          }),
      );
    },
    { name: 'access.liveCopy.continue', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (input: Sweep) => {
      const processed = await advance(input.partition);
      const partition = processed ? input.partition : input.partition + 1;
      if (partition < 4096) await continuation({ ...input, partition, segment: input.segment + 1 });
    },
    { name: WORKFLOW },
  );
  DBOS.registerWorkflow(
    async () => {
      await continuation({ accounts: [], partition: 0, root: DBOS.workflowID!, segment: 0 });
    },
    { name: 'access.liveCopy.sweep' },
  );
  await context.client.applySchedules([
    {
      scheduleName: 'access.liveCopy.every-10-minutes',
      workflowName: 'access.liveCopy.sweep',
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}
