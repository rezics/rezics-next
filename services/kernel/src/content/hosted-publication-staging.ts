import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { AccessClient, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { ContentNotFoundError } from './reads.ts';
import {
  observeHostedChapterAttachments,
  type HostedChapterAttachmentObservation,
} from './hosted-chapters-attachments.ts';
import type { HostedChapterTarget, HostedDependencies, OrderedHostedPlacement } from './hosted-chapters-model.ts';
import {
  HOSTED_PUBLICATION_STAGING_BATCH_LIMIT,
  HOSTED_PUBLICATION_STAGING_STEP_LIMIT,
  HostedPublicationStagingConflictError,
  HostedPublicationStagingExpiredError,
  HostedPublicationStagingNotFoundError,
  requireSafeSourceOrder,
  type AppendHostedPublicationSelection,
  type BeginHostedPublicationStaging,
  type HostedPublicationStagedCandidate,
  type HostedPublicationStagingBatchResult,
  type HostedPublicationStagingCheckpoint,
  type HostedPublicationStagingLocator,
  type HostedPublicationStagingMode,
  type HostedPublicationStagingPage,
  type HostedPublicationStagingSeal,
  type HostedPublicationStagingState,
  type HostedPublicationStagingStepResult,
  type HostedPublicationTargetObservation,
} from './hosted-publication-staging-model.ts';

/** A staging operation must run inside the catalogue-home transaction which
 * admitted the same account and epoch. These helpers stage private data only;
 * they never create an authorization grant or move publication_id. */
type AccountActor = Extract<Actor, { kind: 'account' }>;
type StageRow = QueryResultRow & {
  route: number;
  catalogue_id: string;
  stage_id: string;
  initiator_account_id: string;
  owner_epoch: string;
  source_revision_id: string;
  expected_head_revision_id: string;
  expected_publication_id: string | null;
  mode: HostedPublicationStagingMode;
  source_has_descriptor: boolean;
  source_descriptor_revision_id: string | null;
  source_base_revision_id: string;
  source_base_placement_count: string | null;
  source_base_root_count: string | null;
  source_high_water: string;
  expires_at: string;
  status: HostedPublicationStagingState;
  input_version: string;
  input_count: string;
  input_frozen_version: string | null;
  input_frontier: string;
  settled_input_count: string;
  candidate_count: string;
  duplicate_input_count: string;
  unknown_input_count: string;
  target_observation_count: string;
  source_frontier: string;
  source_exhausted: boolean;
  closure_frontier: string;
  closure_checked_count: string;
  closure_missing_count: string;
  failure: string | null;
  is_expired: boolean;
};
type SourceRow = QueryResultRow & {
  source_order: string;
  occurrence_id: string;
  parent_id: string | null;
  position: string;
  source_segment: 'snapshot' | 'base' | 'append';
  kind: 'part' | 'chapter';
  title: string | null;
  thread_id: string | null;
  post_id: string | null;
  target_revision_id: string | null;
  sha256: string | null;
};
type InputRow = QueryResultRow & { input_position: string; occurrence_id: string };
type TargetIdentityRow = QueryResultRow & {
  thread_id: string;
  post_id: string;
  target_revision_id: string;
  sha256: string;
};
type StepReceiptRow = QueryResultRow & {
  phase: 'whole' | 'selection' | 'closure';
  processed: number;
  result_checkpoint: HostedPublicationStagingCheckpoint;
};
type PinnedSourceRow = QueryResultRow & {
  head_revision_id: string;
  publication_id: string | null;
  revision_kind: string;
  descriptor_revision_id: string | null;
  base_revision_id: string | null;
  base_placement_count: string | null;
  base_root_count: string | null;
  high_water: string | null;
};
type StepCandidate = Readonly<{
  sourceOrder: string;
  occurrenceId: string;
  parentId: string | null;
  position: string;
  sourceSegment: 'snapshot' | 'base' | 'append';
  kind: 'part' | 'chapter';
  title: string | null;
  target: HostedChapterTarget | null;
}>;
type SourcePage = Readonly<{ rows: readonly SourceRow[]; exhausted: boolean }>;
type StepPhase = 'whole' | 'selection' | 'closure';
type OutputTargetCursor = Readonly<{
  threadId: string;
  postId: string;
  revisionId: string;
  sha256: string;
}>;

const STAGE_SELECT = `
    SELECT route,catalogue_id,stage_id,initiator_account_id,owner_epoch::text AS owner_epoch,
    source_revision_id,expected_head_revision_id,expected_publication_id,mode,
    source_has_descriptor,source_descriptor_revision_id,source_base_revision_id,source_base_placement_count::text,
    source_base_root_count::text,source_high_water::text,status,input_version::text,
    input_count::text,input_frozen_version::text,input_frontier::text,
    settled_input_count::text,candidate_count::text,duplicate_input_count::text,
    unknown_input_count::text,target_observation_count::text,source_frontier::text,
    source_exhausted,closure_frontier::text,closure_checked_count::text,
    closure_missing_count::text,failure,
    to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
    (expires_at<=clock_timestamp()) AS is_expired
  FROM content.hosted_publication_staging
  WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`;

const SOURCE_FIELDS = `
  p.ordinal::bigint::text AS source_order,p.occurrence_id,p.parent_id,p.position::bigint::text AS position,
  'snapshot'::text AS source_segment,o.kind,p.title,o.thread_id,o.post_id,p.target_revision_id,
  encode(p.body_sha256,'hex') AS sha256`;
const PREFIX_BASE_FIELDS = `
  p.ordinal::bigint::text AS source_order,p.occurrence_id,p.parent_id,p.position::bigint::text AS position,
  'base'::text AS source_segment,o.kind,p.title,o.thread_id,o.post_id,p.target_revision_id,
  encode(p.body_sha256,'hex') AS sha256`;
function stagingConflict(message?: string): HostedPublicationStagingConflictError {
  return new HostedPublicationStagingConflictError(message);
}
function accountActor(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 0)
    throw new HostedPublicationStagingNotFoundError();
  return actor;
}
function requireRoute(id: string, expected?: number): number {
  const route = routeOf(id);
  if (route === null || (expected !== undefined && route !== expected))
    throw stagingConflict('Hosted publication staging identifiers must share their native route');
  return route;
}
function validateLocator(locator: HostedPublicationStagingLocator): number {
  const route = requireRoute(locator.catalogueId);
  requireRoute(locator.stageId, route);
  return route;
}
function assertActorBinding(row: StageRow, actorInput: Actor): AccountActor {
  const actor = accountActor(actorInput);
  if (row.initiator_account_id !== actor.accountId || row.owner_epoch !== String(actor.authnEpoch))
    throw new HostedPublicationStagingNotFoundError();
  return actor;
}
function canonicalExpiry(value: Date | string): string {
  const expiry = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(expiry.getTime())) throw stagingConflict('Invalid staging expiry');
  return expiry.toISOString();
}
function checkpoint(row: StageRow): HostedPublicationStagingCheckpoint {
  return {
    locator: { catalogueId: row.catalogue_id, stageId: row.stage_id },
    state: row.status,
    mode: row.mode,
    inputVersion: row.input_version,
    inputCount: row.input_count,
    settledInputCount: row.settled_input_count,
    candidateCount: row.candidate_count,
    sourceFrontier: row.source_frontier,
    sourceExhausted: row.source_exhausted,
    closureFrontier: row.closure_frontier,
    closureCheckedCount: row.closure_checked_count,
    closureMissingCount: row.closure_missing_count,
    failure: row.failure,
  };
}
function sameOptional(left: string | null, right: string | null): boolean {
  return left === right;
}
function sameExpiry(left: string, right: string): boolean {
  return new Date(left).getTime() === new Date(right).getTime();
}
function bytes(value: Buffer | Uint8Array | string): Buffer {
  return Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value, 'hex') : Buffer.from(value);
}
function isTerminal(state: HostedPublicationStagingState): boolean {
  return state === 'cancelled' || state === 'expired' || state === 'failed';
}
async function lockStage(client: AccessClient, locator: HostedPublicationStagingLocator): Promise<StageRow> {
  const route = validateLocator(locator);
  const result = await client.query<StageRow>(`${STAGE_SELECT} FOR UPDATE`, [
    route,
    locator.catalogueId,
    locator.stageId,
  ]);
  const row = result.rows[0];
  if (!row) throw new HostedPublicationStagingNotFoundError();
  return row;
}
async function refreshExpiry(client: AccessClient, row: StageRow): Promise<StageRow> {
  if (!row.is_expired || row.status === 'cancelled' || row.status === 'expired' || row.status === 'failed') return row;
  await client.query(
    `UPDATE content.hosted_publication_staging SET status='expired'
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND expires_at<=clock_timestamp()`,
    [row.route, row.catalogue_id, row.stage_id],
  );
  return { ...row, status: 'expired' };
}
async function requireLiveStage(client: AccessClient, row: StageRow): Promise<StageRow> {
  const refreshed = await refreshExpiry(client, row);
  if (refreshed.status === 'expired') throw new HostedPublicationStagingExpiredError();
  if (isTerminal(refreshed.status)) throw stagingConflict(`Staging is ${refreshed.status}`);
  return refreshed;
}
async function stageSnapshot(
  client: AccessClient,
  route: number,
  locator: HostedPublicationStagingLocator,
): Promise<StageRow> {
  const result = await client.query<StageRow>(STAGE_SELECT, [route, locator.catalogueId, locator.stageId]);
  const row = result.rows[0];
  if (!row) throw new HostedPublicationStagingNotFoundError();
  return row;
}

