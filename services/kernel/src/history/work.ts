import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PoolClient } from 'pg';
import type { CloudEvent } from '../events/log.ts';
import type { WorkModule } from '../work/registry.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { advancePreferenceHistory } from './receipt.ts';

async function admit(client: PoolClient, event: CloudEvent) {
  const { accountId } = event.data as { accountId: string };
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid preference erasure anchor');
  // Permanent native obligation is the applicability proof. Only exact owner partition is known
  // for preferences; this does not discover foreign artifacts or establish global coverage.
  const admitted = await client.query(
    `INSERT INTO core.preference_history_job
    (job_id,partition_no,account_route,account_id,barrier_id)
    SELECT $1,$2,e.route,e.account_id,e.account_id FROM access.erasure e
    WHERE e.route=$3 AND e.account_id=$4 ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id
      WHERE core.preference_history_job.partition_no=EXCLUDED.partition_no
        AND core.preference_history_job.account_route=EXCLUDED.account_route
        AND core.preference_history_job.account_id=EXCLUDED.account_id
        AND core.preference_history_job.barrier_id=EXCLUDED.barrier_id
    RETURNING job_id`,
    [event.id, partitionOf(route), route, accountId],
  );
  if (admitted.rows.length !== 1) throw new TypeError('Missing committed preference erasure obligation');
}

export const preferenceHistoryWorkModule: WorkModule = {
  name: 'preference_history',
  register(context) {
    const advance = DBOS.registerStep(
      async (jobId: string) => {
        try {
          return await advancePreferenceHistory(context.pool, jobId);
        } catch {
          throw new Error('preference_history_pending');
        }
      },
      { name: 'history.preferences.advance', retriesAllowed: true, maxAttempts: 10 },
    );
    DBOS.registerWorkflow(
      async (jobId: string) => {
        while ((await advance(jobId)) === 'more') {
          /* each step commits and releases its partition */
        }
        return 'covered-pending';
      },
      { name: 'history.preferences' },
    );
    context.addEffects([
      {
        name: 'preference_history',
        types: ['com.rezics.access.account-tombstoned.v1'],
        admit,
        async run(event) {
          // The run path repairs missing admission and tolerates redelivery after minimization.
          const client = await context.pool.connect();
          try {
            await admit(client, event);
          } finally {
            client.release();
          }
          await context.client.enqueue(
            {
              workflowName: 'history.preferences',
              workflowID: event.id,
              workflowIDReusePolicy: 'return-existing',
              queueName: 'maintenance',
            },
            event.id,
          );
        },
      },
    ]);
  },
};
