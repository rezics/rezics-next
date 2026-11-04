import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { createLibraryCommandRunner } from './command-support.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { libraryCommandReceiptDigest, requireRoute } from './command-support.ts';
import {
  entryPersonalAnnotationRequestInput,
  entryPersonalSourceObservationRequestInput,
} from './entry-personal.ts';
import type { EntryImportMetadataConfirmation, EntryImportMetadataReview } from './list-import-entry-metadata.ts';

export const BANGUMI_RETENTION_SWEEP_WORKFLOW = 'library.bangumiRetentionSweep';
export const BANGUMI_RETENTION_SCHEDULE = 'library.bangumiRetention.every-10-minutes';
const PAGE_ROWS = 99;
const SEGMENT_UPLOADS = 100;

export type BangumiExpiryCursor = {
  expiresAt: string;
  dueAt?: string;
  stage?: 'source' | 'recovery';
  route: number;
  accountId: string;
  uploadId: string;
};
export type BangumiExpiryPage = BangumiExpiryCursor & { page: number };

export async function nextExpiredBangumiUpload(pool: Pool, after: BangumiExpiryCursor | null) {
  const query = `WITH due AS (
       SELECT expires_at AS due_at,expires_at,recovery_until,'source'::text AS stage,route,account_id,upload_id
       FROM library.bangumi_upload WHERE recovery_until IS NULL AND expires_at<=clock_timestamp()
       UNION ALL
       SELECT recovery_until AS due_at,expires_at,recovery_until,'recovery'::text AS stage,route,account_id,upload_id
       FROM library.bangumi_upload WHERE recovery_until IS NOT NULL AND recovery_until<=clock_timestamp()
     )
     SELECT route,account_id::text AS "accountId",upload_id::text AS "uploadId",
       expires_at::text AS "expiresAt",due_at::text AS "dueAt",stage,
       recovery_until::text AS "recoveryUntil"
     FROM due
     ${after ? `WHERE (due_at,route,account_id,upload_id)>($1::timestamptz,$2,$3::uuid,$4::uuid)` : ''}
     ORDER BY due_at,route,account_id,upload_id LIMIT 1`;
  const result = after
    ? await pool.query<BangumiExpiryCursor & { recoveryUntil: string | null }>(query, [
        after.dueAt ?? after.expiresAt, after.route, after.accountId, after.uploadId,
      ])
    : await pool.query<BangumiExpiryCursor & { recoveryUntil: string | null }>(query);
  return result.rows[0] ?? null;
}

type MetadataReview = Omit<EntryImportMetadataReview, 'confirmation'> & {
  confirmation?: EntryImportMetadataConfirmation;
};

function minimizeReview(review: Record<string, unknown> | null, accountId: string): Record<string, unknown> | null {
  if (!review || typeof review.token !== 'string' || !Array.isArray(review.metadata)) return null;
  const token = review.token;
  const metadata = (review.metadata as MetadataReview[]).map((item) => {
    const confirmation = item.confirmation;
    if (!confirmation)
      return {
        token: item.token,
        sourceReviewToken: item.sourceReviewToken,
        subjectId: item.subjectId,
        clientId: item.clientId,
        requestedBy: item.requestedBy,
      };
    const identity = {
      principal: { kind: 'account' as const, id: accountId },
      basis: { clientId: item.clientId, requestedBy: item.requestedBy },
    };
    const admissionInput = confirmation.nativeAdmission === 'bangumi-source-v1'
      ? {
          source: 'bangumi-metadata-v1',
          uploadId: (review as { uploadId?: string }).uploadId,
          ordinal: (review as { ordinal?: number }).ordinal,
          sourceReviewToken: item.sourceReviewToken,
          reviewToken: item.token,
          subjectId: item.subjectId,
          sourceDigest: item.sourceDigest,
          profileDigest: item.profileDigest,
          incarnationId: item.incarnationId,
          selectionDigest: confirmation.selectionDigest,
        }
      : undefined;
    let annotationReceiptDigest = confirmation.annotationReceiptDigest;
    if (confirmation.annotationStarted && !annotationReceiptDigest && confirmation.annotationInput) {
      annotationReceiptDigest = libraryCommandReceiptDigest(
        identity,
        'library.entry.annotations.put',
        entryPersonalAnnotationRequestInput(item.subjectId, {
          revision: confirmation.annotationInput.revision,
          note: confirmation.annotationInput.note,
          priority: confirmation.annotationInput.priority,
        }, admissionInput),
      );
    }
    let provenanceReceiptDigest = confirmation.provenanceReceiptDigest;
    if (confirmation.provenanceStarted && !provenanceReceiptDigest && confirmation.provenanceInput) {
      const kind = confirmation.provenanceInput.kind;
      provenanceReceiptDigest = libraryCommandReceiptDigest(
        identity,
        kind === 'admit'
          ? 'library.entry.source-observation.admit'
          : 'library.entry.source-observation.correct',
        entryPersonalSourceObservationRequestInput(kind, item.subjectId, confirmation.provenanceInput.value, admissionInput),
      );
    }
    const outcomes = confirmation.outcome?.fields.map(({ field, status }) => ({ field, status }));
    const minimizedConfirmation = {
      fields: confirmation.fields,
      selectionDigest: confirmation.selectionDigest,
      annotationKey: confirmation.annotationKey,
      provenanceKey: confirmation.provenanceKey,
      annotationStarted: confirmation.annotationStarted,
      provenanceStarted: confirmation.provenanceStarted,
      sourceExpired: true,
      ...(confirmation.annotationStatus === undefined ? {} : { annotationStatus: confirmation.annotationStatus }),
      ...(confirmation.provenanceStatus === undefined ? {} : { provenanceStatus: confirmation.provenanceStatus }),
      ...(confirmation.fieldOutcomes === undefined
        ? {}
        : { fieldOutcomes: confirmation.fieldOutcomes.map(({ field, status }) => ({ field, status })) }),
      ...(annotationReceiptDigest === undefined ? {} : { annotationReceiptDigest }),
      ...(provenanceReceiptDigest === undefined ? {} : { provenanceReceiptDigest }),
      ...(confirmation.provenanceInput === undefined ? {} : { provenanceKind: confirmation.provenanceInput.kind }),
      ...(outcomes === undefined ? {} : { outcome: { reviewToken: confirmation.outcome!.reviewToken, fields: outcomes } }),
    };
    return {
      token: item.token,
      sourceReviewToken: item.sourceReviewToken,
      subjectId: item.subjectId,
      clientId: item.clientId,
      requestedBy: item.requestedBy,
      confirmation: minimizedConfirmation,
    };
  });
  return { token, metadata };
}

