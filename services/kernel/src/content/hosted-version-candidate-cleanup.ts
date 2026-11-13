import type { QueryResultRow } from 'pg';
import type { AccessClient, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { HostedPublicationStagingLocator } from './hosted-publication-staging-model.ts';
import deleteNodes from './hosted-version-candidate-cleanup-nodes.sql';
import deleteOccurrences from './hosted-version-candidate-cleanup-occurrences.sql';
import candidatePins from './hosted-version-candidate-cleanup-pins.sql';
import deleteSiblingRoots from './hosted-version-candidate-cleanup-sibling-roots.sql';
import deleteSnapshots from './hosted-version-candidate-cleanup-snapshots.sql';

export const HOSTED_VERSION_CANDIDATE_CLEANUP_STEP_LIMIT = 100;

type Phase = 'nodes' | 'occurrences' | 'sibling_roots' | 'snapshots' | 'generation' | 'done';
type AccountActor = Extract<Actor, { kind: 'account' }>;
type CleanupCursor =
  | Readonly<{ kind: 'nodes'; indexKind: string; nodeId: string; sequence: string }>
  | Readonly<{ kind: 'occurrences'; occurrenceId: string; sequence: string }>
  | Readonly<{ kind: 'sibling_roots'; parentIsNull: boolean; parentKey: string; sequence: string }>
  | Readonly<{ kind: 'snapshots'; sequence: string }>;

type StageRow = QueryResultRow & {
  route: number;
  catalogue_id: string;
  stage_id: string;
  initiator_account_id: string;
  owner_epoch: string;
  source_revision_id: string;
  expected_head_revision_id: string;
  expected_publication_id: string | null;
  mode: 'whole' | 'selection';
  status: string;
  is_expired: boolean;
  sealed_at: string | null;
  input_version: string;
  candidate_count: string;
  seal_input_version: string | null;
  seal_candidate_count: string | null;
  seal_sealed_at: string | null;
};

type CandidateRow = QueryResultRow & {
  route: number;
  catalogue_id: string;
  stage_id: string;
  generation_id: string;
  initiator_account_id: string;
  owner_epoch: string;
  source_revision_id: string;
  expected_head_revision_id: string;
  expected_publication_id: string | null;
  mode: 'whole' | 'selection';
  input_version: string;
  source_candidate_count: string;
  source_sealed_at: string;
  generation_sequence: string;
  placement_count: string;
  chapter_count: string;
  coverage_complete: boolean;
  status: 'building' | 'sealed' | 'retiring' | 'reclaimed';
  sealed_at: string | null;
};

type GenerationRow = QueryResultRow & {
  generation_kind: 'draft' | 'candidate';
  head_sequence: string;
  retirement_claimed: boolean;
};

type CleanupRow = QueryResultRow & {
  owner_epoch: string;
  generation_id: string;
  terminal_status: 'expired';
  phase: Phase;
  cursor: CleanupCursor | null;
  deleted_row_count: string;
  completed: boolean;
};

type CleanupReceiptRow = CleanupRow & { deleted_rows: number };
type DeletedRow = QueryResultRow & { cursor: CleanupCursor };

export type HostedVersionCandidateCleanupProgress = Readonly<{
  locator: HostedPublicationStagingLocator;
  generationId: string;
  ownerEpoch: string;
  terminalStatus: 'expired';
  phase: Phase;
  cursor: CleanupCursor | null;
  deletedRowCount: string;
  completed: boolean;
}>;

export type HostedVersionCandidateCleanupStepResult = Readonly<{
  replayed: boolean;
  deletedRows: number;
  progress: HostedVersionCandidateCleanupProgress;
}>;

export class HostedVersionCandidateCleanupConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedVersionCandidateCleanupConflictError';
  }
}

export class HostedVersionCandidateCleanupNotFoundError extends Error {
  constructor() {
    super('Hosted version candidate cleanup is unavailable');
    this.name = 'HostedVersionCandidateCleanupNotFoundError';
  }
}

