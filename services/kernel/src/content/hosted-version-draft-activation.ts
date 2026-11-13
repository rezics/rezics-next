import type { QueryResultRow } from 'pg';
import type { Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, hostedPostAuthorization, RevisionPreconditionError } from './commands.ts';
import type { HostedCommandDependencies } from './hosted-chapters-commands.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import type { HostedChapterTarget, HostedCommandContext } from './hosted-chapters-model.ts';
import { snapshot } from './reads.ts';
import {
  HostedVersionRevisionPointerChangedError,
  commitHostedVersionRevision,
  resolveHostedVersionRevision,
} from './hosted-version-revision.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionHead,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
  readHostedVersionSnapshot,
  stageHostedVersionSnapshotRoots,
  type HostedVersionWrite,
} from './hosted-version-store.ts';
import {
  HostedVersionHeadChangedError,
  InvalidHostedVersionIdentityError,
  type HostedVersionSnapshot,
} from './hosted-version-model.ts';
import {
  stageHostedVersionMaterializedNodes,
  stageHostedVersionMaterializedOccurrences,
  stageHostedVersionMaterializedSiblingRoots,
  type HostedVersionMaterializedNode,
  type HostedVersionMaterializedOccurrence,
} from './hosted-version-materialization.ts';
import type { HostedMigrationSourceIdentity } from './hosted-migration-input-model.ts';
import {
  HOSTED_VERSION_DRAFT_ACTIVATION_PAGE_MAX,
  HOSTED_VERSION_DRAFT_ACTIVATION_ZERO_ID,
  HostedVersionDraftActivationError,
  hostedVersionDraftActivationIndexKind,
  hostedVersionDraftActivationStartCursor,
  hostedVersionDraftActivationValue,
  sameHostedVersionDraftActivationCursor,
  type HostedVersionDraftActivationCommitResult,
  type HostedVersionDraftActivationCursor,
  type HostedVersionDraftActivationPageResult,
  type HostedVersionDraftActivationPageWork,
  type HostedVersionDraftActivationPhase,
  type HostedVersionDraftActivationState,
  type HostedVersionDraftActivationStatus,
  type HostedVersionDraftActivationValue,
} from './hosted-version-draft-activation-model.ts';
import occurrencePageSql from './hosted-version-draft-activation-occurrence-page.sql';
import nodePageSql from './hosted-version-draft-activation-node-page.sql';
import rootPageSql from './hosted-version-draft-activation-root-page.sql';
import subtreeReadSql from './hosted-version-draft-activation-subtree.sql';
import subtreeAddSql from './hosted-version-draft-activation-subtree-add.sql';

export {
  HOSTED_VERSION_DRAFT_ACTIVATION_PAGE_MAX,
  HostedVersionDraftActivationError,
  hostedVersionDraftActivationStartCursor,
  type HostedVersionDraftActivationCommitResult,
  type HostedVersionDraftActivationCursor,
  type HostedVersionDraftActivationPageResult,
  type HostedVersionDraftActivationState,
  type HostedVersionDraftActivationValue,
} from './hosted-version-draft-activation-model.ts';

type SqlWork = { statements: number; rowsReturned: number; rowsAffected: number };
type TrackedQuery<Row> = Readonly<{ rows: Row[]; rowCount: number | null }>;

type ActivationRow = Readonly<{
  route: number;
  catalogue_id: string;
  input_id: string;
  generation_id: string;
  revision_id: string;
  source_revision_id: string;
  expected_revision_id: string;
  source_kind: 'snapshot' | 'prefix';
  base_revision_id: string;
  base_placement_count: string;
  base_root_count: string;
  source_high_water: string;
  expected_placement_count: string;
  placement_count: string;
  chapter_count: string;
  root_count: string;
  sibling_root_id: string | null;
  preorder_root_id: string | null;
  chapter_root_id: string | null;
  phase: HostedVersionDraftActivationPhase;
  occurrence_after_ordinal: string;
  node_after_kind: string;
  node_after_id: string;
  root_null_done: boolean;
  root_after_parent_id: string;
  coverage_complete: boolean;
  status: HostedVersionDraftActivationStatus;
}>;

type BuilderSealRow = Readonly<{
  input_id: string;
  source_revision_id: string;
  source_kind: 'snapshot' | 'prefix';
  base_revision_id: string;
  base_placement_count: string;
  base_root_count: string;
  source_high_water: string;
  expected_placement_count: string;
  root_sibling_root_id: string | null;
  preorder_root_id: string | null;
  chapter_root_id: string | null;
  root_next_position: string;
  coverage_complete: boolean;
  status: 'building' | 'sealed';
}>;

type SourceFenceRow = Readonly<{
  head_revision_id: string;
  publication_id: string | null;
  input_state: string;
  coverage_complete: boolean;
  raw_visited: string;
  expected_placement_count: string;
}>;

type OccurrenceFactRow = Readonly<{
  source_ordinal: string;
  occurrence_id: string;
  parent_id: string | null;
  position: string;
  kind: 'part' | 'chapter';
  title: string | null;
  target_thread_id: string | null;
  target_post_id: string | null;
  target_revision_id: string | null;
  target_sha256: string | null;
}>;

type SequenceNodeRow = Readonly<{
  sequence_kind: 'siblings' | 'preorder' | 'chapters';
  node_id: string;
  left_id: string | null;
  right_id: string | null;
  tree_parent_id: string | null;
  height: number;
  node_count: string;
  chapter_weight: string;
  chapter_count: string;
}>;

type SiblingRootRow = Readonly<{
  parent_id: string | null;
  root_id: string;
  next_position: string;
}>;

type SubtreeRow = Readonly<{
  occurrence_id: string;
  subtree_size: string;
  chapter_count: string;
  subtree_height: number;
}>;

type PageReceiptRow = Readonly<{
  to_phase: HostedVersionDraftActivationPhase;
  to_occurrence_after_ordinal: string;
  to_node_after_kind: string;
  to_node_after_id: string;
  to_root_null_done: boolean;
  to_root_after_parent_id: string;
  coverage_complete: boolean;
  generation_sequence: string;
}>;

