import type { QueryResultRow } from 'pg';
import type { AccessClient, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type {
  HostedPublicationStagingLocator,
  HostedPublicationStagingState,
} from './hosted-publication-staging-model.ts';
import {
  HostedPublicationStagingConflictError,
  HostedPublicationStagingNotFoundError,
} from './hosted-publication-staging-model.ts';
import deleteCandidates from './hosted-publication-staging-cleanup-candidates.sql';
import deleteInputs from './hosted-publication-staging-cleanup-inputs.sql';
import deleteTargets from './hosted-publication-staging-cleanup-targets.sql';

export const HOSTED_PUBLICATION_STAGING_CLEANUP_STEP_LIMIT = 100;

type TerminalState = Extract<HostedPublicationStagingState, 'cancelled' | 'expired' | 'failed'>;
type Phase = 'candidate' | 'input' | 'target' | 'done';
type AccountActor = Extract<Actor, { kind: 'account' }>;
type StageRow = QueryResultRow & {
  route: number;
  catalogue_id: string;
  stage_id: string;
  initiator_account_id: string;
  owner_epoch: string;
  status: HostedPublicationStagingState;
  is_expired: boolean;
  sealed_at: string | null;
};
type TargetCursor = Readonly<{
  threadId: string;
  postId: string;
  revisionId: string;
  sha256: string;
}>;
type CleanupRow = QueryResultRow & {
  owner_epoch: string;
  terminal_status: TerminalState;
  phase: Phase;
  candidate_frontier: string;
  input_frontier: string;
  target_thread_id: string | null;
  target_post_id: string | null;
  target_revision_id: string | null;
  target_sha256: string | null;
  deleted_row_count: string;
  completed: boolean;
};
type CleanupReceiptRow = CleanupRow & { deleted_rows: number };
type CandidateDeleteRow = QueryResultRow & { source_order: string };
type InputDeleteRow = QueryResultRow & { input_position: string };
type TargetDeleteRow = QueryResultRow & {
  thread_id: string;
  post_id: string;
  target_revision_id: string;
  body_sha256: string;
};

export type HostedPublicationStagingCleanupProgress = Readonly<{
  locator: HostedPublicationStagingLocator;
  terminalStatus: TerminalState;
  ownerEpoch: string;
  phase: Phase;
  candidateFrontier: string;
  inputFrontier: string;
  targetFrontier: TargetCursor | null;
  deletedRowCount: string;
  completed: boolean;
}>;

export type HostedPublicationStagingCleanupStepResult = Readonly<{
  replayed: boolean;
  deletedRows: number;
  progress: HostedPublicationStagingCleanupProgress;
}>;

const STAGE_LOCK = `
  SELECT route,catalogue_id,stage_id,initiator_account_id,owner_epoch::text,status,sealed_at,
         (expires_at<=clock_timestamp()) AS is_expired
  FROM content.hosted_publication_staging
  WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
  FOR UPDATE`;

const CLEANUP_SELECT = `
  SELECT owner_epoch::text,terminal_status,phase,candidate_frontier::text,input_frontier::text,
         target_thread_id,target_post_id,target_revision_id,encode(target_sha256,'hex') AS target_sha256,
         deleted_row_count::text,(completed_at IS NOT NULL) AS completed
  FROM content.hosted_publication_staging_cleanup
  WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`;

const RECEIPT_FIELDS = `
  receipt.phase,receipt.candidate_frontier::text,receipt.input_frontier::text,
  receipt.target_thread_id,receipt.target_post_id,receipt.target_revision_id,
  encode(receipt.target_sha256,'hex') AS target_sha256,receipt.deleted_row_count::text,
  receipt.deleted_rows,receipt.completed`;

function accountActor(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 0)
    throw new HostedPublicationStagingNotFoundError();
  return actor;
}

function requireRoute(id: string, expected?: number): number {
  const route = routeOf(id);
  if (route === null || (expected !== undefined && route !== expected))
    throw new HostedPublicationStagingConflictError(
      'Hosted publication cleanup identifiers must share their native route',
    );
  return route;
}

function validateLocator(locator: HostedPublicationStagingLocator): number {
  const route = requireRoute(locator.catalogueId);
  requireRoute(locator.stageId, route);
  return route;
}