/** Pin one current structure and (when present) its immutable single-prefix descriptor.
 * Call only after current native catalogue author/container admission. */
export async function beginHostedPublicationStaging(
  client: AccessClient,
  actorInput: Actor,
  input: BeginHostedPublicationStaging,
): Promise<Readonly<{ replayed: boolean; progress: HostedPublicationStagingCheckpoint }>> {
  const actor = accountActor(actorInput);
  const route = validateLocator(input);
  requireRoute(input.expectedHeadRevisionId, route);
  if (input.expectedPublicationId !== null) requireRoute(input.expectedPublicationId, route);
  if (input.mode !== 'whole' && input.mode !== 'selection') throw stagingConflict('Unknown staging mode');
  const expiry = canonicalExpiry(input.expiresAt);

  const existing = (
    await client.query<StageRow>(`${STAGE_SELECT} FOR UPDATE`, [route, input.catalogueId, input.stageId])
  ).rows[0];
  if (existing) {
    assertActorBinding(existing, actor);
    if (
      existing.source_revision_id !== input.expectedHeadRevisionId ||
      !sameOptional(existing.expected_publication_id, input.expectedPublicationId) ||
      existing.mode !== input.mode ||
      !sameExpiry(expiry, existing.expires_at)
    )
      throw stagingConflict('Staging ID was already used for different source inputs');
    return { replayed: true, progress: checkpoint(existing) };
  }

  const expiryCheck = await client.query<QueryResultRow & { valid: boolean }>(
    `SELECT $1::timestamptz>clock_timestamp() AS valid`,
    [expiry],
  );
  if (!expiryCheck.rows[0]?.valid) throw new HostedPublicationStagingExpiredError();

  const pinned = (
    await client.query<PinnedSourceRow>(
      `SELECT c.head_revision_id,c.publication_id,r.kind AS revision_kind,
         d.revision_id AS descriptor_revision_id,d.base_revision_id,
         d.base_placement_count::text,d.base_root_count::text,d.high_water::text
       FROM content.hosted_catalogue c
       JOIN content.hosted_structure_revision r
         ON r.route=c.route AND r.catalogue_id=c.catalogue_id AND r.revision_id=c.head_revision_id
       LEFT JOIN content.hosted_append_descriptor d
         ON d.route=c.route AND d.catalogue_id=c.catalogue_id AND d.revision_id=c.head_revision_id
       WHERE c.route=$1 AND c.catalogue_id=$2
         AND c.head_revision_id=$3 AND c.publication_id IS NOT DISTINCT FROM $4`,
      [route, input.catalogueId, input.expectedHeadRevisionId, input.expectedPublicationId],
    )
  ).rows[0];
  if (!pinned || pinned.revision_kind !== 'structure')
    throw stagingConflict('The expected draft or publication is stale');
  const hasDescriptor = pinned.descriptor_revision_id !== null;
  const sourceBaseRevisionId = hasDescriptor ? pinned.base_revision_id! : input.expectedHeadRevisionId;
  const sourceHighWater = hasDescriptor ? pinned.high_water! : '-1';
  const initialStatus = input.mode === 'whole' ? 'building' : 'collecting';
  const inserted = await client.query(
    `INSERT INTO content.hosted_publication_staging
       (route,catalogue_id,stage_id,initiator_account_id,owner_epoch,source_revision_id,
        expected_head_revision_id,expected_publication_id,mode,source_has_descriptor,
        source_descriptor_revision_id,source_base_revision_id,source_base_placement_count,source_base_root_count,source_high_water,
        status,expires_at)
     SELECT $1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz
     WHERE $16::timestamptz>clock_timestamp()
     ON CONFLICT (route,catalogue_id,stage_id) DO NOTHING
     RETURNING stage_id`,
    [
      route,
      input.catalogueId,
      input.stageId,
      actor.accountId,
      String(actor.authnEpoch),
      input.expectedHeadRevisionId,
      input.expectedPublicationId,
      input.mode,
      hasDescriptor,
      hasDescriptor ? input.expectedHeadRevisionId : null,
      sourceBaseRevisionId,
      hasDescriptor ? pinned.base_placement_count : null,
      hasDescriptor ? pinned.base_root_count : null,
      sourceHighWater,
      initialStatus,
      expiry,
    ],
  );
  const row = await stageSnapshot(client, route, input);
  assertActorBinding(row, actor);
  if (inserted.rows.length) return { replayed: false, progress: checkpoint(row) };
  if (
    row.source_revision_id !== input.expectedHeadRevisionId ||
    !sameOptional(row.expected_publication_id, input.expectedPublicationId) ||
    row.mode !== input.mode ||
    !sameExpiry(expiry, row.expires_at)
  )
    throw stagingConflict('Staging ID was already used for different source inputs');
  return { replayed: true, progress: checkpoint(row) };
}

