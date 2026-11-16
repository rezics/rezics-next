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
import { sampleFollowCountHealth, sampleFollowCountHealthPage } from './follow-count-health.ts';
import { admitFollowCountAccount, reconcileFollowCountAccountPage } from './follow-count-lifecycle.ts';
import { FOLLOW_COUNT_ACCOUNT_EVENTS } from '../contract/index.ts';
import { bootstrapFollowCountOwner, pendingFollowCountKeys } from './follow-count-source.ts';
import { countRoute } from './follow-count-runtime.ts';
import { deliverFollowCount } from './follow-count-target.ts';

const PARTITION_WORK = 'library.followCountPartition';
const DISCOVERY = 'library.followCountDiscovery';
const SWEEP = 'library.followCountSweep';
const HOME_PAGE_SIZE = 100;
const BATCH_SIZE = 8;
const BATCH_CONCURRENCY = 4;
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
  const maintain = (partition: number) =>
    runFollowCountPartition(
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
  DBOS.registerWorkflow(
    async (input: number | PartitionSegment) => {
      const segment = typeof input === 'number' ? { partition: input, root: DBOS.workflowID!, sequence: 0 } : input;
      const more = await maintain(segment.partition);
      if (more) await continuation({ ...segment, sequence: segment.sequence + 1 });
    },
    { name: PARTITION_WORK },
  );
  const homes = DBOS.registerStep(
    (after: number) =>
      withConnection(pool, async (tx) => {
        const { rows } = await tx.query<{ partition_no: number }>(
          'SELECT partition_no FROM library.follow_count_partition WHERE partition_no>$1 ORDER BY partition_no LIMIT $2',
          [after, HOME_PAGE_SIZE],
        );
        return rows.map(({ partition_no }) => partition_no);
      }),
    { name: 'library.followCountHomes', ...COMMAND_STEP_RETRIES },
  );
  const samplePage = DBOS.registerStep((partitions: number[]) => sampleFollowCountHealthPage(deps, partitions), {
    name: 'library.followCountSamplePage',
    ...COMMAND_STEP_RETRIES,
  });
  const batch = DBOS.registerWorkflow(
    async (partitions: number[]) => {
      let failure: { cause: unknown } | undefined;
      if (await DBOS.patch('library-follow-count-sample-page')) {
        try {
          partitions = await samplePage(partitions);
        } catch (cause) {
          failure = { cause };
        }
      }
      for (const partition of partitions) {
        try {
          await maintain(partition);
        } catch (cause) {
          failure ??= { cause };
        }
      }
      if (failure) throw failure.cause;
    },
    { name: 'library.followCountSweepBatch' },
  );
  DBOS.registerWorkflow(
    async () => {
      const root = DBOS.workflowID!;
      let after = -1;
      let failure: PromiseRejectedResult | undefined;
      for (;;) {
        const partitions = await homes(after);
        // Direct children share the sweep's maintenance slot. Queuing every
        // home separately makes the sweep wait thousands of queue polls.
        for (let offset = 0; offset < partitions.length; offset += BATCH_CONCURRENCY * BATCH_SIZE) {
          const groups = Array.from({ length: BATCH_CONCURRENCY }, (_, index) => {
            const start = offset + index * BATCH_SIZE;
            return partitions.slice(start, start + BATCH_SIZE);
          }).filter((group) => group.length > 0);
          const handles = await Promise.allSettled(
            groups.map((group) => DBOS.startWorkflow(batch, { workflowID: `${root}:batch:${group[0]}` })(group)),
          );
          const finished = await Promise.allSettled(
            handles.map((handle) => {
              if (handle.status === 'rejected') return Promise.reject(handle.reason);
              return handle.value.getResult();
            }),
          );
          failure ??= finished.find((result) => result.status === 'rejected');
        }
        if (partitions.length < HOME_PAGE_SIZE) break;
        after = partitions.at(-1)!;
      }
      if (failure) throw failure.reason;
    },
    { name: SWEEP },
  );
  const enqueueSweep = async (workflowID?: string) => {
    await client.enqueue({
      workflowName: SWEEP,
      queueName: 'maintenance',
      ...(workflowID === undefined ? {} : { workflowID }),
      workflowIDReusePolicy: 'return-existing',
      deduplicationID: SWEEP,
      duplicationPolicy: 'return-existing',
    });
  };
  const startSweep = DBOS.registerStep((root: string) => enqueueSweep(`${root}:sweep`), {
    name: 'library.followCountStartSweep',
    ...COMMAND_STEP_RETRIES,
  });
  // The native scheduler supplies its fire time, never a discovery cursor.
  // A retained discovery invocation can safely wake the same full sweep.
  DBOS.registerWorkflow(async (_input?: Date | Discovery) => startSweep(DBOS.workflowID!), { name: DISCOVERY });
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
  // Cold registration wakes the same deduplicated sweep before the first cron turn.
  const { rowCount: cold } = await withConnection(pool, (tx) =>
    tx.query('SELECT 1 FROM library.follow_count_health WHERE node=0 AND NOT ready'),
  );
  if (cold) await enqueueSweep();
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
