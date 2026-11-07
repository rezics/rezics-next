import { runFollowCountPartition } from '../application/index.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { withConnection } from '../../database/pool.ts';
import type { WorkContext } from '../../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../../work/retries.ts';
import {
  bootstrapFollowCountTargets,
  bootstrapNextFollowCountOwner,
  discoverFollowCountOwners,
} from './follow-count-bootstrap.ts';
import { sampleFollowCountHealth } from './follow-count-health.ts';
import { admitFollowCountAccount, reconcileFollowCountAccountPage } from './follow-count-lifecycle.ts';
import { FOLLOW_COUNT_ACCOUNT_EVENTS } from '../contract/index.ts';
import { bootstrapFollowCountOwner, pendingFollowCountKeys } from './follow-count-source.ts';
import { countRoute } from './follow-count-runtime.ts';
import { deliverFollowCount } from './follow-count-target.ts';

const PARTITION_WORK = 'library.followCountPartition';
const DISCOVERY = 'library.followCountDiscovery';
type Discovery = { root: string; after: number };
type PartitionSegment = { partition: number; root: string; sequence: number };

/** One installed source scheduler and native Effect consumer; SQL, never saved
 * positive DBOS outputs, remains the source of replacements and unfinished age. */
export async function registerFollowCountWork(context: WorkContext) {
  const { pool, client, addEffects } = context;
  const deps = { pool, client };
  const bootstrapOwner = DBOS.registerStep(
    async (input: { accounts: readonly string[]; accountId: string }) => {
      await bootstrapFollowCountOwner(deps, input.accountId);
    },
    { name: 'library.followCountBootstrapOwnerPage', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(async (input: { accounts: readonly string[]; accountId: string }) => bootstrapOwner(input), {
    name: 'library.followCountBootstrapOwner',
  });
  const targetPage = DBOS.registerStep((partition: number) => bootstrapFollowCountTargets(deps, partition), {
    name: 'library.followCountTargetPage',
    ...COMMAND_STEP_RETRIES,
  });
  const discoveryPage = DBOS.registerStep((partition: number) => discoverFollowCountOwners(deps, partition), {
    name: 'library.followCountOwnerDiscoveryPage',
    ...COMMAND_STEP_RETRIES,
  });
  const ownerPage = DBOS.registerStep((partition: number) => bootstrapNextFollowCountOwner(deps, partition), {
    name: 'library.followCountOwnerPage',
    ...COMMAND_STEP_RETRIES,
  });
  const accountKey = DBOS.registerStep(
    async (partition: number) =>
      withConnection(
        pool,
        async (tx) =>
          (
            await tx.query<{ account_id: string }>(
              `SELECT account_id FROM library.follow_count_account_work
      WHERE (route >> 4)=$1 ORDER BY oldest_pending_at,route,account_id LIMIT 1`,
              [partition],
            )
          ).rows[0]?.account_id ?? null,
      ),
    { name: 'library.followCountAccountKey', ...COMMAND_STEP_RETRIES },
  );
  const accountPage = DBOS.registerStep((accountId: string) => reconcileFollowCountAccountPage(deps, accountId), {
    name: 'library.followCountAccountPage',
    ...COMMAND_STEP_RETRIES,
  });
  const pending = DBOS.registerStep((partition: number) => pendingFollowCountKeys(pool, partition), {
    name: 'library.followCountPendingKeys',
    ...COMMAND_STEP_RETRIES,
  });
  // Each saved result/input contains only a locator. Delivery itself always
  // re-reconciles SQL on retry, including after a target-commit/source-ACK crash.
  const deliver = DBOS.registerStep((key: Parameters<typeof deliverFollowCount>[1]) => deliverFollowCount(deps, key), {
    name: 'library.followCountDeliver',
    ...COMMAND_STEP_RETRIES,
  });
  const sample = DBOS.registerStep((partition: number) => sampleFollowCountHealth(deps, partition), {
    name: 'library.followCountSample',
    ...COMMAND_STEP_RETRIES,
  });
  const continuation = DBOS.registerStep(
    async (input: PartitionSegment) => {
      await client.enqueue(
        {
          workflowName: PARTITION_WORK,
          queueName: 'maintenance',
          workflowID: `library:follow-count:segment:${input.root}:${input.sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    { name: 'library.followCountContinue', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (input: number | PartitionSegment) => {
      const segment = typeof input === 'number' ? { partition: input, root: DBOS.workflowID!, sequence: 0 } : input;
      const { partition } = segment;
      const more = await runFollowCountPartition(
        {
          targets: targetPage,
          discover: discoveryPage,
          owner: ownerPage,
          accountKey,
          accountPage,
          pending,
          deliver,
          sample,
        },
        partition,
      );
      if (more) await continuation({ ...segment, sequence: segment.sequence + 1 });
    },
    { name: PARTITION_WORK },
  );
  const dispatch = DBOS.registerStep(
    async (input: Discovery) => {
      const partitions = await withConnection(
        pool,
        async (tx) =>
          (
            await tx.query<{ partition_no: number }>(
              'SELECT partition_no FROM library.follow_count_partition WHERE partition_no>$1 ORDER BY partition_no LIMIT 100',
              [input.after],
            )
          ).rows,
      );
      for (const { partition_no: partition } of partitions)
        await client.enqueue(
          {
            workflowName: PARTITION_WORK,
            queueName: 'maintenance',
            workflowID: `${input.root}:partition:${partition}`,
            workflowIDReusePolicy: 'return-existing',
          },
          partition,
        );
      if (partitions.length === 100)
        await client.enqueue(
          {
            workflowName: DISCOVERY,
            queueName: 'maintenance',
            workflowID: `${input.root}:after:${partitions.at(-1)!.partition_no}`,
            workflowIDReusePolicy: 'return-existing',
          },
          { root: input.root, after: partitions.at(-1)!.partition_no },
        );
    },
    { name: 'library.followCountDispatch', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(async (input?: Discovery) => dispatch(input ?? { root: DBOS.workflowID!, after: -1 }), {
    name: DISCOVERY,
  });
  await client.applySchedules([
    {
      scheduleName: 'library.followCounts.every-10-seconds',
      workflowName: DISCOVERY,
      schedule: '*/10 * * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
  addEffects([
    {
      name: 'library_follow_count_account',
      types: [...FOLLOW_COUNT_ACCOUNT_EVENTS],
      admit: admitFollowCountAccount,
      async run(event) {
        if (
          typeof event.data !== 'object' ||
          event.data === null ||
          !('accountId' in event.data) ||
          typeof event.data.accountId !== 'string'
        )
          throw new TypeError('Invalid follow count account wake-up');
        const { partitionOf } = await import('../../route/route.ts');
        await client.enqueue(
          {
            workflowName: PARTITION_WORK,
            queueName: 'maintenance',
            workflowID: `library:follow-count:account:${event.id}`,
            workflowIDReusePolicy: 'return-existing',
          },
          partitionOf(countRoute(event.data.accountId)),
        );
      },
    },
  ]);
}