/** Persist one explicit selection batch. The 512 limit applies to this external
 * batch only; input positions and total selection have no 512 cap. */
export async function appendHostedPublicationSelectionBatch(
  client: AccessClient,
  actorInput: Actor,
  input: AppendHostedPublicationSelection,
): Promise<HostedPublicationStagingBatchResult> {
  const actor = accountActor(actorInput);
  const route = validateLocator(input);
  requireRoute(input.batchId, route);
  if (
    !Array.isArray(input.occurrenceIds) ||
    input.occurrenceIds.length < 1 ||
    input.occurrenceIds.length > HOSTED_PUBLICATION_STAGING_BATCH_LIMIT
  )
    throw stagingConflict(
      `Selection batches must contain 1 to ${HOSTED_PUBLICATION_STAGING_BATCH_LIMIT} occurrence IDs`,
    );
  for (const occurrenceId of input.occurrenceIds) requireRoute(occurrenceId, route);
  const payloadDigest = createHash('sha256').update(JSON.stringify(input.occurrenceIds)).digest();
  const row = await lockStage(client, input);
  assertActorBinding(row, actor);
  const previous = (
    await client.query<
      QueryResultRow & {
        input_version: string;
        first_input_position: string;
        item_count: number;
        payload_sha256: Buffer;
      }
    >(
      `SELECT input_version::text,first_input_position::text,item_count,payload_sha256
       FROM content.hosted_publication_staging_batch
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND batch_id=$4`,
      [route, input.catalogueId, input.stageId, input.batchId],
    )
  ).rows[0];
  if (previous) {
    if (!bytes(previous.payload_sha256).equals(payloadDigest) || previous.item_count !== input.occurrenceIds.length)
      throw stagingConflict('Selection batch ID was already used for different IDs');
    return {
      replayed: true,
      inputVersion: previous.input_version,
      firstInputPosition: previous.first_input_position,
      itemCount: previous.item_count,
    };
  }
  const live = await requireLiveStage(client, row);
  if (live.mode !== 'selection' || live.status !== 'collecting' || live.input_frozen_version !== null)
    throw stagingConflict('Selection input is already frozen or not being collected');
  const nextVersion = BigInt(live.input_version) + 1n;
  const first = BigInt(live.input_count);
  const inputRows = input.occurrenceIds.map((occurrenceId, index) => ({
    input_position: (first + BigInt(index)).toString(),
    occurrence_id: occurrenceId,
  }));
  await client.query(
    `INSERT INTO content.hosted_publication_staging_batch
       (route,catalogue_id,stage_id,batch_id,input_version,first_input_position,item_count,payload_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      route,
      input.catalogueId,
      input.stageId,
      input.batchId,
      nextVersion.toString(),
      first.toString(),
      inputRows.length,
      payloadDigest,
    ],
  );
  await client.query(
    `INSERT INTO content.hosted_publication_staging_input
       (route,catalogue_id,stage_id,input_position,occurrence_id)
     SELECT $1,$2,$3,x.input_position,x.occurrence_id
     FROM jsonb_to_recordset($4::jsonb) AS x(input_position bigint,occurrence_id uuid)`,
    [route, input.catalogueId, input.stageId, JSON.stringify(inputRows)],
  );
  await client.query(
    `UPDATE content.hosted_publication_staging
     SET input_version=$4,input_count=$5
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [route, input.catalogueId, input.stageId, nextVersion.toString(), (first + BigInt(inputRows.length)).toString()],
  );
  return {
    replayed: false,
    inputVersion: nextVersion.toString(),
    firstInputPosition: first.toString(),
    itemCount: inputRows.length,
  };
}

/** Freeze the imported input version. Later batches require a new stage and can
 * never alter a partially built or sealed selection. */
export async function freezeHostedPublicationSelection(
  client: AccessClient,
  actorInput: Actor,
  locator: HostedPublicationStagingLocator,
): Promise<HostedPublicationStagingCheckpoint> {
  const actor = accountActor(actorInput);
  const row = await lockStage(client, locator);
  assertActorBinding(row, actor);
  const live = await requireLiveStage(client, row);
  if (live.mode !== 'selection') throw stagingConflict('Whole-source staging has no imported selection');
  if (live.input_frozen_version !== null) return checkpoint(live);
  if (live.status !== 'collecting') throw stagingConflict('Selection input cannot be frozen in its current state');
  const nextState = BigInt(live.input_count) === 0n ? 'closing' : 'building';
  const updated = await client.query(
    `UPDATE content.hosted_publication_staging
     SET input_frozen_version=input_version,status=$4
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [live.route, live.catalogue_id, live.stage_id, nextState],
  );
  if (updated.rowCount !== 1) throw stagingConflict();
  return checkpoint(await stageSnapshot(client, live.route, locator));
}

/** Advance one page of at most twenty source or closure rows. A step key makes
 * response loss replay the original checkpoint without consuming another page.
 * Target attachment reads are exact metadata-only checks; their stored rows are
 * observations, never a retained current-authority proof. */
export async function advanceHostedPublicationStaging(
  deps: HostedDependencies,
  client: AccessClient,
  actorInput: Actor,
  locator: HostedPublicationStagingLocator,
  stepId: string,
  deadline: number,
): Promise<HostedPublicationStagingStepResult> {
  const actor = accountActor(actorInput);
  const route = validateLocator(locator);
  requireRoute(stepId, route);
  const row = await lockStage(client, locator);
  assertActorBinding(row, actor);
  const prior = (
    await client.query<StepReceiptRow>(
      `SELECT phase,processed,result_checkpoint
       FROM content.hosted_publication_staging_step
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND step_id=$4`,
      [route, locator.catalogueId, locator.stageId, stepId],
    )
  ).rows[0];
  if (prior)
    return {
      replayed: true,
      phase: prior.phase,
      processed: prior.processed,
      progress: prior.result_checkpoint,
    };
  const live = await requireLiveStage(client, row);
  let result: HostedPublicationStagingStepResult;
  if (live.mode === 'whole') result = await advanceWhole(deps, client, actor, live, deadline);
  else if (live.status === 'building') result = await advanceSelection(deps, client, actor, live, deadline);
  else if (live.status === 'closing') result = await advanceClosure(client, live);
  else throw stagingConflict('Staging is not ready for another step');
  await client.query(
    `INSERT INTO content.hosted_publication_staging_step
       (route,catalogue_id,stage_id,step_id,phase,from_frontier,to_frontier,processed,result_state,result_checkpoint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      route,
      locator.catalogueId,
      locator.stageId,
      stepId,
      result.phase,
      result.phase === 'whole'
        ? live.source_frontier
        : result.phase === 'selection'
          ? live.input_frontier
          : live.closure_frontier,
      result.phase === 'whole'
        ? result.progress.sourceFrontier
        : result.phase === 'selection'
          ? result.progress.settledInputCount
          : result.progress.closureFrontier,
      result.processed,
      result.progress.state === 'failed' ? 'failed' : result.progress.state === 'ready' ? 'ready' : 'more',
      JSON.stringify(result.progress),
    ],
  );
  return result;
}