const BEGIN_KIND = 'content.hosted-catalogue.draft-activation.begin';
const PAGE_KIND = 'content.hosted-catalogue.draft-activation.page';
const COMMIT_KIND = 'content.hosted-catalogue.draft-activation.commit';

const ACTIVATION_SELECT = `
  SELECT a.route,a.catalogue_id,a.input_id,a.generation_id,a.revision_id,a.source_revision_id,
         a.expected_revision_id,b.source_kind,b.base_revision_id,b.base_placement_count::text,
         b.base_root_count::text,b.source_high_water::text,b.expected_placement_count::text,
         a.placement_count::text,a.chapter_count::text,a.root_count::text,a.sibling_root_id,
         a.preorder_root_id,a.chapter_root_id,a.phase,a.occurrence_after_ordinal::text,
         a.node_after_kind,a.node_after_id,a.root_null_done,a.root_after_parent_id,
         a.coverage_complete,a.status
  FROM content.hosted_version_draft_activation a
  JOIN content.hosted_version_builder b
    ON b.route=a.route AND b.catalogue_id=a.catalogue_id AND b.input_id=a.input_id
  WHERE a.route=$1 AND a.catalogue_id=$2 AND a.input_id=$3`;

function routeFor(catalogueId: string, extraId?: string): number {
  const route = routeOf(catalogueId);
  if (route === null || (extraId !== undefined && routeOf(extraId) !== route)) {
    throw new HostedVersionDraftActivationError(
      'source-mismatch',
      'Hosted version draft activation identities use different routes',
    );
  }
  return route;
}

function identityFromBuilder(catalogueId: string, row: BuilderSealRow): HostedMigrationSourceIdentity {
  return {
    catalogueId,
    revisionId: row.source_revision_id,
    kind: row.source_kind,
    baseRevisionId: row.base_revision_id,
    basePlacementCount: row.base_placement_count,
    baseRootCount: row.base_root_count,
    highWater: row.source_high_water,
    expectedPlacementCount: row.expected_placement_count,
  };
}

function identityFromActivation(row: ActivationRow): HostedMigrationSourceIdentity {
  return {
    catalogueId: row.catalogue_id,
    revisionId: row.source_revision_id,
    kind: row.source_kind,
    baseRevisionId: row.base_revision_id,
    basePlacementCount: row.base_placement_count,
    baseRootCount: row.base_root_count,
    highWater: row.source_high_water,
    expectedPlacementCount: row.expected_placement_count,
  };
}

function cursorFromRow(row: ActivationRow): HostedVersionDraftActivationCursor {
  return {
    phase: row.phase,
    occurrenceAfterOrdinal: row.occurrence_after_ordinal,
    nodeAfterKind: row.node_after_kind,
    nodeAfterId: row.node_after_id,
    rootNullDone: row.root_null_done,
    rootAfterParentId: row.root_after_parent_id,
  };
}

function stateFromRow(row: ActivationRow): HostedVersionDraftActivationState {
  return {
    inputId: row.input_id,
    catalogueId: row.catalogue_id,
    generationId: row.generation_id,
    revisionId: row.revision_id,
    source: identityFromActivation(row),
    expectedRevisionId: row.expected_revision_id,
    placementCount: BigInt(row.placement_count),
    chapterCount: BigInt(row.chapter_count),
    rootCount: BigInt(row.root_count),
    siblingRootId: row.sibling_root_id,
    preorderRootId: row.preorder_root_id,
    chapterRootId: row.chapter_root_id,
    cursor: cursorFromRow(row),
    coverageComplete: row.coverage_complete,
    status: row.status,
  };
}

function persistenceWork(work: SqlWork, written: Readonly<{ occurrences: number; nodes: number; roots: number }>) {
  return {
    sqlStatements: work.statements,
    sqlRowsReturned: work.rowsReturned,
    sqlRowsAffected: work.rowsAffected,
    occurrencesWritten: written.occurrences,
    nodesWritten: written.nodes,
    siblingRootsWritten: written.roots,
  };
}

async function trackedQuery<Row extends QueryResultRow>(
  tx: CommandTransaction,
  work: SqlWork,
  effect: 'read' | 'write',
  sql: string,
  values?: unknown[],
): Promise<TrackedQuery<Row>> {
  const result = await tx.query<Row>(sql, values as any[] | undefined);
  work.statements += 1;
  if (effect === 'read') work.rowsReturned += result.rows.length;
  else work.rowsAffected += result.rowCount ?? 0;
  return result;
}

async function readActivation(
  tx: CommandTransaction,
  work: SqlWork,
  catalogueId: string,
  inputId: string,
  lock: boolean,
): Promise<ActivationRow> {
  const route = routeFor(catalogueId, inputId);
  const row = (
    await trackedQuery<ActivationRow>(tx, work, 'read', ACTIVATION_SELECT + (lock ? ' FOR UPDATE OF a' : ''), [
      route,
      catalogueId,
      inputId,
    ])
  ).rows[0];
  if (!row) {
    throw new HostedVersionDraftActivationError(
      'source-mismatch',
      'Hosted version draft activation has no captured builder',
    );
  }
  return row;
}

function chapterTarget(row: OccurrenceFactRow): HostedChapterTarget | null {
  if (
    row.kind !== 'chapter' ||
    row.target_thread_id === null ||
    row.target_post_id === null ||
    row.target_revision_id === null ||
    row.target_sha256 === null
  ) {
    return null;
  }
  return {
    threadId: row.target_thread_id,
    postId: row.target_post_id,
    revisionId: row.target_revision_id,
    sha256: row.target_sha256,
  };
}