/** Scrubs source material at seven days and deletes its bounded receipt linkage one day later. */
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
  const stage = input.stage ?? 'source';
  const dueAt = input.dueAt ?? input.expiresAt;
  if (stage !== 'source' && stage !== 'recovery') throw new TypeError('Invalid Bangumi expiry stage');
  try {
    return (
      await runner.trustedAccount(
        input.accountId,
        {
          kind: 'library.bangumi.retention.purge',
          stepKey: `expiry:${input.uploadId}:${stage}:${input.page}`,
          input: { uploadId: input.uploadId, expiresAt: input.expiresAt, dueAt, stage, page: input.page },
        },
        async (tx) => {
          const root = await tx.query<{ expires_at: string; recovery_until: string | null }>(
            `SELECT expires_at::text,recovery_until::text AS recovery_until FROM library.bangumi_upload
             WHERE route=$1 AND account_id=$2 AND upload_id=$3
               AND expires_at=$4::timestamptz
               AND ${stage === 'source' ? 'recovery_until IS NULL AND expires_at<=clock_timestamp()' : 'recovery_until=$5::timestamptz AND recovery_until<=clock_timestamp()'}
             FOR UPDATE`,
            stage === 'source'
              ? [route, input.accountId, input.uploadId, input.expiresAt]
              : [route, input.accountId, input.uploadId, input.expiresAt, dueAt],
          );
          if (!root.rows.length) return { value: { removed: 0, complete: true }, events: [] };
          if (stage === 'source') {
            const rows = await tx.query<{ ordinal: number; review: Record<string, unknown> | null }>(
              `SELECT ordinal,review FROM library.bangumi_upload_row
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 ORDER BY ordinal LIMIT ${PAGE_ROWS}`,
              [route, input.accountId, input.uploadId],
            );
            for (const row of rows.rows) {
              const minimized = minimizeReview(
                row.review ? { ...row.review, uploadId: input.uploadId, ordinal: row.ordinal } : null,
                input.accountId,
              );
              await tx.query(
                `UPDATE library.bangumi_upload_row SET evidence='{}'::jsonb,review=$5::jsonb,
                   choice=NULL,outcome=NULL,labels=NULL
                 WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
                [route, input.accountId, input.uploadId, row.ordinal, minimized === null ? null : JSON.stringify(minimized)],
              );
            }
            const remaining = await tx.query(
              `SELECT 1 FROM library.bangumi_upload_row
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND evidence<>'{}'::jsonb LIMIT 1`,
              [route, input.accountId, input.uploadId],
            );
            const complete = !remaining.rowCount;
            if (complete)
              await tx.query(
                `UPDATE library.bangumi_upload SET recovery_until=expires_at+interval '24 hours'
                 WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND recovery_until IS NULL`,
                [route, input.accountId, input.uploadId],
              );
            const removed = rows.rowCount ?? 0;
            return {
              value: { removed, complete },
              events: removed
                ? [{
                    type: 'com.rezics.library.account-graph.purged.v1',
                    subject: input.accountId,
                    data: { accountId: input.accountId, kind: 'bangumi_upload', removed },
                  }]
                : [],
            };
          }
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
               WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND expires_at=$4::timestamptz AND recovery_until=$5::timestamptz`,
              [route, input.accountId, input.uploadId, input.expiresAt, dueAt],
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
