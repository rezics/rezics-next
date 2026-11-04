import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { createLibraryCommandRunner } from './command-support.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { requireRoute } from './command-support.ts';

export const BANGUMI_RETENTION_SWEEP_WORKFLOW = 'library.bangumiRetentionSweep';
export const BANGUMI_RETENTION_SCHEDULE = 'library.bangumiRetention.every-10-minutes';
const PAGE_ROWS = 99;
const SEGMENT_UPLOADS = 100;

export type BangumiExpiryCursor = {
  expiresAt: string;
  route: number;
  accountId: string;
  uploadId: string;
};
export type BangumiExpiryPage = BangumiExpiryCursor & { page: number };

export async function nextExpiredBangumiUpload(pool: Pool, after: BangumiExpiryCursor | null) {
  const query = after
    ? `SELECT route,account_id::text AS "accountId",upload_id::text AS "uploadId",expires_at::text AS "expiresAt"
       FROM library.bangumi_upload
       WHERE expires_at<=clock_timestamp()
         AND (expires_at,route,account_id,upload_id)>($1::timestamptz,$2,$3::uuid,$4::uuid)
       ORDER BY expires_at,route,account_id,upload_id LIMIT 1`
    : `SELECT route,account_id::text AS "accountId",upload_id::text AS "uploadId",expires_at::text AS "expiresAt"
       FROM library.bangumi_upload WHERE expires_at<=clock_timestamp()
       ORDER BY expires_at,route,account_id,upload_id LIMIT 1`;
  const result = after
    ? await pool.query<BangumiExpiryCursor>(query, [after.expiresAt, after.route, after.accountId, after.uploadId])
    : await pool.query<BangumiExpiryCursor>(query);
  return result.rows[0] ?? null;
}

/** Deletes at most 100 retained keys; the account command fence serializes this with owner retirement. */
export async function purgeExpiredBangumiUploadPage(
  { pool, clock }: { pool: Pool; clock?: KernelClock },
  input: BangumiExpiryPage,
) {
  const route = requireRoute(input.accountId);
  if (
    route !== input.route ||
    route !== requireRoute(input.uploadId) ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    !Number.isSafeInteger(input.page) ||
    input.page < 0
  )
    throw new TypeError('Invalid Bangumi expiry locator');
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });
  try {
    return (
      await runner.trustedAccount(
        input.accountId,
        {
          kind: 'library.bangumi.retention.purge',
          stepKey: `expiry:${input.uploadId}:${input.page}`,
          input: { uploadId: input.uploadId, expiresAt: input.expiresAt, page: input.page },
        },
        async (tx) => {
          const root = await tx.query<{ expires_at: string }>(
            `SELECT expires_at::text FROM library.bangumi_upload
             WHERE route=$1 AND account_id=$2 AND upload_id=$3
               AND expires_at=$4::timestamptz AND expires_at<=clock_timestamp()
             FOR UPDATE`,
            [route, input.accountId, input.uploadId, input.expiresAt],
          );
          if (!root.rows.length) return { value: { removed: 0, complete: true }, events: [] };
          const rows = await tx.query(
            `WITH keys AS MATERIALIZED (
               SELECT ordinal FROM library.bangumi_upload_row
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 ORDER BY ordinal LIMIT ${PAGE_ROWS}
             )
             DELETE FROM library.bangumi_upload_row r USING keys k
             WHERE r.route=$1 AND r.account_id=$2 AND r.upload_id=$3 AND r.ordinal=k.ordinal`,
            [route, input.accountId, input.uploadId],
          );
          const remaining = await tx.query(
            'SELECT 1 FROM library.bangumi_upload_row WHERE route=$1 AND account_id=$2 AND upload_id=$3 LIMIT 1',
            [route, input.accountId, input.uploadId],
          );
          let removed = rows.rowCount ?? 0;
          let complete = !remaining.rowCount;
          if (complete && removed < 100) {
            const parent = await tx.query(
              `DELETE FROM library.bangumi_upload
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND expires_at=$4::timestamptz`,
              [route, input.accountId, input.uploadId, input.expiresAt],
            );
            removed += parent.rowCount ?? 0;
            complete = (parent.rowCount ?? 0) === 1;
          } else complete = false;
          if (!removed) return { value: { removed: 0, complete }, events: [] };
          return {
            value: { removed, complete },
            events: [
              {
                type: 'com.rezics.library.account-graph.purged.v1',
                subject: input.accountId,
                data: { accountId: input.accountId, kind: 'bangumi_upload', removed },
              },
            ],
          };
        },
      )
    ).value;
  } catch (error) {
    // Terminal erasure owns inactive accounts; continue to later due keys without weakening its fence.
    if (error instanceof GrantDeniedError) return { removed: 0, complete: true, skipped: 'owner_retired' as const };
    throw error;
  }
}

type BangumiSweep = { root: string; sequence: number; after: BangumiExpiryCursor | null };

export async function registerLibraryBangumiRetentionWork({ pool, client, clock }: WorkContext): Promise<void> {
  const due = DBOS.registerStep(async (after: BangumiExpiryCursor | null) => nextExpiredBangumiUpload(pool, after), {
    name: 'library.bangumiRetentionDue',
    ...COMMAND_STEP_RETRIES,
  });
  const page = DBOS.registerStep(
    async (input: BangumiExpiryPage) => purgeExpiredBangumiUploadPage({ pool, clock }, input),
    { name: 'library.bangumiRetentionPage', ...COMMAND_STEP_RETRIES },
  );
  const continuation = DBOS.registerStep(
    async (input: BangumiSweep) => {
      await client.enqueue(
        {
          workflowName: 'library.bangumiRetentionSegment',
          queueName: 'maintenance',
          workflowID: `library.bangumiRetention:${input.root}:${input.sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    { name: 'library.bangumiRetentionContinue', ...COMMAND_STEP_RETRIES },
  );
  const segment = async (input: BangumiSweep) => {
    let after = input.after;
    for (let n = 0; n < SEGMENT_UPLOADS; n++) {
      const upload = await due(after);
      if (!upload) return { after, complete: true };
      let pageNo = 0,
        complete = false;
      while (!complete) {
        const result = await page({ ...upload, page: pageNo++ });
        complete = result.complete;
      }
      after = upload;
    }
    await continuation({ ...input, sequence: input.sequence + 1, after });
    return { after, complete: false };
  };
  DBOS.registerWorkflow(segment, { name: 'library.bangumiRetentionSegment' });
  DBOS.registerWorkflow(async () => segment({ root: DBOS.workflowID!, sequence: 0, after: null }), {
    name: BANGUMI_RETENTION_SWEEP_WORKFLOW,
  });
  await client.applySchedules([
    {
      scheduleName: BANGUMI_RETENTION_SCHEDULE,
      workflowName: BANGUMI_RETENTION_SWEEP_WORKFLOW,
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}