async function readSourceFence(
  tx: CommandTransaction,
  work: SqlWork,
  route: number,
  catalogueId: string,
  inputId: string,
): Promise<SourceFenceRow> {
  const row = (
    await trackedQuery<SourceFenceRow>(
      tx,
      work,
      'read',
      `SELECT c.head_revision_id,c.publication_id,i.state AS input_state,i.coverage_complete,
              i.raw_visited::text,i.expected_placement_count::text
       FROM content.hosted_catalogue c
       JOIN content.hosted_migration_input i
         ON i.route=c.route AND i.catalogue_id=c.catalogue_id
       WHERE c.route=$1 AND c.catalogue_id=$2 AND i.input_id=$3
       FOR SHARE OF c,i`,
      [route, catalogueId, inputId],
    )
  ).rows[0];
  if (!row) {
    throw new HostedVersionDraftActivationError(
      'unavailable-source',
      'Hosted version draft activation source is no longer available',
    );
  }
  return row;
}

function assertLiveSource(fence: SourceFenceRow, sourceRevisionId: string, expectedCount: string): void {
  if (fence.head_revision_id !== sourceRevisionId) {
    throw new HostedVersionDraftActivationError(
      'stale-source',
      'Hosted version draft activation source is no longer the current catalogue head',
    );
  }
  if (fence.input_state === 'cancelled' || fence.input_state === 'expired' || fence.input_state === 'source_erased') {
    throw new HostedVersionDraftActivationError(
      'unavailable-source',
      'Hosted version draft activation source was cancelled, expired or erased',
    );
  }
  if (!['complete', 'consumed'].includes(fence.input_state) || !fence.coverage_complete) {
    throw new HostedVersionDraftActivationError(
      'incomplete-source',
      'Hosted version draft activation source coverage is incomplete',
    );
  }
  if (fence.raw_visited !== expectedCount || fence.expected_placement_count !== expectedCount) {
    throw new HostedVersionDraftActivationError(
      'incomplete-source',
      'Hosted version draft activation source coverage does not match its identity',
    );
  }
}

async function readSealedBuilder(
  tx: CommandTransaction,
  work: SqlWork,
  route: number,
  catalogueId: string,
  inputId: string,
): Promise<BuilderSealRow> {
  const row = (
    await trackedQuery<BuilderSealRow>(
      tx,
      work,
      'read',
      `SELECT input_id,source_revision_id,source_kind,base_revision_id,base_placement_count::text,
              base_root_count::text,source_high_water::text,expected_placement_count::text,
              root_sibling_root_id,preorder_root_id,chapter_root_id,root_next_position::text,
              coverage_complete,status
       FROM content.hosted_version_builder
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3
       FOR UPDATE`,
      [route, catalogueId, inputId],
    )
  ).rows[0];
  if (!row) {
    throw new HostedVersionDraftActivationError(
      'source-mismatch',
      'Hosted version draft activation has no captured builder',
    );
  }
  if (row.status !== 'sealed' || !row.coverage_complete) {
    throw new HostedVersionDraftActivationError(
      'incomplete-source',
      'Hosted version builder has not sealed complete source coverage',
    );
  }
  return row;
}

function requireAccount(actor: Actor): asserts actor is Extract<Actor, { kind: 'account' }> {
  if (actor.kind !== 'account') throw new ContentNotFoundError();
}

async function admittedCatalogue(
  dependencies: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  context: HostedCommandContext,
  receipt: Readonly<{ kind: string; key: string; digest: Uint8Array }>,
) {
  requireAccount(actor);
  const observed = await snapshot(dependencies, catalogueId, context, (client) => hostedCatalogue(client, catalogueId));
  if (!observed.value || routeOf(observed.value.thread_id) !== routeOf(catalogueId)) throw new ContentNotFoundError();
  return {
    route: routeFor(catalogueId),
    threadId: observed.value.thread_id,
    authorization: hostedPostAuthorization(
      dependencies,
      actor,
      observed.value.thread_id,
      catalogueId,
      context,
      receipt,
    ),
  };
}

function mapCommandError(error: unknown): never {
  if (error instanceof HostedVersionDraftActivationError) {
    if (error.code === 'stale-source') throw new RevisionPreconditionError();
    if (error.code === 'unavailable-source') throw new ContentNotFoundError();
    throw error;
  }
  if (error instanceof HostedVersionRevisionPointerChangedError || error instanceof HostedVersionHeadChangedError) {
    throw new RevisionPreconditionError();
  }
  if (error instanceof InvalidHostedVersionIdentityError) {
    throw new HostedVersionDraftActivationError('source-mismatch', 'Invalid hosted version identity');
  }
  throw error;
}

export async function readHostedVersionDraftActivation(
  tx: CommandTransaction,
  catalogueId: string,
  inputId: string,
): Promise<HostedVersionDraftActivationState> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  return stateFromRow(await readActivation(tx, work, catalogueId, inputId, false));
}

