import { DBOS } from '@dbos-inc/dbos-sdk';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { PARTITIONS } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { workStepDeadline } from './command-support.ts';
import { MemberPurgeNotDueError, pageDueMemberDeletions, purgeExpiredMemberDeletion, type DueMemberDeletionKey } from './member-retention.ts';

export const MEMBER_RETENTION_SWEEP_WORKFLOW = 'library.memberRetentionSweep';
export const MEMBER_RETENTION_SCHEDULE = 'library.memberRetention.every-10-minutes';
const SEGMENT_WORKFLOW = 'library.memberRetentionSegment';
type Cursor = { partition: number; after?: DueMemberDeletionKey };
type Segment = { root: string; sequence: number; cutoff: string; cursor: Cursor };
type Page = { cursor: Cursor; examined: number; purged: number; pending: number; probes: number };

export async function registerLibraryMemberRetentionWork({ pool, client, clock }: WorkContext): Promise<void> {
  const captureCutoff = DBOS.registerStep(async () => clock().toISOString(), { name: 'library.memberRetentionCutoff' });
  const page = DBOS.registerStep(async (cutoff: string, start: Cursor): Promise<Page> => {
    const deadline = workStepDeadline();
    const result: Page = { cursor: { ...start }, examined: 0, purged: 0, pending: 0, probes: 0 };
    let loaded: number | undefined;
    let seeks = 0;
    while (result.cursor.partition < PARTITIONS && seeks < 100 && Date.now() < deadline - 100) {
      const partition = result.cursor.partition;
      const found = await withConnection(pool, async (connection) => {
        await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          if (loaded !== partition) {
            const metadata = await readPartition(connection, partition);
            result.probes++;
            if (!metadata || metadata.writeState !== 'active') {
              await connection.query('COMMIT');
              return { pending: true as const };
            }
            loaded = partition;
          }
          seeks++;
          const keys = await pageDueMemberDeletions(connection, {
            partition, cutoff, ...(result.cursor.after ? { after: result.cursor.after } : {}), limit: 1,
          });
          await connection.query('COMMIT');
          return { key: keys[0] };
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        }
      });
      if (found.pending || !found.key) {
        if (found.pending) result.pending++;
        result.cursor = { partition: partition + 1 };
        loaded = undefined;
        continue;
      }
      result.examined++;
      try {
        const outcome = await purgeExpiredMemberDeletion({ pool, clock, deadline }, found.key);
        if (outcome.value.purged) result.purged++;
      } catch (error) {
        if (!(error instanceof MemberPurgeNotDueError)) throw error;
        result.pending++;
      }
      result.cursor = { partition, after: found.key };
    }
    return result;
  }, { name: 'library.memberRetentionPage', ...COMMAND_STEP_RETRIES });
  const continuation = DBOS.registerStep(async (next: Segment) => {
    await client.enqueue({ workflowName: SEGMENT_WORKFLOW, queueName: 'maintenance',
      workflowID: `library.memberRetention:${next.root}:${next.sequence}`, workflowIDReusePolicy: 'return-existing' }, next);
  }, { name: 'library.memberRetentionContinue', ...COMMAND_STEP_RETRIES });
  const segment = async (input: Segment) => {
    let cursor = input.cursor;
    for (let n = 0; n < 100 && cursor.partition < PARTITIONS; n++) cursor = (await page(input.cutoff, cursor)).cursor;
    if (cursor.partition < PARTITIONS) await continuation({ ...input, sequence: input.sequence + 1, cursor });
  };
  DBOS.registerWorkflow(segment, { name: SEGMENT_WORKFLOW });
  DBOS.registerWorkflow(async () => {
    const cutoff = await captureCutoff();
    await segment({ root: DBOS.workflowID!, sequence: 0, cutoff, cursor: { partition: 0 } });
  }, { name: MEMBER_RETENTION_SWEEP_WORKFLOW });
  await client.applySchedules([{
    scheduleName: MEMBER_RETENTION_SCHEDULE, workflowName: MEMBER_RETENTION_SWEEP_WORKFLOW,
    schedule: '*/10 * * * *', cronTimezone: 'UTC', automaticBackfill: false, queueName: 'maintenance',
  }]);
}