const STAGE_LOCK = `
  SELECT stage.route,stage.catalogue_id,stage.stage_id,stage.initiator_account_id,
         stage.owner_epoch::text,stage.source_revision_id,stage.expected_head_revision_id,
         stage.expected_publication_id,stage.mode,stage.status,
         (stage.expires_at<=clock_timestamp()) AS is_expired,
         to_char(stage.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sealed_at,
         stage.input_version::text,stage.candidate_count::text,
         source_seal.input_version::text AS seal_input_version,
         source_seal.candidate_count::text AS seal_candidate_count,
         to_char(source_seal.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS seal_sealed_at
  FROM content.hosted_publication_staging stage
  LEFT JOIN content.hosted_publication_staging_seal source_seal
    USING (route,catalogue_id,stage_id)
  WHERE stage.route=$1 AND stage.catalogue_id=$2 AND stage.stage_id=$3
  FOR UPDATE OF stage`;

const CANDIDATE_LOCK = `
  SELECT route,catalogue_id,stage_id,generation_id,initiator_account_id,owner_epoch::text,
         source_revision_id,expected_head_revision_id,expected_publication_id,mode,input_version::text,
         source_candidate_count::text,
         to_char(source_sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_sealed_at,
         generation_sequence::text,placement_count::text,chapter_count::text,coverage_complete,status,
         to_char(sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sealed_at
  FROM content.hosted_version_release_candidate
  WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
  FOR UPDATE`;

const CLEANUP_SELECT = `
  SELECT owner_epoch::text,generation_id,terminal_status,phase,cursor,deleted_row_count::text,
         (completed_at IS NOT NULL) AS completed
  FROM content.hosted_version_candidate_cleanup
  WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`;

const RECEIPT_FIELDS = `
  cleanup.owner_epoch::text,cleanup.generation_id,cleanup.terminal_status,
  receipt.phase,receipt.cursor,receipt.deleted_row_count::text,receipt.deleted_rows,receipt.completed`;

const PAGE_STATEMENTS = {
  nodes: deleteNodes,
  occurrences: deleteOccurrences,
  sibling_roots: deleteSiblingRoots,
  snapshots: deleteSnapshots,
} as const;

function accountActor(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 0)
    throw new HostedVersionCandidateCleanupNotFoundError();
  return actor;
}

function validateLocator(locator: HostedPublicationStagingLocator): number {
  const route = routeOf(locator.catalogueId);
  if (route === null || routeOf(locator.stageId) !== route)
    throw new HostedVersionCandidateCleanupConflictError(
      'Hosted candidate cleanup identifiers must share their native route',
    );
  return route;
}

function validateStepId(stepId: string, route: number): void {
  if (routeOf(stepId) !== route)
    throw new HostedVersionCandidateCleanupConflictError('Hosted candidate cleanup step uses another route');
}

function assertActorBinding(stage: StageRow, actorInput: Actor): AccountActor {
  const actor = accountActor(actorInput);
  if (stage.initiator_account_id !== actor.accountId || stage.owner_epoch !== String(actor.authnEpoch))
    throw new HostedVersionCandidateCleanupNotFoundError();
  return actor;
}

const maintenanceAuthority = Symbol('hosted-version-candidate-maintenance');
type CleanupOwner =
  | Readonly<{ kind: 'account'; actor: Actor }>
  | Readonly<{ kind: 'maintenance'; authority: typeof maintenanceAuthority }>;

function targetProgress(
  locator: HostedPublicationStagingLocator,
  row: CleanupRow,
): HostedVersionCandidateCleanupProgress {
  return {
    locator: { catalogueId: locator.catalogueId, stageId: locator.stageId },
    generationId: row.generation_id,
    ownerEpoch: row.owner_epoch,
    terminalStatus: row.terminal_status,
    phase: row.phase,
    cursor: row.cursor,
    deletedRowCount: row.deleted_row_count,
    completed: row.completed,
  };
}

async function lockStage(
  client: AccessClient,
  locator: HostedPublicationStagingLocator,
  route: number,
): Promise<StageRow> {
  const stage = (await client.query<StageRow>(STAGE_LOCK, [route, locator.catalogueId, locator.stageId])).rows[0];
  if (!stage) throw new HostedVersionCandidateCleanupNotFoundError();
  return stage;
}