/** Bind one sealed nonempty builder to a private draft generation. The live head is unchanged. */
export async function beginHostedVersionDraftActivation(
  tx: CommandTransaction,
  catalogueId: string,
  inputId: string,
): Promise<HostedVersionDraftActivationState> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const route = routeFor(catalogueId, inputId);
  const builder = await readSealedBuilder(tx, work, route, catalogueId, inputId);
  const identity = identityFromBuilder(catalogueId, builder);
  const expected = BigInt(identity.expectedPlacementCount);
  if (expected === 0n) {
    throw new HostedVersionDraftActivationError(
      'empty-source',
      'Empty catalogues activate on the first ordered point write',
    );
  }
  const fence = await readSourceFence(tx, work, route, catalogueId, inputId);
  assertLiveSource(fence, identity.revisionId, identity.expectedPlacementCount);
  const mapped = await resolveHostedVersionRevision(tx, catalogueId, identity.revisionId);
  if (mapped.kind === 'ordered') {
    throw new HostedVersionDraftActivationError(
      'activated',
      'Hosted version draft activation source is already an ordered draft',
    );
  }

  const existing = (
    await trackedQuery<ActivationRow>(tx, work, 'read', ACTIVATION_SELECT + ' FOR UPDATE OF a', [
      route,
      catalogueId,
      inputId,
    ])
  ).rows[0];
  if (existing) return stateFromRow(existing);

  const generationId = newId(route);
  const revisionId = newId(route);
  const snapshot = await createHostedVersionGeneration(tx, catalogueId, generationId, 'draft');
  if (snapshot.generationKind !== 'draft' || snapshot.sequence !== 0n) {
    throw new HostedVersionDraftActivationError('invalid-tree', 'Hosted version draft generation did not start empty');
  }
  const chapterCount =
    builder.preorder_root_id === null
      ? '0'
      : ((
          await trackedQuery<{ chapter_count: string }>(
            tx,
            work,
            'read',
            `SELECT chapter_count::text AS chapter_count
             FROM content.hosted_version_builder_sequence_node
             WHERE route=$1 AND catalogue_id=$2 AND input_id=$3
               AND sequence_kind='preorder' AND node_id=$4 AND tree_parent_id IS NULL`,
            [route, catalogueId, inputId, builder.preorder_root_id],
          )
        ).rows[0]?.chapter_count ?? '0');
  const cursor = hostedVersionDraftActivationStartCursor(identity.expectedPlacementCount);
  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_draft_activation
       (route,catalogue_id,input_id,generation_id,revision_id,source_revision_id,expected_revision_id,
        placement_count,chapter_count,root_count,sibling_root_id,preorder_root_id,chapter_root_id,
        phase,occurrence_after_ordinal,node_after_kind,node_after_id,root_null_done,root_after_parent_id,
        coverage_complete,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7::bigint,$8::bigint,$9::bigint,$10,$11,$12,
             $13,$14::bigint,$15,$16,$17,$18,false,'materializing',transaction_timestamp(),transaction_timestamp())`,
    [
      route,
      catalogueId,
      inputId,
      generationId,
      revisionId,
      identity.revisionId,
      identity.expectedPlacementCount,
      chapterCount,
      builder.root_next_position,
      builder.root_sibling_root_id,
      builder.preorder_root_id,
      builder.chapter_root_id,
      cursor.phase,
      cursor.occurrenceAfterOrdinal,
      cursor.nodeAfterKind,
      cursor.nodeAfterId,
      cursor.rootNullDone,
      cursor.rootAfterParentId,
    ],
  );
  return stateFromRow(await readActivation(tx, work, catalogueId, inputId, true));
}

async function readPageReceipt(
  tx: CommandTransaction,
  work: SqlWork,
  row: ActivationRow,
  from: HostedVersionDraftActivationCursor,
): Promise<PageReceiptRow | null> {
  return (
    (
      await trackedQuery<PageReceiptRow>(
        tx,
        work,
        'read',
        `SELECT to_phase,to_occurrence_after_ordinal::text,to_node_after_kind,to_node_after_id,
                to_root_null_done,to_root_after_parent_id,coverage_complete,generation_sequence::text
         FROM content.hosted_version_draft_activation_page
         WHERE route=$1 AND catalogue_id=$2 AND input_id=$3
           AND from_phase=$4 AND from_occurrence_after_ordinal=$5::bigint
           AND from_node_after_kind=$6 AND from_node_after_id=$7
           AND from_root_null_done=$8 AND from_root_after_parent_id=$9`,
        [
          row.route,
          row.catalogue_id,
          row.input_id,
          from.phase,
          from.occurrenceAfterOrdinal,
          from.nodeAfterKind,
          from.nodeAfterId,
          from.rootNullDone,
          from.rootAfterParentId,
        ],
      )
    ).rows[0] ?? null
  );
}

async function readSubtree(
  tx: CommandTransaction,
  work: SqlWork,
  row: ActivationRow,
  occurrenceId: string,
): Promise<SubtreeRow | null> {
  return (
    (
      await trackedQuery<SubtreeRow>(tx, work, 'read', subtreeReadSql.sql, [
        row.route,
        row.catalogue_id,
        row.input_id,
        occurrenceId,
      ])
    ).rows[0] ?? null
  );
}

async function addParentSubtree(
  tx: CommandTransaction,
  work: SqlWork,
  row: ActivationRow,
  parentId: string,
  value: HostedVersionDraftActivationValue,
  subtreeSize: bigint,
): Promise<void> {
  await trackedQuery(tx, work, 'write', subtreeAddSql.sql, [
    row.route,
    row.catalogue_id,
    row.input_id,
    parentId,
    subtreeSize.toString(),
    value.chapterCount.toString(),
    String(value.subtreeHeight),
  ]);
}

function occurrenceValue(row: OccurrenceFactRow, subtree: SubtreeRow | null): HostedVersionDraftActivationValue {
  const childSize = subtree === null ? 0n : BigInt(subtree.subtree_size);
  const childChapters = subtree === null ? 0n : BigInt(subtree.chapter_count);
  const childHeight = subtree === null ? -1 : subtree.subtree_height;
  const selfChapters = row.kind === 'chapter' ? 1n : 0n;
  const height = row.kind === 'chapter' ? 0 : childHeight < 0 ? 0 : childHeight + 1;
  return hostedVersionDraftActivationValue({
    kind: row.kind,
    title: row.title,
    subtreeHeight: height,
    chapterCount: selfChapters + childChapters,
    target: chapterTarget(row),
  });
}

async function stageOccurrencePage(
  tx: CommandTransaction,
  work: SqlWork,
  row: ActivationRow,
  write: HostedVersionWrite<HostedVersionDraftActivationValue>,
  cursor: HostedVersionDraftActivationCursor,
): Promise<{ cursor: HostedVersionDraftActivationCursor; count: number }> {
  const facts = (
    await trackedQuery<OccurrenceFactRow>(tx, work, 'read', occurrencePageSql.sql, [
      row.route,
      row.catalogue_id,
      row.input_id,
      cursor.occurrenceAfterOrdinal,
      HOSTED_VERSION_DRAFT_ACTIVATION_PAGE_MAX,
    ])
  ).rows;
  if (facts.length === 0) {
    return {
      cursor: { ...cursor, phase: 'nodes', occurrenceAfterOrdinal: '-1' },
      count: 0,
    };
  }
  const materialized: HostedVersionMaterializedOccurrence<HostedVersionDraftActivationValue>[] = [];
  for (const fact of facts) {
    const subtree = await readSubtree(tx, work, row, fact.occurrence_id);
    const childSize = subtree === null ? 0n : BigInt(subtree.subtree_size);
    const value = occurrenceValue(fact, subtree);
    const subtreeSize = 1n + childSize;
    if (value.title !== null && fact.title !== value.title) {
      throw new HostedVersionDraftActivationError('invalid-tree', 'Hosted version activation changed a source title');
    }
    materialized.push({
      occurrenceId: fact.occurrence_id,
      state: { parentOccurrenceId: fact.parent_id, subtreeSize, value },
    });
    if (fact.parent_id !== null) await addParentSubtree(tx, work, row, fact.parent_id, value, subtreeSize);
  }
  stageHostedVersionMaterializedOccurrences(write, materialized);
  const last = facts[facts.length - 1]!;
  const exhausted = facts.length < HOSTED_VERSION_DRAFT_ACTIVATION_PAGE_MAX || last.source_ordinal === '0';
  return {
    cursor: exhausted
      ? { ...cursor, phase: 'nodes', occurrenceAfterOrdinal: last.source_ordinal }
      : { ...cursor, occurrenceAfterOrdinal: last.source_ordinal },
    count: facts.length,
  };
}

async function occurrenceValueAt(
  tx: CommandTransaction,
  snapshot: HostedVersionSnapshot,
  occurrenceId: string,
  pending: Map<string, HostedVersionDraftActivationValue>,
): Promise<HostedVersionDraftActivationValue> {
  const staged = pending.get(occurrenceId);
  if (staged) return staged;
  const stored = await readHostedVersionOccurrence<HostedVersionDraftActivationValue>(tx, snapshot, occurrenceId);
  if (!stored) {
    throw new HostedVersionDraftActivationError(
      'invalid-tree',
      'Hosted version activation sequence node is missing its occurrence value',
    );
  }
  return stored.value;
}

async function stageNodePage(
  tx: CommandTransaction,
  work: SqlWork,
  row: ActivationRow,
  write: HostedVersionWrite<HostedVersionDraftActivationValue>,
  snapshot: HostedVersionSnapshot,
  cursor: HostedVersionDraftActivationCursor,
  pending: Map<string, HostedVersionDraftActivationValue>,
): Promise<{ cursor: HostedVersionDraftActivationCursor; count: number }> {
  const nodes = (
    await trackedQuery<SequenceNodeRow>(tx, work, 'read', nodePageSql.sql, [
      row.route,
      row.catalogue_id,
      row.input_id,
      cursor.nodeAfterKind,
      cursor.nodeAfterId,
      HOSTED_VERSION_DRAFT_ACTIVATION_PAGE_MAX,
    ])
  ).rows;
  if (nodes.length === 0) {
    return {
      cursor: {
        ...cursor,
        phase: 'roots',
        nodeAfterKind: 'siblings',
        nodeAfterId: HOSTED_VERSION_DRAFT_ACTIVATION_ZERO_ID,
      },
      count: 0,
    };
  }
  const materialized: HostedVersionMaterializedNode<HostedVersionDraftActivationValue>[] = [];
  for (const node of nodes) {
    const value = await occurrenceValueAt(tx, snapshot, node.node_id, pending);
    materialized.push({
      indexKind: hostedVersionDraftActivationIndexKind(node.sequence_kind),
      id: node.node_id,
      value,
      leftId: node.left_id,
      rightId: node.right_id,
      treeParentId: node.tree_parent_id,
      height: node.height,
      count: BigInt(node.node_count),
      chapterWeight: BigInt(node.chapter_weight) as 0n | 1n,
      chapterCount: BigInt(node.chapter_count),
    });
  }
  stageHostedVersionMaterializedNodes(write, materialized);
  const last = nodes[nodes.length - 1]!;
  const exhausted = nodes.length < HOSTED_VERSION_DRAFT_ACTIVATION_PAGE_MAX;
  return {
    cursor: exhausted
      ? {
          ...cursor,
          phase: 'roots',
          nodeAfterKind: last.sequence_kind,
          nodeAfterId: last.node_id,
        }
      : { ...cursor, nodeAfterKind: last.sequence_kind, nodeAfterId: last.node_id },
    count: nodes.length,
  };
}

async function stageRootPage(
  tx: CommandTransaction,
  work: SqlWork,
  row: ActivationRow,
  write: HostedVersionWrite<HostedVersionDraftActivationValue>,
  cursor: HostedVersionDraftActivationCursor,
): Promise<{ cursor: HostedVersionDraftActivationCursor; count: number; complete: boolean }> {
  const roots = (
    await trackedQuery<SiblingRootRow>(tx, work, 'read', rootPageSql.sql, [
      row.route,
      row.catalogue_id,
      row.input_id,
      cursor.rootNullDone,
      cursor.rootAfterParentId,
      HOSTED_VERSION_DRAFT_ACTIVATION_PAGE_MAX,
    ])
  ).rows;
  if (roots.length === 0) {
    return {
      cursor: {
        ...cursor,
        phase: 'complete',
        rootNullDone: true,
        rootAfterParentId: HOSTED_VERSION_DRAFT_ACTIVATION_ZERO_ID,
      },
      count: 0,
      complete: true,
    };
  }
  stageHostedVersionMaterializedSiblingRoots(
    write,
    roots.map((root) => ({ parentId: root.parent_id, rootId: root.root_id })),
  );
  const last = roots[roots.length - 1]!;
  const exhausted = roots.length < HOSTED_VERSION_DRAFT_ACTIVATION_PAGE_MAX;
  return {
    cursor: {
      ...cursor,
      phase: exhausted ? 'complete' : 'roots',
      rootNullDone: true,
      rootAfterParentId: last.parent_id ?? HOSTED_VERSION_DRAFT_ACTIVATION_ZERO_ID,
    },
    count: roots.length,
    complete: exhausted,
  };
}

async function persistActivationCursor(
  tx: CommandTransaction,
  work: SqlWork,
  row: ActivationRow,
  from: HostedVersionDraftActivationCursor,
  to: HostedVersionDraftActivationCursor,
  written: Readonly<{ occurrences: number; nodes: number; roots: number }>,
  complete: boolean,
  sequence: bigint,
): Promise<void> {
  await trackedQuery(
    tx,
    work,
    'write',
    `UPDATE content.hosted_version_draft_activation
     SET phase=$4,occurrence_after_ordinal=$5::bigint,node_after_kind=$6,node_after_id=$7,
         root_null_done=$8,root_after_parent_id=$9,coverage_complete=$10,
         status=$11,updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND status='materializing'`,
    [
      row.route,
      row.catalogue_id,
      row.input_id,
      to.phase,
      to.occurrenceAfterOrdinal,
      to.nodeAfterKind,
      to.nodeAfterId,
      to.rootNullDone,
      to.rootAfterParentId,
      complete,
      complete ? 'complete' : 'materializing',
    ],
  );
  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_draft_activation_page
       (route,catalogue_id,input_id,from_phase,from_occurrence_after_ordinal,from_node_after_kind,
        from_node_after_id,from_root_null_done,from_root_after_parent_id,to_phase,
        to_occurrence_after_ordinal,to_node_after_kind,to_node_after_id,to_root_null_done,
        to_root_after_parent_id,occurrences_written,nodes_written,sibling_roots_written,
        coverage_complete,generation_sequence,created_at)
     VALUES ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11::bigint,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             transaction_timestamp())`,
    [
      row.route,
      row.catalogue_id,
      row.input_id,
      from.phase,
      from.occurrenceAfterOrdinal,
      from.nodeAfterKind,
      from.nodeAfterId,
      from.rootNullDone,
      from.rootAfterParentId,
      to.phase,
      to.occurrenceAfterOrdinal,
      to.nodeAfterKind,
      to.nodeAfterId,
      to.rootNullDone,
      to.rootAfterParentId,
      written.occurrences,
      written.nodes,
      written.roots,
      complete,
      sequence.toString(),
    ],
  );
}

