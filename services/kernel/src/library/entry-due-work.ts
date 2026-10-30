import { DBOS } from '@dbos-inc/dbos-sdk';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { PARTITIONS } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { workStepDeadline } from './command-support.ts';
import { EntryPurgeNotDueError, purgeExpiredEntryDeletion } from './entry-due-command.ts';
import { pageDueEntryDeletions, type DueEntryDeletionKey } from './entry-due-store.ts';

export const ENTRY_RETENTION_SWEEP_WORKFLOW = 'library.entryRetentionSweep';
export const ENTRY_RETENTION_SCHEDULE = 'library.entryRetention.every-10-minutes';
const SEGMENT_WORKFLOW = 'library.entryRetentionSegment';
const PAGE_BOUND = 100;
const SEGMENT_BOUND = 100;
type Cursor = { partition: number; after?: DueEntryDeletionKey };
type Segment = { root: string; sequence: number; cutoff: string; cursor: Cursor };
type Page = { cursor: Cursor; examined: number; purged: number; pending: number; probes: number };

/** The default worker owns discovery; no event delivery or user request is required. */
export async function registerLibraryEntryRetentionWork({ pool, client, clock }: WorkContext): Promise<void> {
  const captureCutoff = DBOS.registerStep(async () => clock().toISOString(), {
    name: 'library.entryRetentionCutoff',
  });
  const page = DBOS.registerStep(
    async (cutoff: string, start: Cursor): Promise<Page> => {
      const deadline = workStepDeadline();
      const result: Page = { cursor: { ...start }, examined: 0, purged: 0, pending: 0, probes: 0 };
      let loaded: number | undefined;
      let seeks = 0;
      while (result.cursor.partition < PARTITIONS && seeks < PAGE_BOUND) {
        // Leave room for checkpointing. A failed in-flight command retries this entire honest frontier.
        if (Date.now() >= deadline - 100) break;
        const partition = result.cursor.partition;
        const read = await withConnection(pool, async (connection) => {
          await connection.query('BEGIN READ ONLY');
          try {
            await connection.query(`SET LOCAL statement_timeout = '${Math.max(1, deadline - Date.now())}ms'`);
            if (loaded !== partition) {
              if (result.probes === PAGE_BOUND) {
                await connection.query('COMMIT');
                return { kind: 'bound' } as const;
              }
              result.probes++;
              const metadata = await readPartition(connection, partition);
              if (!metadata || metadata.writeState !== 'active') {
                await connection.query('COMMIT');
                return { kind: 'pending' } as const;
              }
              loaded = partition;
            }
            seeks++;
            const keys = await pageDueEntryDeletions(connection, {
              partition,
              cutoff,
              ...('after' in result.cursor ? { after: result.cursor.after } : {}),
              limit: 1,
            });
            await connection.query('COMMIT');
            return { kind: 'key', key: keys[0] } as const;
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          }
        });
        if (read.kind === 'bound') break;
        if (read.kind === 'pending' || !read.key) {
          if (read.kind === 'pending') result.pending++;
          result.cursor = { partition: partition + 1 };
          continue;
        }
        result.examined++;
        // The source checkout has been released before entering the core command fence.
        try {
          const outcome = await purgeExpiredEntryDeletion({ pool, clock, deadline }, read.key);
          if (outcome.value.purged) result.purged++;
        } catch (error) {
          // A backwards domain clock leaves this key for a later fresh sweep, without a receipt or busy loop.
          if (!(error instanceof EntryPurgeNotDueError)) throw error;
          result.pending++;
        }
        result.cursor = { partition, after: read.key };
      }
      // No archive payload or full command outcome crosses the durable step boundary.
      return result;
    },
    { name: 'library.entryRetentionPage', ...COMMAND_STEP_RETRIES },
  );
  const continueSweep = DBOS.registerStep(
    async (next: Segment) => {
      await client.enqueue(
        {
          workflowName: SEGMENT_WORKFLOW,
          queueName: 'maintenance',
          workflowID: `library.entryRetention:${next.root}:${next.sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        next,
      );
    },
    { name: 'library.entryRetentionContinue', ...COMMAND_STEP_RETRIES },
  );
  const segment = async (input: Segment) => {
    let cursor = input.cursor;
    for (let n = 0; n < SEGMENT_BOUND && cursor.partition < PARTITIONS; n++) {
      cursor = (await page(input.cutoff, cursor)).cursor;
    }
    if (cursor.partition < PARTITIONS) await continueSweep({ ...input, sequence: input.sequence + 1, cursor });
  };
  DBOS.registerWorkflow(segment, { name: SEGMENT_WORKFLOW });
  DBOS.registerWorkflow(
    async () => {
      const cutoff = await captureCutoff();
      await segment({ root: DBOS.workflowID!, sequence: 0, cutoff, cursor: { partition: 0 } });
    },
    { name: ENTRY_RETENTION_SWEEP_WORKFLOW },
  );
  await client.applySchedules([
    {
      scheduleName: ENTRY_RETENTION_SCHEDULE,
      workflowName: ENTRY_RETENTION_SWEEP_WORKFLOW,
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}