async function requireExpiredStage(client: AccessClient, stage: StageRow): Promise<void> {
  if (stage.status === 'sealed' && stage.is_expired) {
    await client.query(
      `UPDATE content.hosted_publication_staging
       SET status='expired'
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND status='sealed'
         AND expires_at<=clock_timestamp()`,
      [stage.route, stage.catalogue_id, stage.stage_id],
    );
    stage.status = 'expired';
  }
  if (stage.status !== 'expired' || stage.sealed_at === null || stage.seal_sealed_at === null)
    throw new HostedVersionCandidateCleanupConflictError('Only an expired sealed source can retire a candidate');
}

function assertExactWholeCandidate(stage: StageRow, candidate: CandidateRow): void {
  if (candidate.initiator_account_id !== stage.initiator_account_id || candidate.owner_epoch !== stage.owner_epoch) {
    throw new HostedVersionCandidateCleanupNotFoundError();
  }
  if (
    stage.mode !== 'whole' ||
    candidate.mode !== 'whole' ||
    (candidate.status !== 'building' && candidate.status !== 'sealed') ||
    (candidate.status === 'sealed' && (candidate.sealed_at === null || !candidate.coverage_complete)) ||
    (candidate.status === 'building' && candidate.sealed_at !== null) ||
    candidate.source_revision_id !== stage.source_revision_id ||
    candidate.expected_head_revision_id !== stage.expected_head_revision_id ||
    candidate.expected_publication_id !== stage.expected_publication_id ||
    candidate.input_version !== stage.seal_input_version ||
    candidate.source_candidate_count !== stage.seal_candidate_count ||
    candidate.source_sealed_at !== stage.seal_sealed_at ||
    stage.source_revision_id !== stage.expected_head_revision_id ||
    stage.input_version !== stage.seal_input_version ||
    stage.candidate_count !== stage.seal_candidate_count ||
    stage.sealed_at !== stage.seal_sealed_at ||
    BigInt(candidate.placement_count) > BigInt(candidate.source_candidate_count) ||
    (candidate.coverage_complete && candidate.placement_count !== candidate.source_candidate_count)
  ) {
    throw new HostedVersionCandidateCleanupConflictError(
      'The expired source does not bind one complete whole-Book candidate',
    );
  }
}

async function assertNoGenerationPins(
  client: AccessClient,
  route: number,
  locator: HostedPublicationStagingLocator,
  generationId: string,
): Promise<void> {
  const values: Readonly<Record<string, unknown>> = {
    route,
    catalogue_id: locator.catalogueId,
    stage_id: locator.stageId,
    generation_id: generationId,
  };
  const result = await client.query<{ pin_kind: string }>(
    candidatePins.sql,
    candidatePins.params.map((name) => values[name]),
  );
  if (result.rows.length)
    throw new HostedVersionCandidateCleanupConflictError(
      `The candidate generation is retained by ${result.rows[0]!.pin_kind}`,
    );
}

async function readCleanup(
  client: AccessClient,
  route: number,
  locator: HostedPublicationStagingLocator,
  lock: boolean,
): Promise<CleanupRow | null> {
  const result = await client.query<CleanupRow>(`${CLEANUP_SELECT}${lock ? ' FOR UPDATE' : ''}`, [
    route,
    locator.catalogueId,
    locator.stageId,
  ]);
  return result.rows[0] ?? null;
}