/** Copy one bounded page of sealed builder facts into the private generation. */
export async function applyHostedVersionDraftActivationPage(
  tx: CommandTransaction,
  catalogueId: string,
  inputId: string,
  fromCursor?: HostedVersionDraftActivationCursor,
): Promise<HostedVersionDraftActivationPageResult> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const row = await readActivation(tx, work, catalogueId, inputId, true);
  const state = stateFromRow(row);
  const fence = await readSourceFence(tx, work, row.route, catalogueId, inputId);
  assertLiveSource(fence, row.source_revision_id, row.expected_placement_count);
  if (row.status === 'complete' || row.status === 'activated') {
    const snapshot = await readHostedVersionHead(tx, catalogueId, row.generation_id);
    return { replayed: true, state, snapshot, work: persistenceWork(work, { occurrences: 0, nodes: 0, roots: 0 }) };
  }

  const requested = fromCursor ?? state.cursor;
  const receipt = await readPageReceipt(tx, work, row, requested);
  if (receipt) {
    const snapshot = await readHostedVersionHead(tx, catalogueId, row.generation_id);
    return { replayed: true, state, snapshot, work: persistenceWork(work, { occurrences: 0, nodes: 0, roots: 0 }) };
  }
  if (!sameHostedVersionDraftActivationCursor(requested, state.cursor)) {
    throw new HostedVersionDraftActivationError(
      'stale-frontier',
      'Hosted version draft activation page does not continue the retained frontier',
    );
  }

  const current = await readHostedVersionHead(tx, catalogueId, row.generation_id);
  if (!current || current.generationKind !== 'draft') {
    throw new HostedVersionDraftActivationError('invalid-tree', 'Hosted version draft generation is missing');
  }
  const write = createHostedVersionWrite<HostedVersionDraftActivationValue>(tx, current);
  const pending = new Map<string, HostedVersionDraftActivationValue>();
  let cursor = state.cursor;
  let occurrencesWritten = 0;
  let nodesWritten = 0;
  let siblingRootsWritten = 0;
  let complete = false;

  if (cursor.phase === 'occurrences') {
    const page = await stageOccurrencePage(tx, work, row, write, cursor);
    occurrencesWritten = page.count;
    cursor = page.cursor;
    if (page.count === 0 && cursor.phase === 'nodes') {
      const nodes = await stageNodePage(tx, work, row, write, current, cursor, pending);
      nodesWritten = nodes.count;
      cursor = nodes.cursor;
    }
  } else if (cursor.phase === 'nodes') {
    const page = await stageNodePage(tx, work, row, write, current, cursor, pending);
    nodesWritten = page.count;
    cursor = page.cursor;
    if (page.count === 0 && cursor.phase === 'roots') {
      const roots = await stageRootPage(tx, work, row, write, cursor);
      siblingRootsWritten = roots.count;
      cursor = roots.cursor;
      complete = roots.complete;
    }
  } else if (cursor.phase === 'roots') {
    const page = await stageRootPage(tx, work, row, write, cursor);
    siblingRootsWritten = page.count;
    cursor = page.cursor;
    complete = page.complete;
  } else {
    complete = true;
  }

  if (occurrencesWritten + nodesWritten + siblingRootsWritten === 0 && !complete) {
    throw new HostedVersionDraftActivationError(
      'incomplete-source',
      'Hosted version draft activation page made no frontier progress',
    );
  }

  if (complete) {
    stageHostedVersionSnapshotRoots(write, {
      preorderRootId: row.preorder_root_id,
      chapterRootId: row.chapter_root_id,
      placementCount: BigInt(row.placement_count),
      chapterCount: BigInt(row.chapter_count),
    });
  } else {
    stageHostedVersionSnapshotRoots(write, {
      preorderRootId: current.preorderRootId,
      chapterRootId: current.chapterRootId,
      placementCount: current.placementCount,
      chapterCount: current.chapterCount,
    });
  }

  const next = await commitHostedVersionWrite(tx, write);
  await persistActivationCursor(
    tx,
    work,
    row,
    requested,
    cursor,
    { occurrences: occurrencesWritten, nodes: nodesWritten, roots: siblingRootsWritten },
    complete,
    next.sequence,
  );
  const after = await readActivation(tx, work, catalogueId, inputId, false);
  return {
    replayed: false,
    state: stateFromRow(after),
    snapshot: next,
    work: persistenceWork(work, {
      occurrences: occurrencesWritten,
      nodes: nodesWritten,
      roots: siblingRootsWritten,
    }),
  };
}

