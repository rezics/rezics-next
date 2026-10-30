import { runCommand } from '../command/command.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkContext } from '../work/registry.ts';
import { semanticRetention } from './retention.ts';

const workflowName = 'semantic.recordRetention';
/** The maintenance scheduler revisits a bounded page per actual pending home, including held pages.
 * No private payload, account identity or authority object enters durable workflow arguments/results.
 */
export async function registerRecordRetentionWork({ pool, client, clock }: WorkContext) {
  const adapter = semanticRetention(pool, { clock });
  const page = DBOS.registerStep(async (partition: number, key: string) => adapter.step({ partition, limit: 2, key }), {
    name: 'semantic.recordRetention.page',
    retriesAllowed: true,
    maxAttempts: 3,
  });
  const homes = DBOS.registerStep(
    async () =>
      (
        await runCommand(pool, { partition: 0, clock }, async (tx) => {
          const cursor = (
            await tx.query<{ after_home: number }>(`SELECT after_home FROM semantic.record_retention_schedule
      WHERE partition_no=0 FOR UPDATE`)
          ).rows[0];
          if (!cursor) throw new Error('record_retention_schedule_unavailable');
          let result = await tx.query<{ partition_no: number }>(
            `SELECT partition_no FROM semantic.record_retention_home
      WHERE partition_no>$1 ORDER BY partition_no LIMIT 16`,
            [cursor.after_home],
          );
          if (!result.rows.length)
            result = await tx.query<{ partition_no: number }>(
              'SELECT partition_no FROM semantic.record_retention_home ORDER BY partition_no LIMIT 16',
            );
          await tx.query('UPDATE semantic.record_retention_schedule SET after_home=$1 WHERE partition_no=0', [
            result.rows.at(-1)?.partition_no ?? -1,
          ]);
          return { value: result.rows.map((row) => row.partition_no), events: [] };
        })
      ).value,
    { name: 'semantic.recordRetention.homes' },
  );
  DBOS.registerWorkflow(
    async () => {
      const partitions = await homes();
      for (const partition of partitions) {
        // SDK step identity is stable across recovery of this scheduled run.
        const key = await DBOS.runStep(async () => crypto.randomUUID(), { name: 'semantic.recordRetention.pageKey' });
        await page(partition, key);
      }
    },
    { name: workflowName },
  );
  await client.applySchedules([
    {
      scheduleName: 'semantic.recordRetention.every-10-minutes',
      workflowName,
      schedule: '*/10 * * * *',
      queueName: 'maintenance',
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);
}