async function ensureCleanupClaim(
  client: AccessClient,
  stage: StageRow,
  locator: HostedPublicationStagingLocator,
): Promise<CleanupRow> {
  const existing = await readCleanup(client, stage.route, locator, true);
  if (existing) {
    if (existing.owner_epoch !== stage.owner_epoch || existing.terminal_status !== 'expired')
      throw new HostedVersionCandidateCleanupConflictError('The retained cleanup claim does not match its source');
    if (!existing.completed) {
      const checkpoint = (
        await client.query<{ status: string; generation_id: string | null; owner_epoch: string }>(
          `SELECT status,generation_id,owner_epoch::text
           FROM content.hosted_version_release_candidate
           WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
           FOR UPDATE`,
          [stage.route, stage.catalogue_id, stage.stage_id],
        )
      ).rows[0];
      if (
        !checkpoint ||
        checkpoint.status !== 'retiring' ||
        checkpoint.generation_id !== null ||
        checkpoint.owner_epoch !== existing.owner_epoch
      )
        throw new HostedVersionCandidateCleanupConflictError('The claimed candidate checkpoint changed');
      const generation = (
        await client.query<GenerationRow>(
          `SELECT generation_kind,head_sequence::text,retirement_claimed
           FROM content.hosted_tree_generation
           WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3
           FOR UPDATE`,
          [stage.route, stage.catalogue_id, existing.generation_id],
        )
      ).rows[0];
      if (!generation || !generation.retirement_claimed || generation.generation_kind !== 'candidate')
        throw new HostedVersionCandidateCleanupConflictError('The claimed candidate generation was lost');
    }
    return existing;
  }

  const candidate = (
    await client.query<CandidateRow>(CANDIDATE_LOCK, [stage.route, stage.catalogue_id, stage.stage_id])
  ).rows[0];
  if (!candidate) throw new HostedVersionCandidateCleanupNotFoundError();
  assertExactWholeCandidate(stage, candidate);

  const generation = (
    await client.query<GenerationRow>(
      `SELECT generation_kind,head_sequence::text,retirement_claimed
       FROM content.hosted_tree_generation
       WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3
       FOR UPDATE`,
      [stage.route, stage.catalogue_id, candidate.generation_id],
    )
  ).rows[0];
  if (
    !generation ||
    generation.generation_kind !== 'candidate' ||
    generation.retirement_claimed ||
    generation.head_sequence !== candidate.generation_sequence
  ) {
    throw new HostedVersionCandidateCleanupConflictError('The candidate generation head no longer matches its seal');
  }
  const snapshot = await client.query(
    `SELECT 1 FROM content.hosted_tree_snapshot_version
     WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3 AND sequence=$4
       AND placement_count=$5 AND chapter_count=$6`,
    [
      stage.route,
      stage.catalogue_id,
      candidate.generation_id,
      candidate.generation_sequence,
      candidate.placement_count,
      candidate.chapter_count,
    ],
  );
  if (snapshot.rows.length !== 1)
    throw new HostedVersionCandidateCleanupConflictError('The sealed candidate snapshot is missing');

  await assertNoGenerationPins(client, stage.route, locator, candidate.generation_id);
  await client.query(
    `INSERT INTO content.hosted_version_candidate_cleanup
       (route,catalogue_id,stage_id,generation_id,owner_epoch,terminal_status)
     VALUES ($1,$2,$3,$4,$5,'expired')`,
    [stage.route, stage.catalogue_id, stage.stage_id, candidate.generation_id, stage.owner_epoch],
  );
  const retiredCheckpoint = await client.query(
    `UPDATE content.hosted_version_release_candidate
     SET generation_id=NULL,status='retiring',updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND generation_id=$4
       AND owner_epoch=$5 AND status IN ('building','sealed') AND mode='whole'`,
    [stage.route, stage.catalogue_id, stage.stage_id, candidate.generation_id, stage.owner_epoch],
  );
  if (retiredCheckpoint.rowCount !== 1)
    throw new HostedVersionCandidateCleanupConflictError('The sealed candidate checkpoint changed during claim');
  const claimed = await client.query(
    `UPDATE content.hosted_tree_generation
     SET retirement_claimed=true
     WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3
       AND generation_kind='candidate' AND retirement_claimed=false
     RETURNING generation_id`,
    [stage.route, stage.catalogue_id, candidate.generation_id],
  );
  if (claimed.rowCount !== 1)
    throw new HostedVersionCandidateCleanupConflictError('The candidate generation claim was lost');
  const row = await readCleanup(client, stage.route, locator, true);
  if (!row) throw new HostedVersionCandidateCleanupConflictError('The candidate cleanup claim was not retained');
  return row;
}