async function verifyCompleteCandidate(
  tx: CommandTransaction,
  work: SqlWork,
  row: ActivationRow,
  snapshot: HostedVersionSnapshot,
): Promise<void> {
  if (
    snapshot.generationId !== row.generation_id ||
    snapshot.generationKind !== 'draft' ||
    snapshot.placementCount !== BigInt(row.placement_count) ||
    snapshot.chapterCount !== BigInt(row.chapter_count) ||
    snapshot.preorderRootId !== row.preorder_root_id ||
    snapshot.chapterRootId !== row.chapter_root_id
  ) {
    throw new HostedVersionDraftActivationError(
      'invalid-tree',
      'Hosted version draft activation snapshot does not match sealed builder roots',
    );
  }
  const siblingRoot = await readHostedVersionSiblingRoot(tx, snapshot, null);
  if ((siblingRoot?.rootNodeId ?? null) !== row.sibling_root_id) {
    throw new HostedVersionDraftActivationError(
      'invalid-tree',
      'Hosted version draft activation sibling root does not match the sealed builder',
    );
  }
  const index = createHostedVersionWrite<HostedVersionDraftActivationValue>(tx, snapshot);
  const preorder = row.preorder_root_id
    ? await hostedVersionSequence(index, 'preorder').readNode(row.preorder_root_id)
    : null;
  const chapters = row.chapter_root_id
    ? await hostedVersionSequence(index, 'chapter').readNode(row.chapter_root_id)
    : null;
  const siblings = row.sibling_root_id
    ? await hostedVersionSequence(index, 'sibling').readNode(row.sibling_root_id)
    : null;
  if (
    preorder === null ||
    preorder.treeParentId !== null ||
    preorder.count !== BigInt(row.placement_count) ||
    preorder.chapterCount !== BigInt(row.chapter_count) ||
    (row.chapter_count === '0'
      ? chapters !== null
      : chapters === null || chapters.count !== BigInt(row.chapter_count)) ||
    siblings === null ||
    siblings.treeParentId !== null ||
    siblings.count !== BigInt(row.root_count)
  ) {
    throw new HostedVersionDraftActivationError(
      'incomplete-source',
      'Hosted version draft activation coverage does not match the sealed builder',
    );
  }
}

