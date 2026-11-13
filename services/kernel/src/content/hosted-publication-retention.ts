import type { QueryResultRow, Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';
import { derivedId } from '../route/route.ts';
import type { HostedPublicationStagingLocator } from './hosted-publication-staging-model.ts';
import { HostedPublicationStagingConflictError } from './hosted-publication-staging-model.ts';
import {
  advanceHostedPublicationStagingCleanupFromMaintenance,
  type HostedPublicationStagingCleanupStepResult,
} from './hosted-publication-staging-cleanup.ts';
import {
  advanceHostedVersionCandidateCleanupFromMaintenance,
  HostedVersionCandidateCleanupConflictError,
  HostedVersionCandidateCleanupNotFoundError,
  type HostedVersionCandidateCleanupStepResult,
} from './hosted-version-candidate-cleanup.ts';
import dueStages from './hosted-publication-retention-due.sql';

export const HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT = 100;
export const HOSTED_PUBLICATION_RETENTION_STEP_BUDGET = 1;

const STEP_NAMESPACE = '00000000-0000-8000-8000-000000000001';

type CursorRow = QueryResultRow & {
  after_expires_at: string | null;
  after_route: number | null;
  after_catalogue_id: string | null;
  after_stage_id: string | null;
  last_pass_id: string | null;
  last_pass_result: StoredRetentionResult | null;
};

type DueStageRow = QueryResultRow & {
  route: number;
  catalogue_id: string;
  stage_id: string;
  initiator_account_id: string;
  owner_epoch: string;
  source_revision_id: string;
  expected_head_revision_id: string;
  expected_publication_id: string | null;
  mode: 'whole' | 'selection';
  source_kind: string;
  status: string;
  sealed_at: string | null;
  expires_at: string;
  has_seal: boolean;
  staging_cleanup_completed: boolean;
  candidate_status: string | null;
  candidate_mode: 'whole' | 'selection' | null;
  candidate_owner_epoch: string | null;
  candidate_generation_id: string | null;
  candidate_cleanup_completed: boolean;
};

type Cursor = Readonly<{
  expiresAt: string;
  route: number;
  catalogueId: string;
  stageId: string;
}> | null;

type CleanupStep =
  | Readonly<{ kind: 'staging'; result: HostedPublicationStagingCleanupStepResult }>
  | Readonly<{ kind: 'candidate'; result: HostedVersionCandidateCleanupStepResult }>;

type StoredRetentionResult = Readonly<{
  replayed: false;
  scanned: number;
  advanced: boolean;
  locator: HostedPublicationStagingLocator | null;
  cleanup: CleanupStep | null;
}>;

export type HostedPublicationRetentionResult = Readonly<{
  replayed: boolean;
  scanned: number;
  advanced: boolean;
  locator: HostedPublicationStagingLocator | null;
  cleanup: CleanupStep | null;
}>;

const readCursor = `
  SELECT to_char(after_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS after_expires_at,
         after_route,after_catalogue_id,after_stage_id,last_pass_id,last_pass_result
  FROM content.hosted_publication_retention_cursor
  WHERE singleton=true
  FOR UPDATE`;

function cursorFrom(row: CursorRow): Cursor {
  if (row.after_expires_at === null) return null;
  return {
    expiresAt: row.after_expires_at,
    route: row.after_route!,
    catalogueId: row.after_catalogue_id!,
    stageId: row.after_stage_id!,
  };
}

function keyOf(row: DueStageRow): Cursor {
  return {
    expiresAt: row.expires_at,
    route: row.route,
    catalogueId: row.catalogue_id,
    stageId: row.stage_id,
  };
}

function isSealed(row: DueStageRow): boolean {
  return row.has_seal || row.sealed_at !== null;
}

function locatorOf(row: DueStageRow): HostedPublicationStagingLocator {
  return { catalogueId: row.catalogue_id, stageId: row.stage_id };
}

function stepIdFor(passId: string, row: DueStageRow): string {
  return derivedId(STEP_NAMESPACE, `${passId}\n${row.catalogue_id}\n${row.stage_id}\n${row.owner_epoch}`, row.route);
}

async function scanDueStages(client: AccessClient, cutoff: Date, cursor: Cursor): Promise<DueStageRow[]> {
  const values: Readonly<Record<string, unknown>> = {
    cutoff: cutoff.toISOString(),
    after_expires_at: cursor?.expiresAt ?? null,
    after_route: cursor?.route ?? null,
    after_catalogue_id: cursor?.catalogueId ?? null,
    after_stage_id: cursor?.stageId ?? null,
    row_limit: HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT,
  };
  const result = await client.query<DueStageRow>(
    dueStages.sql,
    dueStages.params.map((name) => values[name]),
  );
  return result.rows;
}

async function rememberIssue(client: AccessClient, row: DueStageRow, state: string): Promise<void> {
  await client.query(
    `INSERT INTO content.hosted_publication_retention_issue
       (route,catalogue_id,stage_id,owner_epoch,source_revision_id,candidate_generation_id,state)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (route,catalogue_id,stage_id) DO UPDATE
     SET owner_epoch=EXCLUDED.owner_epoch,source_revision_id=EXCLUDED.source_revision_id,
         candidate_generation_id=EXCLUDED.candidate_generation_id,state=EXCLUDED.state,
         observed_at=clock_timestamp()`,
    [
      row.route,
      row.catalogue_id,
      row.stage_id,
      row.owner_epoch,
      row.source_revision_id,
      row.candidate_generation_id,
      state,
    ],
  );
}

async function clearIssue(client: AccessClient, row: DueStageRow): Promise<void> {
  await client.query(
    `DELETE FROM content.hosted_publication_retention_issue
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [row.route, row.catalogue_id, row.stage_id],
  );
}

function unsupportedCandidateState(row: DueStageRow): string {
  return `Sealed hosted stage cannot be retired: status=${row.status}, sourceKind=${row.source_kind}, mode=${row.mode}, candidateStatus=${row.candidate_status ?? 'missing'}, candidateMode=${row.candidate_mode ?? 'missing'}, cleanupClaim=${row.candidate_generation_id ?? 'missing'}`;
}

function cleanupConflict(
  error: unknown,
): error is
  | HostedPublicationStagingConflictError
  | HostedVersionCandidateCleanupConflictError
  | HostedVersionCandidateCleanupNotFoundError {
  return (
    error instanceof HostedPublicationStagingConflictError ||
    error instanceof HostedVersionCandidateCleanupConflictError ||
    error instanceof HostedVersionCandidateCleanupNotFoundError
  );
}

async function persistResult(
  client: AccessClient,
  passId: string,
  cursor: Cursor,
  result: StoredRetentionResult,
): Promise<void> {
  await client.query(
    `UPDATE content.hosted_publication_retention_cursor
     SET after_expires_at=$1::timestamptz,after_route=$2,after_catalogue_id=$3::uuid,
         after_stage_id=$4::uuid,last_pass_id=$5,last_pass_result=$6::jsonb,
         updated_at=clock_timestamp()
     WHERE singleton=true`,
    [
      cursor?.expiresAt ?? null,
      cursor?.route ?? null,
      cursor?.catalogueId ?? null,
      cursor?.stageId ?? null,
      passId,
      JSON.stringify(result),
    ],
  );
}

/** Advance one bounded collection-sweep pass. Discovery and the selected exact cleanup step share a transaction. */
export async function advanceHostedPublicationRetention(
  pool: Pool,
  passId: string,
  cutoff: Date,
): Promise<HostedPublicationRetentionResult> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        'INSERT INTO content.hosted_publication_retention_cursor (singleton) VALUES (true) ON CONFLICT DO NOTHING',
      );
      const cursorRow = (await client.query<CursorRow>(readCursor)).rows[0];
      if (!cursorRow) throw new Error('Hosted publication retention cursor is missing');
      if (cursorRow.last_pass_id === passId && cursorRow.last_pass_result) {
        await client.query('COMMIT');
        return { ...cursorRow.last_pass_result, replayed: true };
      }

      let cursor = cursorFrom(cursorRow);
      let scanned = 0;
      let stored: StoredRetentionResult = {
        replayed: false,
        scanned: 0,
        advanced: false,
        locator: null,
        cleanup: null,
      };
      const rows = await scanDueStages(client, cutoff, cursor);
      if (rows.length === 0) {
        cursor = null;
      } else {
        let stepBudget = HOSTED_PUBLICATION_RETENTION_STEP_BUDGET;
        for (const row of rows) {
          cursor = keyOf(row);
          scanned++;
          const sealed = isSealed(row);
          if ((!sealed && row.staging_cleanup_completed) || (sealed && row.candidate_cleanup_completed)) {
            await clearIssue(client, row);
            continue;
          }

          if (sealed && row.candidate_generation_id === null) {
            await rememberIssue(client, row, unsupportedCandidateState(row));
            continue;
          }

          const locator = locatorOf(row);
          const stepId = stepIdFor(passId, row);
          await client.query('SAVEPOINT hosted_publication_retention_step');
          try {
            if (sealed) {
              const result = await advanceHostedVersionCandidateCleanupFromMaintenance(client, locator, stepId);
              await client.query('RELEASE SAVEPOINT hosted_publication_retention_step');
              await clearIssue(client, row);
              stored = { replayed: false, scanned, advanced: true, locator, cleanup: { kind: 'candidate', result } };
            } else {
              const result = await advanceHostedPublicationStagingCleanupFromMaintenance(client, locator, stepId);
              await client.query('RELEASE SAVEPOINT hosted_publication_retention_step');
              await clearIssue(client, row);
              stored = { replayed: false, scanned, advanced: true, locator, cleanup: { kind: 'staging', result } };
            }
            stepBudget--;
            if (stepBudget === 0) break;
          } catch (error) {
            if (!cleanupConflict(error)) throw error;
            await client.query('ROLLBACK TO SAVEPOINT hosted_publication_retention_step');
            await client.query('RELEASE SAVEPOINT hosted_publication_retention_step');
            await rememberIssue(client, row, error.message);
          }
        }
        stored = { ...stored, scanned };
      }

      await persistResult(client, passId, cursor, stored);
      await client.query('COMMIT');
      return stored;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}