async function advanceWhole(
  deps: HostedDependencies,
  client: AccessClient,
  actor: AccountActor,
  stage: StageRow,
  deadline: number,
): Promise<HostedPublicationStagingStepResult> {
  if (stage.status !== 'building') throw stagingConflict('Whole-source staging is not active');
  const page = await readWholeSourcePage(client, stage);
  const candidates = page.rows.map(toCandidate);
  if (candidates.some((candidate) => candidate.title === null))
    return failStep(client, stage, 'whole', 'source_redacted', 0);
  let observations: readonly { target: HostedChapterTarget }[];
  try {
    observations = await observeNewTargets(deps, client, actor, deadline, stage, candidates);
  } catch (error) {
    if (error instanceof ContentNotFoundError) return failStep(client, stage, 'whole', 'target_unavailable', 0);
    throw error;
  }
  await insertCandidates(client, stage, candidates);
  const nextFrontier = candidates.at(-1)?.sourceOrder ?? stage.source_frontier;
  const nextStatus = page.exhausted ? 'ready' : 'building';
  await client.query(
    `UPDATE content.hosted_publication_staging
     SET source_frontier=$4,source_exhausted=$5,candidate_count=candidate_count+$6,
         target_observation_count=target_observation_count+$7,status=$8
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [
      stage.route,
      stage.catalogue_id,
      stage.stage_id,
      nextFrontier,
      page.exhausted,
      candidates.length,
      observations.length,
      nextStatus,
    ],
  );
  const updated = await stageSnapshot(client, stage.route, {
    catalogueId: stage.catalogue_id,
    stageId: stage.stage_id,
  });
  return {
    replayed: false,
    phase: 'whole',
    processed: candidates.length,
    progress: checkpoint(updated),
  };
}

async function readWholeSourcePage(client: AccessClient, stage: StageRow): Promise<SourcePage> {
  const after = BigInt(stage.source_frontier);
  const limit = HOSTED_PUBLICATION_STAGING_STEP_LIMIT;
  if (!stage.source_has_descriptor) {
    const rows = (
      await client.query<SourceRow>(
        `SELECT ${SOURCE_FIELDS}
         FROM content.hosted_placement p
         JOIN content.hosted_occurrence o USING (route,catalogue_id,occurrence_id)
         WHERE p.route=$1 AND p.catalogue_id=$2 AND p.revision_id=$3 AND p.ordinal>$4
         ORDER BY p.ordinal LIMIT $5`,
        [stage.route, stage.catalogue_id, stage.source_revision_id, after.toString(), limit + 1],
      )
    ).rows;
    return { rows: rows.slice(0, limit), exhausted: rows.length <= limit };
  }

  const baseCount = BigInt(stage.source_base_placement_count!);
  const highWater = BigInt(stage.source_high_water);
  const result: SourceRow[] = [];
  let more = false;
  let room = limit;
  if (after < baseCount - 1n) {
    const base = (
      await client.query<SourceRow>(
        `SELECT ${PREFIX_BASE_FIELDS}
         FROM content.hosted_placement p
         JOIN content.hosted_occurrence o USING (route,catalogue_id,occurrence_id)
         WHERE p.route=$1 AND p.catalogue_id=$2 AND p.revision_id=$3 AND p.ordinal>$4 AND p.ordinal<$5
         ORDER BY p.ordinal LIMIT $6`,
        [
          stage.route,
          stage.catalogue_id,
          stage.source_base_revision_id,
          after.toString(),
          baseCount.toString(),
          room + 1,
        ],
      )
    ).rows;
    if (base.length > room) {
      result.push(...base.slice(0, room));
      more = true;
      room = 0;
    } else {
      result.push(...base);
      room -= base.length;
    }
  }
  const maximumOrder = baseCount + highWater;
  if (!more && room > 0 && highWater >= 0n && after < maximumOrder) {
    const afterOffset = after < baseCount ? -1n : after - baseCount;
    const appended = (
      await client.query<SourceRow>(
        `SELECT ($6::bigint+a.append_offset)::text AS source_order,a.occurrence_id,
           NULL::uuid AS parent_id,($7::bigint+a.append_offset)::text AS position,
           'append'::text AS source_segment,'chapter'::text AS kind,a.title,
           o.thread_id,o.post_id,a.target_revision_id,encode(a.body_sha256,'hex') AS sha256
         FROM content.hosted_append a
         JOIN content.hosted_occurrence o
           ON o.route=a.route AND o.catalogue_id=a.catalogue_id AND o.occurrence_id=a.occurrence_id
         WHERE a.route=$1 AND a.catalogue_id=$2 AND a.stream_id=$3
         AND a.append_offset>$4 AND a.append_offset<=$5
       ORDER BY a.append_offset LIMIT $8`,
        [
          stage.route,
          stage.catalogue_id,
          stage.source_base_revision_id,
          afterOffset.toString(),
          highWater.toString(),
          baseCount.toString(),
          stage.source_base_root_count,
          room + 1,
        ],
      )
    ).rows;
    if (appended.length > room) {
      result.push(...appended.slice(0, room));
      more = true;
      room = 0;
    } else {
      result.push(...appended);
      room -= appended.length;
    }
  }
  if (!more && result.length === limit) {
    const last = BigInt(result.at(-1)!.source_order);
    more = last < maximumOrder;
  }
  return { rows: result, exhausted: !more };
}

async function advanceSelection(
  deps: HostedDependencies,
  client: AccessClient,
  actor: AccountActor,
  stage: StageRow,
  deadline: number,
): Promise<HostedPublicationStagingStepResult> {
  if (stage.mode !== 'selection' || stage.input_frozen_version === null)
    throw stagingConflict('Selection input must be frozen before processing');
  const first = BigInt(stage.input_frontier);
  const inputs = (
    await client.query<InputRow>(
      `SELECT input_position::text,occurrence_id
       FROM content.hosted_publication_staging_input
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND input_position>$4
       ORDER BY input_position LIMIT $5`,
      [stage.route, stage.catalogue_id, stage.stage_id, first.toString(), HOSTED_PUBLICATION_STAGING_STEP_LIMIT + 1],
    )
  ).rows.slice(0, HOSTED_PUBLICATION_STAGING_STEP_LIMIT);
  if (inputs.length === 0) {
    if (BigInt(stage.settled_input_count) !== BigInt(stage.input_count))
      throw stagingConflict('Selection frontier does not cover its frozen input');
    await client.query(
      `UPDATE content.hosted_publication_staging SET status='closing',closure_frontier=-1,closure_checked_count=0
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND status='building'`,
      [stage.route, stage.catalogue_id, stage.stage_id],
    );
    const updated = await stageSnapshot(client, stage.route, {
      catalogueId: stage.catalogue_id,
      stageId: stage.stage_id,
    });
    return { replayed: false, phase: 'selection', processed: 0, progress: checkpoint(updated) };
  }

  const inputJson = JSON.stringify(
    inputs.map((input) => ({ input_position: input.input_position, occurrence_id: input.occurrence_id })),
  );
  const duplicates = new Set(
    (
      await client.query<QueryResultRow & { occurrence_id: string }>(
        `WITH requested AS (
           SELECT x.input_position,x.occurrence_id
           FROM jsonb_to_recordset($4::jsonb) AS x(input_position bigint,occurrence_id uuid)
         )
         SELECT DISTINCT r.occurrence_id
         FROM requested r
         WHERE EXISTS (
           SELECT 1 FROM content.hosted_publication_staging_input prior
           WHERE prior.route=$1 AND prior.catalogue_id=$2 AND prior.stage_id=$3
             AND prior.occurrence_id=r.occurrence_id AND prior.input_position<r.input_position
         )`,
        [stage.route, stage.catalogue_id, stage.stage_id, inputJson],
      )
    ).rows.map((row) => row.occurrence_id),
  );
  const uniqueIds: string[] = [];
  for (const input of inputs)
    if (!duplicates.has(input.occurrence_id) && !uniqueIds.includes(input.occurrence_id))
      uniqueIds.push(input.occurrence_id);
  const sourceRows = await readExactSourceRows(client, stage, uniqueIds);
  const byOccurrence = new Map(sourceRows.map((source) => [source.occurrence_id, source]));
  const settlements: Array<{
    input_position: string;
    settlement: 'selected' | 'duplicate' | 'unknown';
    source_order: string | null;
  }> = [];
  const candidates: StepCandidate[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (duplicates.has(input.occurrence_id) || seen.has(input.occurrence_id)) {
      settlements.push({ input_position: input.input_position, settlement: 'duplicate', source_order: null });
      seen.add(input.occurrence_id);
      continue;
    }
    seen.add(input.occurrence_id);
    const source = byOccurrence.get(input.occurrence_id);
    if (!source) {
      settlements.push({ input_position: input.input_position, settlement: 'unknown', source_order: null });
      continue;
    }
    candidates.push(toCandidate(source));
    settlements.push({
      input_position: input.input_position,
      settlement: 'selected',
      source_order: source.source_order,
    });
  }
  if (candidates.some((candidate) => candidate.title === null))
    return failStep(client, stage, 'selection', 'source_redacted', 0);
  let observations: readonly { target: HostedChapterTarget }[];
  try {
    observations = await observeNewTargets(deps, client, actor, deadline, stage, candidates);
  } catch (error) {
    if (error instanceof ContentNotFoundError) return failStep(client, stage, 'selection', 'target_unavailable', 0);
    throw error;
  }
  await insertCandidates(client, stage, candidates);
  await client.query(
    `UPDATE content.hosted_publication_staging_input i
     SET settlement=x.settlement,source_order=x.source_order
     FROM jsonb_to_recordset($4::jsonb) AS x(input_position bigint,settlement text,source_order bigint)
     WHERE i.route=$1 AND i.catalogue_id=$2 AND i.stage_id=$3 AND i.input_position=x.input_position`,
    [stage.route, stage.catalogue_id, stage.stage_id, JSON.stringify(settlements)],
  );
  const duplicate = settlements.filter((item) => item.settlement === 'duplicate').length;
  const unknown = settlements.filter((item) => item.settlement === 'unknown').length;
  const settledCount = BigInt(stage.settled_input_count) + BigInt(inputs.length);
  const allSettled = settledCount === BigInt(stage.input_count);
  const invalid =
    allSettled &&
    BigInt(stage.duplicate_input_count) + BigInt(duplicate) + BigInt(stage.unknown_input_count) + BigInt(unknown) > 0n;
  const nextStatus = invalid ? 'failed' : allSettled ? 'closing' : 'building';
  const nextFailure = invalid ? 'selection_invalid' : null;
  await client.query(
    `UPDATE content.hosted_publication_staging
     SET input_frontier=$4,settled_input_count=settled_input_count+$5,
         candidate_count=candidate_count+$6,duplicate_input_count=duplicate_input_count+$7,
         unknown_input_count=unknown_input_count+$8,target_observation_count=target_observation_count+$9,
         status=$10,failure=$11
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [
      stage.route,
      stage.catalogue_id,
      stage.stage_id,
      inputs.at(-1)!.input_position,
      inputs.length,
      candidates.length,
      duplicate,
      unknown,
      observations.length,
      nextStatus,
      nextFailure,
    ],
  );
  const updated = await stageSnapshot(client, stage.route, {
    catalogueId: stage.catalogue_id,
    stageId: stage.stage_id,
  });
  return { replayed: false, phase: 'selection', processed: inputs.length, progress: checkpoint(updated) };
}

