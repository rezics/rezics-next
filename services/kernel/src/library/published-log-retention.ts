import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  noEffect,
  normalizeCommandKey,
  runCommand,
  type CommandAuthorization,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { PARTITIONS, partitionOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { requireRoute, workStepDeadline } from './command-support.ts';
import { lockPublishedLog } from './published-log-store.ts';
import due from './published-log-due.sql';
import purge from './published-log-purge.sql';

export const PUBLISHED_LOG_RETENTION_SWEEP_WORKFLOW = 'library.publishedLogRetentionSweep';
export const PUBLISHED_LOG_RETENTION_SCHEDULE = 'library.publishedLogRetention.every-10-minutes';
export type PublishedLogDueKey = {
  route: number;
  logId: string;
  accountId: string;
  deletionId: string;
  revision: number;
  restoreUntil: string;
};
export class PublishedLogNotDueError extends Error {
  constructor() {
    super('The original published log deletion deadline has not elapsed');
  }
}
/** An internal exact episode, never ordinary delete authority. The source checkout is already released. */
export async function purgeExpiredPublishedLog(
  { pool, clock, deadline = workStepDeadline() }: { pool: Pool; clock?: KernelClock; deadline?: number },
  key: PublishedLogDueKey,
) {
  if (
    requireRoute(key.logId) !== key.route ||
    requireRoute(key.accountId) !== key.route ||
    !Number.isInteger(key.revision) ||
    key.revision < 2 ||
    !Number.isFinite(Date.parse(key.restoreUntil))
  )
    throw new TypeError('Invalid published log deletion locator');
  let matches = false;
  const authorization: CommandAuthorization = {
    action: 'library:published-log-retention-maintenance',
    resource: { route: key.route, id: key.logId },
    denied: () => new PublishedLogNotDueError(),
    async authorize(tx, attempt) {
      const time = authoritativeTimeValue(attempt.time);
      if (Date.parse(time) < Date.parse(key.restoreUntil)) throw new PublishedLogNotDueError();
      const row = await lockPublishedLog(tx, key.route, key.accountId, key.logId, time);
      matches =
        !!row &&
        row.deleted &&
        row.deletionId === key.deletionId &&
        row.revision === key.revision &&
        Date.parse(row.restoreUntil!) === Date.parse(key.restoreUntil) &&
        row.expired === true;
      return 'execute';
    },
  };
  const kind = 'library.published-log.retention.purge';
  return runCommand(
    pool,
    {
      partition: partitionOf(key.route),
      deadline,
      clock,
      authorization,
      receipt: {
        actorAccountId: key.accountId,
        kind,
        key: normalizeCommandKey({ kind: 'account', id: key.accountId }, key.deletionId),
        digest: createHash('sha256')
          .update(JSON.stringify([kind, key]))
          .digest(),
      },
    },
    async (tx, command) => {
      if (!matches) return noEffect({ purged: false });
      const result = await purge.run(tx, {
        route: key.route,
        log_id: key.logId,
        deletion_id: key.deletionId,
        revision: key.revision,
        restore_until: key.restoreUntil,
        time: authoritativeTimeValue(command.time),
      });
      if (!result?.purged) throw new Error('Locked published log deletion failed its exact native CAS');
      return {
        value: { purged: true },
        events: [
          { type: 'com.rezics.library.published_log.purged.v1', subject: key.accountId, data: { logId: key.logId } },
        ],
      };
    },
  );
}

async function pageDuePublishedLogs(
  connection: Parameters<typeof due.run>[0],
  input: {
    partition: number;
    cutoff: string;
    after?: PublishedLogDueKey;
    limit: number;
  },
): Promise<PublishedLogDueKey[]> {
  const rows = await due.run(connection, {
    partition_no: input.partition,
    cutoff: input.cutoff,
    after_time: input.after?.restoreUntil ?? null,
    after_route: input.after?.route ?? null,
    after_id: input.after?.logId ?? null,
    limit: input.limit,
  });
  return rows.map((row) => {
    if (!row.accountId || !row.deletionId || !row.restoreUntil)
      throw new Error('Due log has no exact deletion locator');
    return { ...row, accountId: row.accountId, deletionId: row.deletionId, restoreUntil: row.restoreUntil };
  });
}
const SEGMENT_WORKFLOW = 'library.publishedLogRetentionSegment';
const PAGE_BOUND = 100;
const SEGMENT_BOUND = 100;
type Cursor = { partition: number; after?: PublishedLogDueKey };
type Segment = { root: string; sequence: number; cutoff: string; cursor: Cursor };
type Page = { cursor: Cursor; examined: number; purged: number; pending: number; probes: number };

/** The default worker owns discovery; no event delivery or user request is required. */
export async function registerLibraryPublishedLogRetentionWork({ pool, client, clock }: WorkContext): Promise<void> {
  const captureCutoff = DBOS.registerStep(async () => clock().toISOString(), {
    name: 'library.publishedLogRetentionCutoff',
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
          await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
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
            const keys = await pageDuePublishedLogs(connection, {
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
          const outcome = await purgeExpiredPublishedLog({ pool, clock, deadline }, read.key);
          if (outcome.value.purged) result.purged++;
        } catch (error) {
          // A backwards domain clock leaves this key for a later fresh sweep, without a receipt or busy loop.
          if (!(error instanceof PublishedLogNotDueError)) throw error;
          result.pending++;
        }
        result.cursor = { partition, after: read.key };
      }
      // No published log payload or full command outcome crosses the durable step boundary.
      return result;
    },
    { name: 'library.publishedLogRetentionPage', ...COMMAND_STEP_RETRIES },
  );
  const continueSweep = DBOS.registerStep(
    async (next: Segment) => {
      await client.enqueue(
        {
          workflowName: SEGMENT_WORKFLOW,
          queueName: 'maintenance',
          workflowID: `library.publishedLogRetention:${next.root}:${next.sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        next,
      );
    },
    { name: 'library.publishedLogRetentionContinue', ...COMMAND_STEP_RETRIES },
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
    { name: PUBLISHED_LOG_RETENTION_SWEEP_WORKFLOW },
  );
  await client.applySchedules([
    {
      scheduleName: PUBLISHED_LOG_RETENTION_SCHEDULE,
      workflowName: PUBLISHED_LOG_RETENTION_SWEEP_WORKFLOW,
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}