async function readReceipt(
  client: AccessClient,
  route: number,
  locator: HostedPublicationStagingLocator,
  stepId: string,
): Promise<CleanupReceiptRow | null> {
  const result = await client.query<CleanupReceiptRow>(
    `SELECT ${RECEIPT_FIELDS}
     FROM content.hosted_version_candidate_cleanup_step receipt
     JOIN content.hosted_version_candidate_cleanup cleanup USING (route,catalogue_id,stage_id)
     WHERE receipt.route=$1 AND receipt.catalogue_id=$2 AND receipt.stage_id=$3 AND receipt.step_id=$4`,
    [route, locator.catalogueId, locator.stageId, stepId],
  );
  return result.rows[0] ?? null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBigInt(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCursor(left: CleanupCursor, right: CleanupCursor): number {
  if (left.kind !== right.kind) throw new Error('Hosted candidate cleanup returned mixed cursor kinds');
  if (left.kind === 'nodes' && right.kind === 'nodes') {
    return (
      compareText(left.indexKind, right.indexKind) ||
      compareText(left.nodeId, right.nodeId) ||
      compareBigInt(left.sequence, right.sequence)
    );
  }
  if (left.kind === 'occurrences' && right.kind === 'occurrences') {
    return compareText(left.occurrenceId, right.occurrenceId) || compareBigInt(left.sequence, right.sequence);
  }
  if (left.kind === 'sibling_roots' && right.kind === 'sibling_roots') {
    return (
      Number(left.parentIsNull) - Number(right.parentIsNull) ||
      compareText(left.parentKey, right.parentKey) ||
      compareBigInt(left.sequence, right.sequence)
    );
  }
  if (left.kind === 'snapshots' && right.kind === 'snapshots') return compareBigInt(left.sequence, right.sequence);
  throw new Error('Hosted candidate cleanup returned a cursor for another phase');
}

function greatestCursor(rows: readonly DeletedRow[]): CleanupCursor {
  const first = rows[0];
  if (!first) throw new Error('Hosted candidate cleanup page has no final cursor');
  return rows.reduce((latest, row) => (compareCursor(row.cursor, latest) > 0 ? row.cursor : latest), first.cursor);
}

function nextPhase(phase: Exclude<Phase, 'generation' | 'done'>): Phase {
  if (phase === 'nodes') return 'occurrences';
  if (phase === 'occurrences') return 'sibling_roots';
  if (phase === 'sibling_roots') return 'snapshots';
  return 'generation';
}

async function deletePage(
  client: AccessClient,
  phase: Exclude<Phase, 'generation' | 'done'>,
  route: number,
  catalogueId: string,
  generationId: string,
  after: CleanupCursor | null,
  limit: number,
): Promise<DeletedRow[]> {
  const statement = PAGE_STATEMENTS[phase];
  const values: Readonly<Record<string, unknown>> = {
    route,
    catalogue_id: catalogueId,
    generation_id: generationId,
    after_cursor: after === null ? null : JSON.stringify(after),
    row_limit: limit,
  };
  const result = await client.query<DeletedRow>(
    statement.sql,
    statement.params.map((name) => values[name]),
  );
  return result.rows;
}

async function deleteGeneration(
  client: AccessClient,
  route: number,
  locator: HostedPublicationStagingLocator,
  row: CleanupRow,
): Promise<number> {
  const candidate = await client.query(
    `UPDATE content.hosted_version_release_candidate
     SET status='reclaimed',updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND generation_id IS NULL
       AND owner_epoch=$4 AND status='retiring' AND mode='whole'`,
    [route, locator.catalogueId, locator.stageId, row.owner_epoch],
  );
  if (candidate.rowCount !== 1)
    throw new HostedVersionCandidateCleanupConflictError('The retiring candidate checkpoint changed during cleanup');
  const generation = await client.query(
    `DELETE FROM content.hosted_tree_generation
     WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3
       AND generation_kind='candidate' AND retirement_claimed
     RETURNING generation_id`,
    [route, locator.catalogueId, row.generation_id],
  );
  if (generation.rowCount !== 1)
    throw new HostedVersionCandidateCleanupConflictError('The claimed candidate generation could not be retired');
  return 1;
}

async function recordReceipt(
  client: AccessClient,
  route: number,
  locator: HostedPublicationStagingLocator,
  stepId: string,
  row: CleanupRow,
  deletedRows: number,
): Promise<void> {
  await client.query(
    `INSERT INTO content.hosted_version_candidate_cleanup_step
       (route,catalogue_id,stage_id,step_id,phase,cursor,deleted_row_count,deleted_rows,completed)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
     ON CONFLICT (route,catalogue_id,stage_id,step_id) DO NOTHING`,
    [
      route,
      locator.catalogueId,
      locator.stageId,
      stepId,
      row.phase,
      JSON.stringify(row.cursor),
      row.deleted_row_count,
      deletedRows,
      row.completed,
    ],
  );
}

/** Reclaim one expired whole-Book candidate generation in one transaction and at most 100 deleted rows. */
export async function advanceHostedVersionCandidateCleanup(
  client: AccessClient,
  actorInput: Actor,
  locator: HostedPublicationStagingLocator,
  stepId: string,
): Promise<HostedVersionCandidateCleanupStepResult> {
  return advanceCleanup(client, { kind: 'account', actor: actorInput }, locator, stepId);
}

/** Content maintenance uses the locked source and candidate identity persisted by their owner. */
export async function advanceHostedVersionCandidateCleanupFromMaintenance(
  client: AccessClient,
  locator: HostedPublicationStagingLocator,
  stepId: string,
): Promise<HostedVersionCandidateCleanupStepResult> {
  return advanceCleanup(client, { kind: 'maintenance', authority: maintenanceAuthority }, locator, stepId);
}

async function advanceCleanup(
  client: AccessClient,
  owner: CleanupOwner,
  locator: HostedPublicationStagingLocator,
  stepId: string,
): Promise<HostedVersionCandidateCleanupStepResult> {
  const route = validateLocator(locator);
  validateStepId(stepId, route);
  const stage = await lockStage(client, locator, route);
  if (owner.kind === 'account') assertActorBinding(stage, owner.actor);
  else if (owner.authority !== maintenanceAuthority) throw new Error('Invalid hosted candidate maintenance authority');
  await requireExpiredStage(client, stage);

  const prior = await readReceipt(client, route, locator, stepId);
  if (prior) return { replayed: true, deletedRows: prior.deleted_rows, progress: targetProgress(locator, prior) };

  let row = await ensureCleanupClaim(client, stage, locator);
  let phase = row.phase;
  let cursor = row.cursor;
  let deletedRows = 0;
  if (phase !== 'done') {
    const authority = `${route}:${locator.catalogueId}:${locator.stageId}:${row.generation_id}`;
    await client.query("SELECT set_config('content.hosted_version_candidate_cleanup',$1,true)", [authority]);
    const activated = await client.query(
      `UPDATE content.hosted_version_candidate_cleanup
       SET cleanup_active=true
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
         AND cleanup_active=false AND completed_at IS NULL`,
      [route, locator.catalogueId, locator.stageId],
    );
    if (activated.rowCount !== 1)
      throw new HostedVersionCandidateCleanupConflictError('The candidate cleanup step is already active or complete');

    while (phase !== 'done' && deletedRows < HOSTED_VERSION_CANDIDATE_CLEANUP_STEP_LIMIT) {
      const remaining = HOSTED_VERSION_CANDIDATE_CLEANUP_STEP_LIMIT - deletedRows;
      if (phase === 'generation') {
        deletedRows += await deleteGeneration(client, route, locator, row);
        phase = 'done';
        cursor = null;
        continue;
      }

      const rows = await deletePage(client, phase, route, locator.catalogueId, row.generation_id, cursor, remaining);
      if (rows.length) {
        cursor = greatestCursor(rows);
        deletedRows += rows.length;
      }
      if (rows.length < remaining) {
        phase = nextPhase(phase);
        cursor = null;
      }
    }

    const updated = await client.query<CleanupRow>(
      `UPDATE content.hosted_version_candidate_cleanup
       SET phase=$4,cursor=$5::jsonb,deleted_row_count=deleted_row_count+$6,
           cleanup_active=false,
           completed_at=CASE WHEN $4='done' THEN COALESCE(completed_at,clock_timestamp()) ELSE NULL END
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND cleanup_active=true
       RETURNING owner_epoch::text,generation_id,terminal_status,phase,cursor,
         deleted_row_count::text,(completed_at IS NOT NULL) AS completed`,
      [route, locator.catalogueId, locator.stageId, phase, JSON.stringify(cursor), deletedRows],
    );
    row = updated.rows[0]!;
    if (!row) throw new HostedVersionCandidateCleanupConflictError('The candidate cleanup frontier was lost');
    await client.query("SELECT set_config('content.hosted_version_candidate_cleanup','',true)");
  }

  await recordReceipt(client, route, locator, stepId, row, deletedRows);
  return { replayed: false, deletedRows, progress: targetProgress(locator, row) };
}