/** Record the immutable structure revision and CAS the draft head after verified coverage. */
export async function commitHostedVersionDraftActivation(
  tx: CommandTransaction,
  catalogueId: string,
  inputId: string,
  recorded: Readonly<{ recordedTransactionId: string; recordedAt: string }>,
): Promise<HostedVersionDraftActivationCommitResult> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const row = await readActivation(tx, work, catalogueId, inputId, true);
  const fence = await readSourceFence(tx, work, row.route, catalogueId, inputId);
  assertLiveSource(fence, row.source_revision_id, row.expected_placement_count);
  const builder = await readSealedBuilder(tx, work, row.route, catalogueId, inputId);
  if (builder.source_revision_id !== row.source_revision_id) {
    throw new HostedVersionDraftActivationError(
      'source-mismatch',
      'Hosted version draft activation builder changed its captured source',
    );
  }
  const currentHead = (
    await trackedQuery<{ head_revision_id: string; publication_id: string | null }>(
      tx,
      work,
      'read',
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2 FOR UPDATE`,
      [row.route, catalogueId],
    )
  ).rows[0];
  if (!currentHead) throw new ContentNotFoundError();
  const publicationId = fence.publication_id;

  if (row.status === 'activated') {
    const resolved = await resolveHostedVersionRevision(tx, catalogueId, row.revision_id);
    if (resolved.kind !== 'ordered' || resolved.snapshot.generationKind !== 'draft') {
      throw new HostedVersionDraftActivationError(
        'invalid-tree',
        'Hosted version draft activation revision is missing its ordered descriptor',
      );
    }
    const snapshot = await readHostedVersionSnapshot(
      tx,
      catalogueId,
      resolved.snapshot.generationId,
      resolved.snapshot.sequence,
    );
    if (!snapshot) throw new ContentNotFoundError();
    return { replayed: true, revisionId: row.revision_id, snapshot, state: stateFromRow(row) };
  }
  if (row.status !== 'complete' || !row.coverage_complete || row.phase !== 'complete') {
    throw new HostedVersionDraftActivationError(
      'incomplete-source',
      'Hosted version draft activation has not recorded exact coverage',
    );
  }
  if (currentHead.head_revision_id !== row.expected_revision_id) {
    throw new HostedVersionDraftActivationError(
      'stale-source',
      'Hosted version draft activation source is no longer the current catalogue head',
    );
  }
  if (currentHead.publication_id !== publicationId) {
    throw new HostedVersionDraftActivationError(
      'stale-source',
      'Hosted version draft activation cannot change the public pointer',
    );
  }

  const snapshot = await readHostedVersionHead(tx, catalogueId, row.generation_id);
  if (!snapshot) {
    throw new HostedVersionDraftActivationError('invalid-tree', 'Hosted version draft generation is missing');
  }
  await verifyCompleteCandidate(tx, work, row, snapshot);
  if (snapshot.generationKind !== 'draft') {
    throw new HostedVersionDraftActivationError(
      'invalid-tree',
      'Hosted version draft activation requires a draft generation',
    );
  }

  await commitHostedVersionRevision(tx, {
    revisionKind: 'structure',
    revisionId: row.revision_id,
    snapshot: {
      route: snapshot.route,
      catalogueId: snapshot.catalogueId,
      generationId: snapshot.generationId,
      generationKind: 'draft',
      sequence: snapshot.sequence,
    },
    expectedDraftRevisionId: row.expected_revision_id,
    recordedTransactionId: recorded.recordedTransactionId,
    recordedAt: recorded.recordedAt,
  });

  await trackedQuery(
    tx,
    work,
    'write',
    `UPDATE content.hosted_version_draft_activation
     SET status='activated',updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND status='complete'`,
    [row.route, catalogueId, inputId],
  );
  await trackedQuery(
    tx,
    work,
    'write',
    `UPDATE content.hosted_migration_input
     SET state='consumed',updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND state='complete'`,
    [row.route, catalogueId, inputId],
  );
  const after = await readActivation(tx, work, catalogueId, inputId, false);
  const unchanged = (
    await trackedQuery<{ publication_id: string | null }>(
      tx,
      work,
      'read',
      `SELECT publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
      [row.route, catalogueId],
    )
  ).rows[0];
  if (unchanged?.publication_id !== publicationId) {
    throw new HostedVersionDraftActivationError(
      'stale-source',
      'Hosted version draft activation changed the public pointer',
    );
  }
  return { replayed: false, revisionId: row.revision_id, snapshot, state: stateFromRow(after) };
}