async function readExactSourceRows(
  client: AccessClient,
  stage: StageRow,
  occurrenceIds: readonly string[],
): Promise<SourceRow[]> {
  if (!occurrenceIds.length) return [];
  const baseRevision = stage.source_has_descriptor ? stage.source_base_revision_id : stage.source_revision_id;
  const base = (
    await client.query<SourceRow>(
      `SELECT ${stage.source_has_descriptor ? PREFIX_BASE_FIELDS : SOURCE_FIELDS}
       FROM content.hosted_placement p
       JOIN content.hosted_occurrence o USING (route,catalogue_id,occurrence_id)
       WHERE p.route=$1 AND p.catalogue_id=$2 AND p.revision_id=$3
         AND p.occurrence_id=ANY($4::uuid[]) ORDER BY p.ordinal`,
      [stage.route, stage.catalogue_id, baseRevision, [...occurrenceIds]],
    )
  ).rows;
  if (!stage.source_has_descriptor || BigInt(stage.source_high_water) < 0n) return base;
  const appended = (
    await client.query<SourceRow>(
      `SELECT ($4::bigint+a.append_offset)::text AS source_order,a.occurrence_id,
         NULL::uuid AS parent_id,($5::bigint+a.append_offset)::text AS position,
         'append'::text AS source_segment,'chapter'::text AS kind,a.title,
         o.thread_id,o.post_id,a.target_revision_id,encode(a.body_sha256,'hex') AS sha256
       FROM content.hosted_append a
       JOIN content.hosted_occurrence o
         ON o.route=a.route AND o.catalogue_id=a.catalogue_id AND o.occurrence_id=a.occurrence_id
       WHERE a.route=$1 AND a.catalogue_id=$2 AND a.stream_id=$3
         AND a.append_offset<=$6 AND a.occurrence_id=ANY($7::uuid[])
       ORDER BY a.append_offset`,
      [
        stage.route,
        stage.catalogue_id,
        stage.source_base_revision_id,
        stage.source_base_placement_count,
        stage.source_base_root_count,
        stage.source_high_water,
        [...occurrenceIds],
      ],
    )
  ).rows;
  return [...base, ...appended];
}