function assertActorBinding(stage: StageRow, actorInput: Actor): AccountActor {
  const actor = accountActor(actorInput);
  if (stage.initiator_account_id !== actor.accountId || stage.owner_epoch !== String(actor.authnEpoch))
    throw new HostedPublicationStagingNotFoundError();
  return actor;
}

function isTerminal(state: HostedPublicationStagingState): state is TerminalState {
  return state === 'cancelled' || state === 'expired' || state === 'failed';
}

function targetCursor(
  row: Pick<CleanupRow, 'target_thread_id' | 'target_post_id' | 'target_revision_id' | 'target_sha256'>,
): TargetCursor | null {
  if (row.target_thread_id === null) return null;
  return {
    threadId: row.target_thread_id,
    postId: row.target_post_id!,
    revisionId: row.target_revision_id!,
    sha256: row.target_sha256!,
  };
}

function progress(locator: HostedPublicationStagingLocator, row: CleanupRow): HostedPublicationStagingCleanupProgress {
  return {
    locator: { catalogueId: locator.catalogueId, stageId: locator.stageId },
    terminalStatus: row.terminal_status,
    ownerEpoch: row.owner_epoch,
    phase: row.phase,
    candidateFrontier: row.candidate_frontier,
    inputFrontier: row.input_frontier,
    targetFrontier: targetCursor(row),
    deletedRowCount: row.deleted_row_count,
    completed: row.completed,
  };
}

function maxDecimal(values: readonly string[]): string {
  return values.reduce((max, value) => (BigInt(value) > BigInt(max) ? value : max));
}