export async function beginHostedVersionDraftActivationCommand(
  dependencies: HostedCommandDependencies,
  actor: Actor,
  input: Readonly<{ catalogueId: string; inputId: string; expectedRevisionId: string }>,
  context: HostedCommandContext,
) {
  const route = routeFor(input.catalogueId, input.inputId);
  if (routeOf(input.expectedRevisionId) !== route) {
    throw new HostedVersionDraftActivationError('source-mismatch', 'Invalid hosted version activation source revision');
  }
  const receipt = {
    kind: BEGIN_KIND,
    key: context.idempotencyKey,
    digest: requestDigest(BEGIN_KIND, actor, input),
  };
  const admission = await admittedCatalogue(dependencies, actor, input.catalogueId, context, receipt);
  return runCommand<HostedVersionDraftActivationState>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt,
      authorization: admission.authorization,
    },
    async (tx) => {
      try {
        const current = await hostedCatalogue(tx, input.catalogueId, true);
        if (!current || current.thread_id !== admission.threadId) throw new ContentNotFoundError();
        if (current.head_revision_id !== input.expectedRevisionId) throw new RevisionPreconditionError();
        return noEffect(await beginHostedVersionDraftActivation(tx, input.catalogueId, input.inputId));
      } catch (error) {
        mapCommandError(error);
      }
    },
  );
}

export async function pageHostedVersionDraftActivationCommand(
  dependencies: HostedCommandDependencies,
  actor: Actor,
  input: Readonly<{ catalogueId: string; inputId: string }>,
  context: HostedCommandContext,
) {
  const route = routeFor(input.catalogueId, input.inputId);
  const receipt = {
    kind: PAGE_KIND,
    key: context.idempotencyKey,
    digest: requestDigest(PAGE_KIND, actor, input),
  };
  const admission = await admittedCatalogue(dependencies, actor, input.catalogueId, context, receipt);
  return runCommand<HostedVersionDraftActivationPageResult>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt,
      authorization: admission.authorization,
    },
    async (tx) => {
      try {
        const current = await hostedCatalogue(tx, input.catalogueId, true);
        if (!current || current.thread_id !== admission.threadId) throw new ContentNotFoundError();
        return noEffect(await applyHostedVersionDraftActivationPage(tx, input.catalogueId, input.inputId));
      } catch (error) {
        mapCommandError(error);
      }
    },
  );
}

export async function commitHostedVersionDraftActivationCommand(
  dependencies: HostedCommandDependencies,
  actor: Actor,
  input: Readonly<{ catalogueId: string; inputId: string; expectedRevisionId: string }>,
  context: HostedCommandContext,
) {
  const route = routeFor(input.catalogueId, input.inputId);
  if (routeOf(input.expectedRevisionId) !== route) {
    throw new HostedVersionDraftActivationError('source-mismatch', 'Invalid hosted version activation source revision');
  }
  const receipt = {
    kind: COMMIT_KIND,
    key: context.idempotencyKey,
    digest: requestDigest(COMMIT_KIND, actor, input),
  };
  const admission = await admittedCatalogue(dependencies, actor, input.catalogueId, context, receipt);
  return runCommand<HostedVersionDraftActivationCommitResult>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt,
      authorization: admission.authorization,
    },
    async (tx, { transactionId, time }) => {
      try {
        const current = await hostedCatalogue(tx, input.catalogueId, true);
        if (!current || current.thread_id !== admission.threadId) throw new ContentNotFoundError();
        if (current.head_revision_id !== input.expectedRevisionId) throw new RevisionPreconditionError();
        const committed = await commitHostedVersionDraftActivation(tx, input.catalogueId, input.inputId, {
          recordedTransactionId: transactionId,
          recordedAt: authoritativeTimeValue(time),
        });
        if (committed.replayed) return noEffect(committed);
        return {
          value: committed,
          events: [
            {
              type: 'com.rezics.content.hosted-catalogue.revise.v1',
              subject: input.catalogueId,
              data: { catalogueId: input.catalogueId, revisionId: committed.revisionId },
            },
          ],
        };
      } catch (error) {
        mapCommandError(error);
      }
    },
  );
}

export function sameHostedVersionDraftActivationFrontier(
  left: HostedVersionDraftActivationCursor,
  right: HostedVersionDraftActivationCursor,
): boolean {
  return sameHostedVersionDraftActivationCursor(left, right);
}