async function failStep(
  client: AccessClient,
  stage: StageRow,
  phase: 'whole' | 'selection',
  failure: string,
  processed: number,
): Promise<HostedPublicationStagingStepResult> {
  await client.query(
    `UPDATE content.hosted_publication_staging SET status='failed',failure=$4
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [stage.route, stage.catalogue_id, stage.stage_id, failure],
  );
  const updated = await stageSnapshot(client, stage.route, {
    catalogueId: stage.catalogue_id,
    stageId: stage.stage_id,
  });
  return { replayed: false, phase, processed, progress: checkpoint(updated) };
}

function toCandidate(row: SourceRow): StepCandidate {
  const sourceOrder = BigInt(row.source_order);
  if (sourceOrder < 0n || sourceOrder > BigInt(Number.MAX_SAFE_INTEGER))
    throw stagingConflict('Pinned source order exceeds the supported exact range');
  if (row.kind === 'part') {
    if (row.thread_id !== null || row.post_id !== null || row.target_revision_id !== null || row.sha256 !== null)
      throw stagingConflict('Pinned part has target fields');
    return {
      sourceOrder: sourceOrder.toString(),
      occurrenceId: row.occurrence_id,
      parentId: row.parent_id,
      position: row.position,
      sourceSegment: row.source_segment,
      kind: 'part',
      title: row.title,
      target: null,
    };
  }
  if (!row.thread_id || !row.post_id || !row.target_revision_id || !row.sha256 || !/^[0-9a-f]{64}$/.test(row.sha256))
    throw stagingConflict('Pinned chapter has an incomplete exact target');
  return {
    sourceOrder: sourceOrder.toString(),
    occurrenceId: row.occurrence_id,
    parentId: row.parent_id,
    position: row.position,
    sourceSegment: row.source_segment,
    kind: 'chapter',
    title: row.title,
    target: {
      threadId: row.thread_id,
      postId: row.post_id,
      revisionId: row.target_revision_id,
      sha256: row.sha256,
    },
  };
}
function toPlacement(candidate: StepCandidate): OrderedHostedPlacement {
  const ordinal = requireSafeSourceOrder(candidate.sourceOrder);
  const position = Number(candidate.position);
  if (!Number.isSafeInteger(position) || position < 0) throw stagingConflict('Pinned source position is invalid');
  const common = {
    occurrenceId: candidate.occurrenceId,
    parentId: candidate.parentId,
    position,
    ordinal,
    title: candidate.title!,
  };
  if (candidate.kind === 'part') return { ...common, kind: 'part' };
  return { ...common, kind: 'chapter', target: candidate.target! };
}
function targetKey(target: HostedChapterTarget): string {
  return `${target.threadId}/${target.postId}/${target.revisionId}/${target.sha256}`;
}
async function observeNewTargets(
  deps: HostedDependencies,
  client: AccessClient,
  actor: AccountActor,
  deadline: number,
  stage: StageRow,
  candidates: readonly StepCandidate[],
): Promise<readonly HostedChapterAttachmentObservation[]> {
  const targets = new Map<string, HostedChapterTarget>();
  for (const candidate of candidates) if (candidate.target) targets.set(targetKey(candidate.target), candidate.target);
  if (!targets.size) return [];
  const requested = [...targets.values()].map((target) => ({
    thread_id: target.threadId,
    post_id: target.postId,
    target_revision_id: target.revisionId,
    sha256: target.sha256,
  }));
  const found = (
    await client.query<TargetIdentityRow>(
      `WITH requested AS (
         SELECT x.thread_id,x.post_id,x.target_revision_id,decode(x.sha256,'hex') AS body_sha256
         FROM jsonb_to_recordset($4::jsonb)
           AS x(thread_id uuid,post_id uuid,target_revision_id uuid,sha256 text)
       )
       SELECT t.thread_id,t.post_id,t.target_revision_id,encode(t.body_sha256,'hex') AS sha256
       FROM content.hosted_publication_staging_target t
       JOIN requested r USING (thread_id,post_id,target_revision_id,body_sha256)
       WHERE t.route=$1 AND t.catalogue_id=$2 AND t.stage_id=$3`,
      [stage.route, stage.catalogue_id, stage.stage_id, JSON.stringify(requested)],
    )
  ).rows;
  const existing = new Set(
    found.map((target) => `${target.thread_id}/${target.post_id}/${target.target_revision_id}/${target.sha256}`),
  );
  const newTargets = [...targets.entries()].filter(([key]) => !existing.has(key)).map(([, target]) => target);
  if (!newTargets.length) return [];
  const newTargetKeys = new Set(newTargets.map(targetKey));
  const placements = candidates
    .filter((candidate): candidate is StepCandidate & { target: HostedChapterTarget } => {
      const target = candidate.target;
      return target !== null && newTargetKeys.has(targetKey(target));
    })
    .map(toPlacement);
  const observations = await observeHostedChapterAttachments(deps, placements, { actor, deadline });
  const observationRows = observations.map(({ target, authorId, licence }) => ({
    thread_id: target.threadId,
    post_id: target.postId,
    target_revision_id: target.revisionId,
    sha256: target.sha256,
    author_account_id: authorId,
    licence,
  }));
  if (observationRows.length) {
    await client.query(
      `INSERT INTO content.hosted_publication_staging_target
         (route,catalogue_id,stage_id,thread_id,post_id,target_revision_id,body_sha256,author_account_id,licence)
       SELECT $1,$2,$3,x.thread_id,x.post_id,x.target_revision_id,decode(x.sha256,'hex'),x.author_account_id,x.licence
       FROM jsonb_to_recordset($4::jsonb)
         AS x(thread_id uuid,post_id uuid,target_revision_id uuid,sha256 text,author_account_id uuid,licence text)`,
      [stage.route, stage.catalogue_id, stage.stage_id, JSON.stringify(observationRows)],
    );
  }
  return observations;
}
async function insertCandidates(
  client: AccessClient,
  stage: StageRow,
  candidates: readonly StepCandidate[],
): Promise<void> {
  if (!candidates.length) return;
  const rows = candidates.map((candidate) => ({
    source_order: candidate.sourceOrder,
    occurrence_id: candidate.occurrenceId,
    parent_id: candidate.parentId,
    position: candidate.position,
    source_segment: candidate.sourceSegment,
    kind: candidate.kind,
    thread_id: candidate.target?.threadId ?? null,
    post_id: candidate.target?.postId ?? null,
    target_revision_id: candidate.target?.revisionId ?? null,
    sha256: candidate.target?.sha256 ?? null,
  }));
  await client.query(
    `INSERT INTO content.hosted_publication_staging_candidate
       (route,catalogue_id,stage_id,source_order,occurrence_id,parent_id,position,source_segment,kind,
        thread_id,post_id,target_revision_id,body_sha256)
     SELECT $1,$2,$3,x.source_order,x.occurrence_id,x.parent_id,x.position,x.source_segment,x.kind,
       x.thread_id,x.post_id,x.target_revision_id,decode(x.sha256,'hex')
     FROM jsonb_to_recordset($4::jsonb) AS x(
       source_order bigint,occurrence_id uuid,parent_id uuid,position bigint,source_segment text,kind text,
       thread_id uuid,post_id uuid,target_revision_id uuid,sha256 text
     )`,
    [stage.route, stage.catalogue_id, stage.stage_id, JSON.stringify(rows)],
  );
}

/** Seal only after indexed source exhaustion (whole) or frozen input settlement
 * plus an explicit closure pass (selection). No output-root or aggregate
 * authority proof is fabricated here. */
export async function sealHostedPublicationStaging(
  client: AccessClient,
  actorInput: Actor,
  locator: HostedPublicationStagingLocator,
): Promise<Readonly<{ replayed: boolean; seal: HostedPublicationStagingSeal }>> {
  const actor = accountActor(actorInput);
  const stage = await lockStage(client, locator);
  assertActorBinding(stage, actor);
  const live = await refreshExpiry(client, stage);
  if (live.status === 'expired') throw new HostedPublicationStagingExpiredError();
  if (live.status === 'sealed') return { replayed: true, seal: await readSeal(client, live) };
  if (live.status !== 'ready') throw stagingConflict('Source coverage and selection closure are not complete');
  if (live.mode === 'whole' && (!live.source_exhausted || live.failure !== null))
    throw stagingConflict('Whole-source input has not reached raw exhaustion');
  if (
    live.mode === 'selection' &&
    (live.input_frozen_version === null ||
      live.input_frozen_version !== live.input_version ||
      live.settled_input_count !== live.input_count ||
      live.duplicate_input_count !== '0' ||
      live.unknown_input_count !== '0' ||
      live.closure_checked_count !== live.candidate_count ||
      live.closure_missing_count !== '0')
  )
    throw stagingConflict('Explicit selection is incomplete, duplicated, unknown, or not ancestor-closed');
  const current = (
    await client.query<QueryResultRow & { head_revision_id: string; publication_id: string | null }>(
      `SELECT head_revision_id,publication_id
       FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2
       FOR SHARE`,
      [live.route, live.catalogue_id],
    )
  ).rows[0];
  if (
    !current ||
    current.head_revision_id !== live.expected_head_revision_id ||
    !sameOptional(current.publication_id, live.expected_publication_id)
  ) {
    await client.query(
      `UPDATE content.hosted_publication_staging SET status='failed',failure='stale_source'
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [live.route, live.catalogue_id, live.stage_id],
    );
    throw stagingConflict('Pinned draft or publication changed before seal');
  }
  const inserted = await client.query(
    `INSERT INTO content.hosted_publication_staging_seal
       (route,catalogue_id,stage_id,input_version,candidate_count,sealed_at)
     VALUES ($1,$2,$3,$4,$5,clock_timestamp())
     ON CONFLICT (route,catalogue_id,stage_id) DO NOTHING
     RETURNING stage_id`,
    [live.route, live.catalogue_id, live.stage_id, live.input_version, live.candidate_count],
  );
  if (!inserted.rows.length) return { replayed: true, seal: await readSeal(client, live) };
  await client.query(
    `UPDATE content.hosted_publication_staging
     SET status='sealed',sealed_at=(SELECT sealed_at FROM content.hosted_publication_staging_seal
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3)
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND status='ready'`,
    [live.route, live.catalogue_id, live.stage_id],
  );
  return { replayed: false, seal: await readSeal(client, live) };
}