function compareTarget(left: TargetDeleteRow, right: TargetDeleteRow): number {
  const a = [left.thread_id, left.post_id, left.target_revision_id, left.body_sha256];
  const b = [right.thread_id, right.post_id, right.target_revision_id, right.body_sha256];
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

function advancePhase(phase: Exclude<Phase, 'done'>): Phase {
  if (phase === 'candidate') return 'input';
  if (phase === 'input') return 'target';
  return 'done';
}

async function queryDelete<T extends QueryResultRow>(
  client: AccessClient,
  statement: { sql: string; params: readonly string[] },
  values: Readonly<Record<string, unknown>>,
): Promise<T[]> {
  const result = await client.query<T>(
    statement.sql,
    statement.params.map((name) => values[name]),
  );
  return result.rows;
}

async function lockStage(
  client: AccessClient,
  locator: HostedPublicationStagingLocator,
  route: number,
): Promise<StageRow> {
  const stage = (await client.query<StageRow>(STAGE_LOCK, [route, locator.catalogueId, locator.stageId])).rows[0];
  if (!stage) throw new HostedPublicationStagingNotFoundError();
  return stage;
}

async function requireTerminalStage(client: AccessClient, stage: StageRow): Promise<TerminalState> {
  const seal = await client.query(
    `SELECT 1 FROM content.hosted_publication_staging_seal
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [stage.route, stage.catalogue_id, stage.stage_id],
  );
  if (stage.status === 'sealed' || stage.sealed_at !== null || seal.rows.length)
    throw new HostedPublicationStagingConflictError('Sealed hosted publication staging is retained');

  if (stage.is_expired && !isTerminal(stage.status)) {
    const expired = await client.query(
      `UPDATE content.hosted_publication_staging
       SET status='expired'
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND owner_epoch=$4
         AND expires_at<=clock_timestamp() AND status NOT IN ('sealed','cancelled','expired','failed')
         AND sealed_at IS NULL`,
      [stage.route, stage.catalogue_id, stage.stage_id, stage.owner_epoch],
    );
    if (expired.rowCount === 1) stage.status = 'expired';
  }
  if (!isTerminal(stage.status))
    throw new HostedPublicationStagingConflictError(
      'Only cancelled, expired, or failed unsealed staging can be cleaned',
    );
  return stage.status;
}

async function ensureCleanupRow(
  client: AccessClient,
  stage: StageRow,
  terminalStatus: TerminalState,
): Promise<CleanupRow> {
  await client.query(
    `INSERT INTO content.hosted_publication_staging_cleanup
       (route,catalogue_id,stage_id,owner_epoch,terminal_status)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (route,catalogue_id,stage_id) DO NOTHING`,
    [stage.route, stage.catalogue_id, stage.stage_id, stage.owner_epoch, terminalStatus],
  );
  const row = (
    await client.query<CleanupRow>(`${CLEANUP_SELECT} FOR UPDATE`, [stage.route, stage.catalogue_id, stage.stage_id])
  ).rows[0];
  if (
    !row ||
    row.owner_epoch !== stage.owner_epoch ||
    row.terminal_status !== terminalStatus ||
    row.completed !== (row.phase === 'done')
  )
    throw new HostedPublicationStagingConflictError(
      'Hosted publication cleanup progress does not match its terminal stage',
    );
  return row;
}

async function readReceipt(
  client: AccessClient,
  route: number,
  locator: HostedPublicationStagingLocator,
  stepId: string,
): Promise<CleanupReceiptRow | null> {
  const result = await client.query<CleanupReceiptRow>(
    `SELECT cleanup.owner_epoch::text,cleanup.terminal_status,${RECEIPT_FIELDS}
     FROM content.hosted_publication_staging_cleanup_step receipt
     JOIN content.hosted_publication_staging_cleanup cleanup
       USING (route,catalogue_id,stage_id)
     WHERE receipt.route=$1 AND receipt.catalogue_id=$2 AND receipt.stage_id=$3 AND receipt.step_id=$4`,
    [route, locator.catalogueId, locator.stageId, stepId],
  );
  return result.rows[0] ?? null;
}

async function deleteCandidatePage(
  client: AccessClient,
  stage: StageRow,
  after: string,
  limit: number,
): Promise<CandidateDeleteRow[]> {
  return queryDelete<CandidateDeleteRow>(client, deleteCandidates, {
    route: stage.route,
    catalogue_id: stage.catalogue_id,
    stage_id: stage.stage_id,
    after_source_order: after,
    row_limit: limit,
  });
}

async function deleteInputPage(
  client: AccessClient,
  stage: StageRow,
  after: string,
  limit: number,
): Promise<InputDeleteRow[]> {
  return queryDelete<InputDeleteRow>(client, deleteInputs, {
    route: stage.route,
    catalogue_id: stage.catalogue_id,
    stage_id: stage.stage_id,
    after_input_position: after,
    row_limit: limit,
  });
}

async function deleteTargetPage(
  client: AccessClient,
  stage: StageRow,
  after: TargetCursor | null,
  limit: number,
): Promise<TargetDeleteRow[]> {
  return queryDelete<TargetDeleteRow>(client, deleteTargets, {
    route: stage.route,
    catalogue_id: stage.catalogue_id,
    stage_id: stage.stage_id,
    after_thread_id: after?.threadId ?? null,
    after_post_id: after?.postId ?? null,
    after_revision_id: after?.revisionId ?? null,
    after_sha256: after?.sha256 ?? null,
    row_limit: limit,
  });
}

async function recordReceipt(
  client: AccessClient,
  route: number,
  locator: HostedPublicationStagingLocator,
  stepId: string,
  row: CleanupRow,
  deletedRows: number,
): Promise<void> {
  const cursor = targetCursor(row);
  await client.query(
    `INSERT INTO content.hosted_publication_staging_cleanup_step
       (route,catalogue_id,stage_id,step_id,phase,candidate_frontier,input_frontier,
        target_thread_id,target_post_id,target_revision_id,target_sha256,
        deleted_row_count,deleted_rows,completed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid,$9::uuid,$10::uuid,$11::bytea,$12,$13,$14)
     ON CONFLICT (route,catalogue_id,stage_id,step_id) DO NOTHING`,
    [
      route,
      locator.catalogueId,
      locator.stageId,
      stepId,
      row.phase,
      row.candidate_frontier,
      row.input_frontier,
      cursor?.threadId ?? null,
      cursor?.postId ?? null,
      cursor?.revisionId ?? null,
      cursor ? Buffer.from(cursor.sha256, 'hex') : null,
      row.deleted_row_count,
      deletedRows,
      row.completed,
    ],
  );
}

/** Reclaim private rows after current native catalogue author/container admission,
 * inside the same transaction; one call deletes at most 100 rows total. */
export async function advanceHostedPublicationStagingCleanup(
  client: AccessClient,
  actorInput: Actor,
  locator: HostedPublicationStagingLocator,
  stepId: string,
): Promise<HostedPublicationStagingCleanupStepResult> {
  const route = validateLocator(locator);
  requireRoute(stepId, route);
  const stage = await lockStage(client, locator, route);
  assertActorBinding(stage, actorInput);
  const terminalStatus = await requireTerminalStage(client, stage);
  const prior = await readReceipt(client, route, locator, stepId);
  if (prior) return { replayed: true, deletedRows: prior.deleted_rows, progress: progress(locator, prior) };

  const initial = await ensureCleanupRow(client, stage, terminalStatus);
  let phase = initial.phase;
  let candidateFrontier = initial.candidate_frontier;
  let inputFrontier = initial.input_frontier;
  let targetFrontier = targetCursor(initial);
  let deletedRows = 0;
  let row = initial;

  if (phase !== 'done') {
    const authority = `${route}:${stage.catalogue_id}:${stage.stage_id}:${stage.owner_epoch}`;
    await client.query("SELECT set_config('content.hosted_publication_staging_cleanup',$1,true)", [authority]);
    const activated = await client.query(
      `UPDATE content.hosted_publication_staging_cleanup
       SET cleanup_active=true
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
         AND cleanup_active=false AND completed_at IS NULL`,
      [route, locator.catalogueId, locator.stageId],
    );
    if (activated.rowCount !== 1)
      throw new HostedPublicationStagingConflictError('Hosted publication cleanup step is already active or complete');

    while (phase !== 'done' && deletedRows < HOSTED_PUBLICATION_STAGING_CLEANUP_STEP_LIMIT) {
      const remaining = HOSTED_PUBLICATION_STAGING_CLEANUP_STEP_LIMIT - deletedRows;
      if (phase === 'candidate') {
        const rows = await deleteCandidatePage(client, stage, candidateFrontier, remaining);
        if (rows.length) {
          candidateFrontier = maxDecimal(rows.map((row) => row.source_order));
          deletedRows += rows.length;
        }
        if (rows.length < remaining) phase = advancePhase(phase);
        continue;
      }
      if (phase === 'input') {
        const rows = await deleteInputPage(client, stage, inputFrontier, remaining);
        if (rows.length) {
          inputFrontier = maxDecimal(rows.map((row) => row.input_position));
          deletedRows += rows.length;
        }
        if (rows.length < remaining) phase = advancePhase(phase);
        continue;
      }
      const rows = await deleteTargetPage(client, stage, targetFrontier, remaining);
      if (rows.length) {
        const last = rows.reduce((max, row) => (compareTarget(row, max) > 0 ? row : max));
        targetFrontier = {
          threadId: last.thread_id,
          postId: last.post_id,
          revisionId: last.target_revision_id,
          sha256: last.body_sha256,
        };
        deletedRows += rows.length;
      }
      if (rows.length < remaining) phase = advancePhase(phase);
    }
    const updated = await client.query<CleanupRow>(
      `UPDATE content.hosted_publication_staging_cleanup
       SET phase=$4,candidate_frontier=$5,input_frontier=$6,
           target_thread_id=$7::uuid,target_post_id=$8::uuid,target_revision_id=$9::uuid,
           target_sha256=$10::bytea,deleted_row_count=deleted_row_count+$11,
           cleanup_active=false,
           completed_at=CASE WHEN $4='done' THEN COALESCE(completed_at,clock_timestamp()) ELSE NULL END
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND cleanup_active=true
       RETURNING owner_epoch::text,terminal_status,phase,candidate_frontier::text,input_frontier::text,
         target_thread_id,target_post_id,target_revision_id,encode(target_sha256,'hex') AS target_sha256,
         deleted_row_count::text,(completed_at IS NOT NULL) AS completed`,
      [
        route,
        locator.catalogueId,
        locator.stageId,
        phase,
        candidateFrontier,
        inputFrontier,
        targetFrontier?.threadId ?? null,
        targetFrontier?.postId ?? null,
        targetFrontier?.revisionId ?? null,
        targetFrontier ? Buffer.from(targetFrontier.sha256, 'hex') : null,
        deletedRows,
      ],
    );
    row = updated.rows[0]!;
    if (!row) throw new HostedPublicationStagingConflictError('Hosted publication cleanup progress update was lost');
    await client.query("SELECT set_config('content.hosted_publication_staging_cleanup','',true)");
  }
  await recordReceipt(client, route, locator, stepId, row, deletedRows);
  return { replayed: false, deletedRows, progress: progress(locator, row) };
}
