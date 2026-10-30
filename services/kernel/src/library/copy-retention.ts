import { DBOS } from '@dbos-inc/dbos-sdk';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { PARTITIONS, partitionOf } from '../route/route.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import type { WorkContext } from '../work/registry.ts';
import { workStepDeadline } from './command-support.ts';
import duePage from './copy-retention-page.sql';
import purge from './copy-retention-purge.sql';

export const COPY_RETENTION_WORKFLOW = 'library.copyRetention';
export const COPY_RETENTION_EXACT_WORKFLOW = 'library.copyRetention.exact';
export const COPY_RETENTION_SCHEDULE = 'library.copyRetention.every-10-minutes';
export const COPY_RETENTION_SCHEDULE_EXPRESSION = '*/10 * * * *';
const SEGMENT_PAGES = 8;
export type DueCopy = Awaited<ReturnType<typeof duePage.run>>[number];
type Cursor = Pick<DueCopy, 'restoreUntil' | 'route' | 'copyId'>;

/** The single Library module installs this on the existing queues/runtime. No user authority is borrowed. */
export async function registerCopyRetention({ pool, client, clock }: WorkContext): Promise<void> {
  const cutoff = DBOS.registerStep(async () => clock().toISOString(), {
    name: 'library.copyRetention.cutoff',
    ...COMMAND_STEP_RETRIES,
  });
  const discover = DBOS.registerStep(
    async (partition: number, until: string, after: Cursor | null): Promise<DueCopy[]> => {
      if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
        throw new RangeError('Invalid partition');
      const keys = await withConnection(pool, (connection) =>
        duePage.run(connection, {
          partition_no: partition,
          cutoff: until,
          after_time: after?.restoreUntil ?? null,
          after_route: after?.route ?? null,
          after_copy: after?.copyId ?? null,
        }),
      );
      if (Buffer.byteLength(JSON.stringify(keys)) > 4096)
        throw new RangeError('Copy due page exceeds work byte budget');
      return keys;
    },
    { name: 'library.copyRetention.discover', ...COMMAND_STEP_RETRIES },
  );
  const remove = DBOS.registerStep(
    async (key: DueCopy): Promise<boolean> => {
      const result = await runCommand(
        pool,
        {
          partition: partitionOf(key.route),
          deadline: workStepDeadline(),
          clock,
          authorization: {
            action: 'library:copy-retention',
            resource: { route: key.route, id: key.copyId },
            denied: () => new Error('Missing native copy owner'),
            async authorize(tx) {
              // An existing native owner is held through commit. Terminal owners may only
              // lose data here; account erasure remains free to erase both live/deleted states.
              const owner = await tx.query(
                'SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
                [key.route, key.accountId],
              );
              if (!owner.rows[0]) throw new Error('Missing native copy owner');
              return 'execute';
            },
          },
        },
        async (tx, command) => {
          const removed = await purge.run(tx, {
            route: key.route,
            account_id: key.accountId,
            copy_id: key.copyId,
            deletion_id: key.deletionId,
            revision: key.revision,
            restore_until: key.restoreUntil,
            time: authoritativeTimeValue(command.time),
          });
          if (!removed) return noEffect(false);
          // Existing ID-only envelope. Physical purge does not advance the live fact head.
          return {
            value: true,
            events: [
              { type: 'com.rezics.library.copy.deleted.v1', subject: key.accountId, data: { copyId: key.copyId } },
            ],
          };
        },
      );
      return result.value;
    },
    { name: 'library.copyRetention.purge', ...COMMAND_STEP_RETRIES },
  );
  // Durable exact-episode work remains safe when delayed across restore/redelete.
  // It is an internal locator, never a caller delete grant or an early-purge bypass.
  DBOS.registerWorkflow(
    async (key: DueCopy) => {
      if (Buffer.byteLength(JSON.stringify(key)) > 4096)
        throw new RangeError('Copy purge key exceeds work byte budget');
      return remove(key);
    },
    { name: COPY_RETENTION_EXACT_WORKFLOW },
  );
  const continueSweep = DBOS.registerStep(
    async (partition: number, until: string, after: Cursor | null, root: string) => {
      await client.enqueue(
        {
          workflowName: COPY_RETENTION_WORKFLOW,
          queueName: 'maintenance',
          workflowID: `${root}:${partition}:${after?.copyId ?? 'start'}`,
          workflowIDReusePolicy: 'return-existing',
        },
        partition,
        until,
        after,
        root,
      );
    },
    { name: 'library.copyRetention.continue', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (start: number = 0, until?: string, checkpoint: Cursor | null = null, root: string = DBOS.workflowID!) => {
      const originalCutoff = until ?? (await cutoff());
      let partition = start;
      let after = checkpoint;
      for (let page = 0; page < SEGMENT_PAGES && partition < PARTITIONS; page++) {
        const keys = await discover(partition, originalCutoff, after);
        for (const key of keys) await remove(key);
        if (keys.length === 8) {
          const last = keys.at(-1)!;
          after = { restoreUntil: last.restoreUntil, route: last.route, copyId: last.copyId };
        } else {
          partition++;
          after = null;
        }
      }
      if (partition < PARTITIONS) await continueSweep(partition, originalCutoff, after, root);
    },
    { name: COPY_RETENTION_WORKFLOW },
  );
  // DBOS schedules supply their scheduled/actual times as arguments. Keep that SDK
  // boundary separate from our private continuation arguments.
  const scheduledName = 'library.copyRetention.scheduled';
  DBOS.registerWorkflow(
    async () => {
      await continueSweep(0, await cutoff(), null, DBOS.workflowID!);
    },
    { name: scheduledName },
  );
  await client.applySchedules([
    {
      scheduleName: COPY_RETENTION_SCHEDULE,
      workflowName: scheduledName,
      schedule: COPY_RETENTION_SCHEDULE_EXPRESSION,
      queueName: 'maintenance',
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);
}