async function readSeal(client: AccessClient, stage: StageRow): Promise<HostedPublicationStagingSeal> {
  const row = (
    await client.query<QueryResultRow & { input_version: string; candidate_count: string; sealed_at: string }>(
      `SELECT input_version::text,candidate_count::text,
         to_char(sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sealed_at
       FROM content.hosted_publication_staging_seal
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [stage.route, stage.catalogue_id, stage.stage_id],
    )
  ).rows[0];
  if (!row) throw stagingConflict('The exact staging seal is unavailable');
  return {
    locator: { catalogueId: stage.catalogue_id, stageId: stage.stage_id },
    sourceRevisionId: stage.source_revision_id,
    expectedHeadRevisionId: stage.expected_head_revision_id,
    expectedPublicationId: stage.expected_publication_id,
    mode: stage.mode,
    inputVersion: row.input_version,
    candidateCount: row.candidate_count,
    sealedAt: row.sealed_at,
  };
}

/** Narrow future-builder interface. Pages are private and ordered by immutable
 * source rank; title is read from the pinned source so terminal redaction cannot
 * leave a second authored copy in staging. */
export async function readHostedPublicationStagingCandidates(
  client: AccessClient,
  actorInput: Actor,
  locator: HostedPublicationStagingLocator,
  afterSourceOrder: string | null,
  limit = HOSTED_PUBLICATION_STAGING_STEP_LIMIT,
): Promise<HostedPublicationStagingPage<HostedPublicationStagedCandidate>> {
  const actor = accountActor(actorInput);
  const route = validateLocator(locator);
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PUBLICATION_STAGING_STEP_LIMIT)
    throw stagingConflict('Staged output pages are limited to the Book step size');
  const after = afterSourceOrder === null ? -1n : BigInt(requireSafeSourceOrder(afterSourceOrder));
  const stage = await lockStage(client, locator);
  assertActorBinding(stage, actor);
  await requireSealedStage(client, stage);
  const rows = (
    await client.query<SourceRow>(
      `SELECT c.source_order::text,c.occurrence_id,c.parent_id,c.position::text,c.source_segment,
         c.kind,
         CASE WHEN c.source_segment='append' THEN a.title ELSE p.title END AS title,
         c.thread_id,c.post_id,c.target_revision_id,encode(c.body_sha256,'hex') AS sha256
       FROM content.hosted_publication_staging_candidate c
       JOIN content.hosted_publication_staging s
         ON s.route=c.route AND s.catalogue_id=c.catalogue_id AND s.stage_id=c.stage_id
       LEFT JOIN content.hosted_placement p
         ON c.source_segment IN ('snapshot','base') AND p.route=c.route AND p.catalogue_id=c.catalogue_id
           AND p.revision_id=CASE WHEN s.source_has_descriptor THEN s.source_base_revision_id ELSE s.source_revision_id END
           AND p.occurrence_id=c.occurrence_id
       LEFT JOIN content.hosted_append a
         ON c.source_segment='append' AND a.route=c.route AND a.catalogue_id=c.catalogue_id
           AND a.stream_id=s.source_base_revision_id AND a.occurrence_id=c.occurrence_id
           AND a.append_offset<=s.source_high_water
       WHERE c.route=$1 AND c.catalogue_id=$2 AND c.stage_id=$3 AND c.source_order>$4
       ORDER BY c.source_order LIMIT $5`,
      [route, locator.catalogueId, locator.stageId, after.toString(), limit + 1],
    )
  ).rows;
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => {
    const candidate = toCandidate(row);
    return {
      sourceOrder: candidate.sourceOrder,
      occurrenceId: candidate.occurrenceId,
      parentId: candidate.parentId,
      position: candidate.position,
      sourceSegment: candidate.sourceSegment,
      kind: candidate.kind,
      title: candidate.title,
      target: candidate.target,
    };
  });
  return { items, next: more ? items.at(-1)!.sourceOrder : null };
}

/** Read successful exact target metadata observations separately from the
 * selected membership output. They do not provide current authority to a builder. */
export async function readHostedPublicationStagingTargetObservations(
  client: AccessClient,
  actorInput: Actor,
  locator: HostedPublicationStagingLocator,
  after: OutputTargetCursor | null,
  limit = HOSTED_PUBLICATION_STAGING_STEP_LIMIT,
): Promise<HostedPublicationStagingPage<HostedPublicationTargetObservation, OutputTargetCursor>> {
  const actor = accountActor(actorInput);
  const route = validateLocator(locator);
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PUBLICATION_STAGING_STEP_LIMIT)
    throw stagingConflict('Staged target pages are limited to the Book step size');
  if (after) {
    const targetRoute = routeOf(after.threadId);
    if (
      targetRoute === null ||
      routeOf(after.postId) !== targetRoute ||
      routeOf(after.revisionId) !== targetRoute ||
      !/^[0-9a-f]{64}$/.test(after.sha256)
    )
      throw stagingConflict('Invalid exact target cursor');
  }
  const stage = await lockStage(client, locator);
  assertActorBinding(stage, actor);
  await requireSealedStage(client, stage);
  const rows = (
    await client.query<TargetIdentityRow & { author_account_id: string; licence: string; observed_at: string }>(
      `SELECT thread_id,post_id,target_revision_id,encode(body_sha256,'hex') AS sha256,
         author_account_id,licence,
         to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
       FROM content.hosted_publication_staging_target
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
         AND ($4::uuid IS NULL OR ROW(thread_id,post_id,target_revision_id,body_sha256)>
           ROW($4::uuid,$5::uuid,$6::uuid,decode($7,'hex')))
       ORDER BY thread_id,post_id,target_revision_id,body_sha256 LIMIT $8`,
      [
        route,
        locator.catalogueId,
        locator.stageId,
        after?.threadId ?? null,
        after?.postId ?? null,
        after?.revisionId ?? null,
        after?.sha256 ?? null,
        limit + 1,
      ],
    )
  ).rows;
  const more = rows.length > limit;
  const items: HostedPublicationTargetObservation[] = rows.slice(0, limit).map((row) => ({
    target: { threadId: row.thread_id, postId: row.post_id, revisionId: row.target_revision_id, sha256: row.sha256 },
    authorId: row.author_account_id,
    licence: row.licence,
    observedAt: row.observed_at,
  }));
  const last = items.at(-1);
  const next =
    more && last
      ? {
          threadId: last.target.threadId,
          postId: last.target.postId,
          revisionId: last.target.revisionId,
          sha256: last.target.sha256,
        }
      : null;
  return { items, next };
}

async function requireSealedStage(client: AccessClient, stageInput: StageRow): Promise<void> {
  const stage = await refreshExpiry(client, stageInput);
  if (stage.status === 'expired') throw new HostedPublicationStagingExpiredError();
  if (stage.status !== 'sealed') throw stagingConflict('Staged candidates are private until the exact seal exists');
  const seal = await client.query(
    `SELECT 1 FROM content.hosted_publication_staging_seal
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [stage.route, stage.catalogue_id, stage.stage_id],
  );
  if (!seal.rows.length) throw stagingConflict('Staged candidates are missing their exact seal');
}

/** Cancellation fences all later reads and writes. It does not delete a retained
 * source or candidate row and is idempotent for an already cancelled stage. */
export async function cancelHostedPublicationStaging(
  client: AccessClient,
  actorInput: Actor,
  locator: HostedPublicationStagingLocator,
): Promise<HostedPublicationStagingCheckpoint> {
  const actor = accountActor(actorInput);
  const stage = await lockStage(client, locator);
  assertActorBinding(stage, actor);
  const refreshed = await refreshExpiry(client, stage);
  if (refreshed.status === 'expired' || refreshed.status === 'cancelled' || refreshed.status === 'failed')
    return checkpoint(refreshed);
  await client.query(
    `UPDATE content.hosted_publication_staging SET status='cancelled'
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [stage.route, stage.catalogue_id, stage.stage_id],
  );
  return checkpoint(await stageSnapshot(client, stage.route, locator));
}

/** A read-only progress snapshot remains author/epoch bound and expires through
 * the same durable terminal state as processing and output reads. */
export async function readHostedPublicationStagingProgress(
  client: AccessClient,
  actorInput: Actor,
  locator: HostedPublicationStagingLocator,
): Promise<HostedPublicationStagingCheckpoint> {
  const actor = accountActor(actorInput);
  const stage = await lockStage(client, locator);
  assertActorBinding(stage, actor);
  return checkpoint(await refreshExpiry(client, stage));
}

async function advanceClosure(client: AccessClient, stage: StageRow): Promise<HostedPublicationStagingStepResult> {
  if (stage.mode !== 'selection' || stage.status !== 'closing')
    throw stagingConflict('Selection is not ready for closure');
  const after = BigInt(stage.closure_frontier);
  const limit = HOSTED_PUBLICATION_STAGING_STEP_LIMIT;
  const rows = (
    await client.query<QueryResultRow & { source_order: string; occurrence_id: string; parent_id: string | null }>(
      `SELECT source_order::text,occurrence_id,parent_id
       FROM content.hosted_publication_staging_candidate
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND source_order>$4
       ORDER BY source_order LIMIT $5`,
      [stage.route, stage.catalogue_id, stage.stage_id, after.toString(), limit + 1],
    )
  ).rows;
  const page = rows.slice(0, limit);
  const parentIds = [...new Set(page.flatMap((candidate) => (candidate.parent_id ? [candidate.parent_id] : [])))];
  const parents = parentIds.length
    ? (
        await client.query<QueryResultRow & { occurrence_id: string; kind: 'part' | 'chapter' }>(
          `SELECT occurrence_id,kind
           FROM content.hosted_publication_staging_candidate
           WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND occurrence_id=ANY($4::uuid[])`,
          [stage.route, stage.catalogue_id, stage.stage_id, parentIds],
        )
      ).rows
    : [];
  const present = new Map(parents.map((parent) => [parent.occurrence_id, parent.kind]));
  const missing = page.filter(
    (candidate) => candidate.parent_id !== null && present.get(candidate.parent_id) !== 'part',
  ).length;
  const checked = BigInt(stage.closure_checked_count) + BigInt(page.length);
  const candidateCount = BigInt(stage.candidate_count);
  const hasMore = rows.length > limit;
  const frontier = page.at(-1)?.source_order ?? stage.closure_frontier;
  const failed = missing > 0;
  const ready = !hasMore && !failed && checked === candidateCount;
  const inconsistent = !hasMore && !failed && checked !== candidateCount;
  const nextState = failed || inconsistent ? 'failed' : ready ? 'ready' : 'closing';
  await client.query(
    `UPDATE content.hosted_publication_staging
     SET closure_frontier=$4,closure_checked_count=closure_checked_count+$5,
         closure_missing_count=closure_missing_count+$6,status=$7,failure=$8
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [
      stage.route,
      stage.catalogue_id,
      stage.stage_id,
      frontier,
      page.length,
      missing,
      nextState,
      failed ? 'missing_ancestor' : inconsistent ? 'closure_incomplete' : null,
    ],
  );
  const updated = await stageSnapshot(client, stage.route, {
    catalogueId: stage.catalogue_id,
    stageId: stage.stage_id,
  });
  return { replayed: false, phase: 'closure', processed: page.length, progress: checkpoint(updated) };
}
