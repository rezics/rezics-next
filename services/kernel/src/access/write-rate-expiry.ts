import { DBOS } from '@dbos-inc/dbos-sdk';
import { defineQuery } from 'reylo';
import type { AccessClient } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import type { WorkModule } from '../work/registry.ts';
import statement from './write-rate-expiry.sql';
import admissionStatement from './write-rate-expiry-admission.sql';

// As with the spend primitive, schema compatibility is checked at build/deploy;
// catalog freshness probes must not add statements to an expiry batch.
const expire = defineQuery<
  (typeof statement)['~reylo']['input'],
  (typeof statement)['~reylo']['element'],
  typeof statement.cardinality,
  'postgres'
>({ dialect: statement.dialect, sql: statement.raw, params: statement.params, cardinality: statement.cardinality });
const admit = defineQuery<
  (typeof admissionStatement)['~reylo']['input'],
  (typeof admissionStatement)['~reylo']['element'],
  typeof admissionStatement.cardinality,
  'postgres'
>({
  dialect: admissionStatement.dialect,
  sql: admissionStatement.raw,
  params: admissionStatement.params,
  cardinality: admissionStatement.cardinality,
});

/** Internal primitive: one route, one native statement, at most 1000 counter and chunk ledger deletions combined.
 * Only the registered effect below admits maintenance against local ownership.
 */
export async function expireWriteRateCounters(client: AccessClient, route: number): Promise<number> {
  partitionOf(route);
  return (await expire.run(client, { route })).length;
}

const workflowName = 'accounts.write-rate-expiry';

/** One optional, deployment-admitted partition per worker. Each minute handles
 * one of its sixteen routes; remaining history waits for another durable tick.
 * No admission means no schedule. NODE must identify this pool's local node;
 * ownership and active write state are checked under lock on every attempt.
 */
export const accountsWorkModule: WorkModule = {
  name: 'accounts',
  async register({ pool, client, queues, env }) {
    const configured = env.KERNEL_WRITE_RATE_EXPIRY_PARTITION;
    const node = env.KERNEL_WRITE_RATE_EXPIRY_NODE;
    if (configured !== undefined && (!/^(0|[1-9]\d{0,3})$/.test(configured) || Number(configured) > 4095 || !node))
      throw new Error('Invalid write rate expiry partition admission');
    const partition = configured === undefined ? undefined : Number(configured);
    if (!Object.hasOwn(queues, 'maintenance')) throw new Error('Accounts expiry requires the maintenance queue');
    const effect = DBOS.registerStep(
      async (route: number): Promise<number> => {
        if (partition === undefined || partitionOf(route) !== partition) return 0;
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          // The share lock fences ownership changes until this one batch commits.
          const owner = await admit.run(connection, { partition_no: partition });
          const removed =
            owner !== null && owner.node === node && owner.writeState === 'active'
              ? await expireWriteRateCounters(connection, route)
              : 0;
          await connection.query('COMMIT');
          return removed;
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        } finally {
          connection.release();
        }
      },
      { name: 'accounts.expireWriteRateCounters' },
    );
    DBOS.registerWorkflow(
      async (scheduledDate: Date, context: { partition: number }) => {
        if (partition === undefined || context?.partition !== partition) return;
        const minute = Math.floor(scheduledDate.getTime() / 60000);
        if (!Number.isSafeInteger(minute) || minute < 0) throw new RangeError('Invalid expiry schedule date');
        await effect(partition * 16 + (minute % 16));
      },
      { name: workflowName },
    );
    if (partition !== undefined)
      await client.applySchedules([
        {
          scheduleName: `${workflowName}.${partition}`,
          workflowName,
          schedule: '* * * * *',
          context: { partition },
          automaticBackfill: false,
          queueName: 'maintenance',
        },
      ]);
  },
};
