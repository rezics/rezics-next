import type { QueryResultRow } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { newId, routeOf } from '../route/route.ts';
import type { HostedChapterTarget } from './hosted-chapters-model.ts';
import {
  HOSTED_VERSION_PUBLIC_BASELINE_PAGE_MAX,
  HOSTED_VERSION_PUBLIC_BASELINE_ZERO_ID,
  HostedVersionPublicBaselineError,
  hostedVersionPublicBaselineStartCursor,
  sameHostedVersionPublicBaselineCursor,
  type HostedVersionPublicBaselineCursor,
  type HostedVersionPublicBaselinePageResult,
  type HostedVersionPublicBaselinePageWork,
  type HostedVersionPublicBaselineResult,
  type HostedVersionPublicBaselineSealFacts,
  type HostedVersionPublicBaselineState,
} from './hosted-version-public-baseline-model.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionHead,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
  type HostedVersionWrite,
} from './hosted-version-store.ts';
import type { HostedVersionSnapshot } from './hosted-version-model.ts';
import {
  stageHostedVersionMaterializedNodes,
  stageHostedVersionMaterializedOccurrences,
  stageHostedVersionMaterializedSiblingRoots,
} from './hosted-version-materialization.ts';
import type {
  HostedVersionMaterializedNode,
  HostedVersionMaterializedOccurrence,
} from './hosted-version-materialization.ts';
import type { HostedVersionPublicationStoredValue } from './hosted-version-publication-write-model.ts';

export {
  HOSTED_VERSION_PUBLIC_BASELINE_PAGE_MAX,
  HostedVersionPublicBaselineError,
  type HostedVersionPublicBaselineCursor,
  type HostedVersionPublicBaselinePageResult,
  type HostedVersionPublicBaselineResult,
  type HostedVersionPublicBaselineSealFacts,
  type HostedVersionPublicBaselineState,
} from './hosted-version-public-baseline-model.ts';

type SqlWork = { statements: number; rowsReturned: number; rowsAffected: number };
type TrackedQuery<Row> = Readonly<{ rows: Row[]; rowCount: number | null }>;
type SequenceKind = 'siblings' | 'preorder' | 'chapters';

type BaselineRow = Readonly<{
  route: number;
  catalogue_id: string;
  build_id: string;
  generation_id: string;
  thread_id: string;
  source_publication_id: string;
  actor_binding: Uint8Array;
  placement_count: string;
  root_count: string;
  chapter_count: string;
  sibling_root_id: string | null;
  preorder_root_id: string | null;
  chapter_root_id: string | null;
  phase: HostedVersionPublicBaselineState['cursor']['phase'];
  occurrence_after_ordinal: string;
  node_after_kind: string;
  node_after_id: string;
  root_null_done: boolean;
  root_after_parent_id: string;
  occurrences_written: string;
  nodes_written: string;
  sibling_roots_written: string;
  coverage_complete: boolean;
  status: HostedVersionPublicBaselineState['status'];
}>;

type BuilderSourceRow = Readonly<{
  route: number;
  catalogue_id: string;
  input_id: string;
  source_revision_id: string;
  source_kind: 'snapshot' | 'prefix' | 'public';
  expected_placement_count: string;
  root_sibling_root_id: string | null;
  preorder_root_id: string | null;
  chapter_root_id: string | null;
  root_next_position: string;
  coverage_complete: boolean;
  source_current: boolean;
  status: 'building' | 'sealed';
  publication_id: string | null;
  thread_id: string | null;
  actor_binding: Uint8Array | null;
}>;

type PointerRow = Readonly<{ publication_id: string | null; thread_id: string }>;

type OccurrenceFactRow = Readonly<{
  source_ordinal: string;
  occurrence_id: string;
  parent_id: string | null;
  kind: 'part' | 'chapter';
  title: string | null;
  target_thread_id: string | null;
  target_post_id: string | null;
  target_revision_id: string | null;
  target_sha256: string | null;
}>;

type SequenceNodeRow = Readonly<{
  sequence_kind: SequenceKind;
  node_id: string;
  left_id: string | null;
  right_id: string | null;
  tree_parent_id: string | null;
  height: number;
  node_count: string;
  chapter_weight: string;
  chapter_count: string;
}>;

type SiblingRootRow = Readonly<{ parent_id: string | null; root_id: string; next_position: string }>;
type SubtreeRow = Readonly<{ subtree_size: string; chapter_count: string }>;
type PageReceiptRow = Readonly<{ coverage_complete: boolean; generation_sequence: string }>;

const BASELINE_SELECT = `
  SELECT route,catalogue_id,build_id,generation_id,thread_id,source_publication_id,actor_binding,
         placement_count::text,root_count::text,chapter_count::text,sibling_root_id,preorder_root_id,
         chapter_root_id,phase,occurrence_after_ordinal::text,node_after_kind,node_after_id,
         root_null_done,root_after_parent_id,occurrences_written::text,nodes_written::text,
         sibling_roots_written::text,coverage_complete,status
  FROM content.hosted_version_public_baseline
  WHERE route=$1 AND catalogue_id=$2 AND build_id=$3`;

function routeFor(catalogueId: string, buildId?: string): number {
  const route = routeOf(catalogueId);
  if (route === null || (buildId !== undefined && routeOf(buildId) !== route)) {
    throw new HostedVersionPublicBaselineError(
      'source-mismatch',
      'Hosted public baseline identities use different routes',
    );
  }
  return route;
}

function stateFromRow(row: BaselineRow): HostedVersionPublicBaselineState {
  return {
    buildId: row.build_id,
    catalogueId: row.catalogue_id,
    threadId: row.thread_id,
    sourcePublicationId: row.source_publication_id,
    actorBinding: Buffer.from(row.actor_binding).toString('hex'),
    generationId: row.generation_id,
    placementCount: BigInt(row.placement_count),
    rootCount: BigInt(row.root_count),
    chapterCount: BigInt(row.chapter_count),
    siblingRootId: row.sibling_root_id,
    preorderRootId: row.preorder_root_id,
    chapterRootId: row.chapter_root_id,
    cursor: {
      phase: row.phase,
      occurrenceAfterOrdinal: row.occurrence_after_ordinal,
      nodeAfterKind: row.node_after_kind,
      nodeAfterId: row.node_after_id,
      rootNullDone: row.root_null_done,
      rootAfterParentId: row.root_after_parent_id,
    },
    occurrencesWritten: BigInt(row.occurrences_written),
    nodesWritten: BigInt(row.nodes_written),
    siblingRootsWritten: BigInt(row.sibling_roots_written),
    coverageComplete: row.coverage_complete,
    status: row.status,
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

async function readBaseline(
  tx: CommandTransaction,
  work: SqlWork,
  catalogueId: string,
  buildId: string,
  lock: boolean,
): Promise<BaselineRow | null> {
  const route = routeFor(catalogueId, buildId);
  return (
    (
      await trackedQuery<BaselineRow>(tx, work, 'read', BASELINE_SELECT + (lock ? ' FOR UPDATE' : ''), [
        route,
        catalogueId,
        buildId,
      ])
    ).rows[0] ?? null
  );
}

async function readBuilderSource(
  tx: CommandTransaction,
  work: SqlWork,
  route: number,
  catalogueId: string,
  buildId: string,
): Promise<BuilderSourceRow | null> {
  return (
    (
      await trackedQuery<BuilderSourceRow>(
        tx,
        work,
        'read',
        `SELECT b.route,b.catalogue_id,b.input_id,b.source_revision_id,b.source_kind,
              b.expected_placement_count::text,b.root_sibling_root_id,b.preorder_root_id,b.chapter_root_id,
              b.root_next_position::text,b.coverage_complete,b.source_current,b.status,
              s.publication_id,s.thread_id,s.actor_binding
       FROM content.hosted_version_builder b
       JOIN content.hosted_version_builder_source s
         ON s.route=b.route AND s.catalogue_id=b.catalogue_id AND s.input_id=b.input_id
       WHERE b.route=$1 AND b.catalogue_id=$2 AND b.input_id=$3
       FOR UPDATE OF b,s`,
        [route, catalogueId, buildId],
      )
    ).rows[0] ?? null
  );
}

async function readCurrentPointer(
  tx: CommandTransaction,
  work: SqlWork,
  route: number,
  catalogueId: string,
): Promise<PointerRow | null> {
  return (
    (
      await trackedQuery<PointerRow>(
        tx,
        work,
        'read',
        `SELECT publication_id,thread_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2 FOR SHARE`,
        [route, catalogueId],
      )
    ).rows[0] ?? null
  );
}

function compareFacts(facts: HostedVersionPublicBaselineSealFacts, source: BuilderSourceRow): void {
  const supplied = facts.source;
  if (
    facts.buildId !== facts.candidateId ||
    source.source_kind !== 'public' ||
    source.status !== 'sealed' ||
    !source.coverage_complete ||
    !source.source_current ||
    source.input_id !== facts.buildId ||
    source.catalogue_id !== supplied.catalogueId ||
    source.route !== supplied.route ||
    source.source_revision_id !== source.publication_id ||
    source.publication_id !== supplied.publicationId ||
    source.publication_id !== facts.expectedPublicationId ||
    source.thread_id !== supplied.threadId ||
    source.actor_binding === null ||
    Buffer.from(source.actor_binding).toString('hex') !== supplied.actorBinding ||
    BigInt(source.expected_placement_count) !== BigInt(supplied.expectedPlacementCount) ||
    BigInt(source.expected_placement_count) !== facts.placementCount ||
    BigInt(source.root_next_position) !== facts.rootCount ||
    source.root_sibling_root_id !== facts.siblingRootId ||
    source.preorder_root_id !== facts.preorderRootId ||
    source.chapter_root_id !== facts.chapterRootId
  ) {
    throw new HostedVersionPublicBaselineError('source-mismatch', 'Sealed public baseline facts changed identity');
  }
}

function compareStateToSource(state: HostedVersionPublicBaselineState, source: BuilderSourceRow): void {
  if (
    source.source_kind !== 'public' ||
    source.status !== 'sealed' ||
    !source.coverage_complete ||
    !source.source_current ||
    source.input_id !== state.buildId ||
    source.catalogue_id !== state.catalogueId ||
    source.route !== routeFor(state.catalogueId, state.buildId) ||
    source.source_revision_id !== source.publication_id ||
    source.publication_id !== state.sourcePublicationId ||
    source.thread_id !== state.threadId ||
    source.actor_binding === null ||
    Buffer.from(source.actor_binding).toString('hex') !== state.actorBinding ||
    BigInt(source.expected_placement_count) !== state.placementCount ||
    BigInt(source.root_next_position) !== state.rootCount ||
    source.root_sibling_root_id !== state.siblingRootId ||
    source.preorder_root_id !== state.preorderRootId ||
    source.chapter_root_id !== state.chapterRootId
  ) {
    throw new HostedVersionPublicBaselineError(
      'source-mismatch',
      'Public baseline no longer matches its sealed source',
    );
  }
}

async function assertCurrentSource(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
): Promise<void> {
  const route = routeFor(state.catalogueId, state.buildId);
  const source = await readBuilderSource(tx, work, route, state.catalogueId, state.buildId);
  if (!source)
    throw new HostedVersionPublicBaselineError('source-mismatch', 'Sealed public baseline source is missing');
  compareStateToSource(state, source);
  const pointer = await readCurrentPointer(tx, work, route, state.catalogueId);
  if (!pointer || pointer.thread_id !== state.threadId || pointer.publication_id !== state.sourcePublicationId) {
    throw new HostedVersionPublicBaselineError(
      'stale-source',
      'Original public publication changed during baseline receiving',
    );
  }
}

function compareExistingState(
  state: HostedVersionPublicBaselineState,
  facts: HostedVersionPublicBaselineSealFacts,
): void {
  if (
    state.buildId !== facts.buildId ||
    state.catalogueId !== facts.source.catalogueId ||
    state.threadId !== facts.source.threadId ||
    state.sourcePublicationId !== facts.expectedPublicationId ||
    state.actorBinding !== facts.source.actorBinding ||
    state.placementCount !== facts.placementCount ||
    state.rootCount !== facts.rootCount ||
    state.chapterCount !== facts.chapterCount ||
    state.siblingRootId !== facts.siblingRootId ||
    state.preorderRootId !== facts.preorderRootId ||
    state.chapterRootId !== facts.chapterRootId
  ) {
    throw new HostedVersionPublicBaselineError(
      'source-mismatch',
      'Public baseline receiving was resumed with other source facts',
    );
  }
}

/** Create or resume the one private temporal candidate for a complete sealed public build. */
export async function beginHostedVersionPublicBaseline(
  tx: CommandTransaction,
  facts: HostedVersionPublicBaselineSealFacts,
): Promise<HostedVersionPublicBaselineState> {
  const route = routeFor(facts.source.catalogueId, facts.buildId);
  if (
    facts.source.route !== route ||
    routeOf(facts.source.threadId) !== route ||
    routeOf(facts.expectedPublicationId) !== route
  ) {
    throw new HostedVersionPublicBaselineError(
      'source-mismatch',
      'Sealed public baseline identities use different routes',
    );
  }
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const source = await readBuilderSource(tx, work, route, facts.source.catalogueId, facts.buildId);
  if (!source)
    throw new HostedVersionPublicBaselineError('source-mismatch', 'Sealed public baseline source is missing');
  compareFacts(facts, source);
  const pointer = await readCurrentPointer(tx, work, route, facts.source.catalogueId);
  if (
    !pointer ||
    pointer.thread_id !== facts.source.threadId ||
    pointer.publication_id !== facts.expectedPublicationId
  ) {
    throw new HostedVersionPublicBaselineError(
      'stale-source',
      'Original public publication changed before baseline receiving',
    );
  }

  const existing = await readBaseline(tx, work, facts.source.catalogueId, facts.buildId, true);
  if (existing) {
    const state = stateFromRow(existing);
    compareExistingState(state, facts);
    return state;
  }

  const generationId = newId(route);
  const initial = await createHostedVersionGeneration(tx, facts.source.catalogueId, generationId, 'candidate');
  const cursor = hostedVersionPublicBaselineStartCursor(facts.placementCount);
  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_public_baseline
       (route,catalogue_id,build_id,generation_id,thread_id,source_publication_id,actor_binding,
        placement_count,root_count,chapter_count,sibling_root_id,preorder_root_id,chapter_root_id,
        phase,occurrence_after_ordinal,node_after_kind,node_after_id,root_null_done,root_after_parent_id,
        occurrences_written,nodes_written,sibling_roots_written,coverage_complete,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::bigint,$16,$17,$18,$19,
             0,0,0,false,'materializing',transaction_timestamp(),transaction_timestamp())`,
    [
      route,
      facts.source.catalogueId,
      facts.buildId,
      initial.generationId,
      facts.source.threadId,
      facts.expectedPublicationId,
      Buffer.from(facts.source.actorBinding, 'hex'),
      facts.placementCount.toString(),
      facts.rootCount.toString(),
      facts.chapterCount.toString(),
      facts.siblingRootId,
      facts.preorderRootId,
      facts.chapterRootId,
      cursor.phase,
      cursor.occurrenceAfterOrdinal,
      cursor.nodeAfterKind,
      cursor.nodeAfterId,
      cursor.rootNullDone,
      cursor.rootAfterParentId,
    ],
  );
  const inserted = await readBaseline(tx, work, facts.source.catalogueId, facts.buildId, false);
  if (!inserted) throw new Error('Hosted public baseline receiving state was not created');
  return stateFromRow(inserted);
}

async function readPageReceipt(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
  cursor: HostedVersionPublicBaselineCursor,
): Promise<PageReceiptRow | null> {
  const route = routeFor(state.catalogueId, state.buildId);
  return (
    (
      await trackedQuery<PageReceiptRow>(
        tx,
        work,
        'read',
        `SELECT coverage_complete,generation_sequence::text
       FROM content.hosted_version_public_baseline_page
       WHERE route=$1 AND catalogue_id=$2 AND build_id=$3
         AND from_phase=$4 AND from_occurrence_after_ordinal=$5::bigint
         AND from_node_after_kind=$6 AND from_node_after_id=$7
         AND from_root_null_done=$8 AND from_root_after_parent_id=$9`,
        [
          route,
          state.catalogueId,
          state.buildId,
          cursor.phase,
          cursor.occurrenceAfterOrdinal,
          cursor.nodeAfterKind,
          cursor.nodeAfterId,
          cursor.rootNullDone,
          cursor.rootAfterParentId,
        ],
      )
    ).rows[0] ?? null
  );
}

async function readOccurrencePage(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
): Promise<OccurrenceFactRow[]> {
  return (
    await trackedQuery<OccurrenceFactRow>(
      tx,
      work,
      'read',
      `SELECT source_ordinal::text,occurrence_id,parent_id,kind,title,target_thread_id,target_post_id,
              target_revision_id,encode(target_sha256,'hex') AS target_sha256
       FROM content.hosted_version_builder_point
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND source_ordinal < $4::bigint
       ORDER BY source_ordinal DESC LIMIT $5`,
      [
        routeFor(state.catalogueId, state.buildId),
        state.catalogueId,
        state.buildId,
        state.cursor.occurrenceAfterOrdinal,
        HOSTED_VERSION_PUBLIC_BASELINE_PAGE_MAX,
      ],
    )
  ).rows;
}

async function readNodePage(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
  cursor: HostedVersionPublicBaselineCursor,
): Promise<SequenceNodeRow[]> {
  return (
    await trackedQuery<SequenceNodeRow>(
      tx,
      work,
      'read',
      `SELECT sequence_kind,node_id,left_id,right_id,tree_parent_id,height,node_count::text,
              chapter_weight::text,chapter_count::text
       FROM content.hosted_version_builder_sequence_node
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3
         AND (sequence_kind,node_id) > ($4,$5)
       ORDER BY sequence_kind,node_id LIMIT $6`,
      [
        routeFor(state.catalogueId, state.buildId),
        state.catalogueId,
        state.buildId,
        cursor.nodeAfterKind,
        cursor.nodeAfterId,
        HOSTED_VERSION_PUBLIC_BASELINE_PAGE_MAX,
      ],
    )
  ).rows;
}

async function readSiblingRootPage(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
  cursor: HostedVersionPublicBaselineCursor,
): Promise<SiblingRootRow[]> {
  return (
    await trackedQuery<SiblingRootRow>(
      tx,
      work,
      'read',
      `SELECT parent_id,root_id,next_position::text
       FROM content.hosted_version_builder_sibling_root
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3
         AND CASE WHEN $4::boolean THEN parent_id IS NOT NULL AND parent_id > $5 ELSE true END
       ORDER BY parent_id NULLS FIRST LIMIT $6`,
      [
        routeFor(state.catalogueId, state.buildId),
        state.catalogueId,
        state.buildId,
        cursor.rootNullDone,
        cursor.rootAfterParentId,
        HOSTED_VERSION_PUBLIC_BASELINE_PAGE_MAX,
      ],
    )
  ).rows;
}

async function readSubtree(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
  occurrenceId: string,
): Promise<SubtreeRow | null> {
  return (
    (
      await trackedQuery<SubtreeRow>(
        tx,
        work,
        'read',
        `SELECT subtree_size::text,chapter_count::text
       FROM content.hosted_version_public_baseline_subtree
       WHERE route=$1 AND catalogue_id=$2 AND build_id=$3 AND occurrence_id=$4`,
        [routeFor(state.catalogueId, state.buildId), state.catalogueId, state.buildId, occurrenceId],
      )
    ).rows[0] ?? null
  );
}

async function addParentSubtree(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
  parentId: string,
  subtreeSize: bigint,
  chapterCount: bigint,
): Promise<void> {
  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_public_baseline_subtree
       (route,catalogue_id,build_id,occurrence_id,subtree_size,chapter_count)
     VALUES ($1,$2,$3,$4,$5::bigint,$6::bigint)
     ON CONFLICT (route,catalogue_id,build_id,occurrence_id) DO UPDATE
       SET subtree_size=content.hosted_version_public_baseline_subtree.subtree_size+EXCLUDED.subtree_size,
           chapter_count=content.hosted_version_public_baseline_subtree.chapter_count+EXCLUDED.chapter_count`,
    [
      routeFor(state.catalogueId, state.buildId),
      state.catalogueId,
      state.buildId,
      parentId,
      subtreeSize.toString(),
      chapterCount.toString(),
    ],
  );
}

function targetFromFact(row: OccurrenceFactRow): HostedChapterTarget | null {
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

function occurrenceValue(row: OccurrenceFactRow, chapterCount: bigint): HostedVersionPublicationStoredValue {
  if (row.kind === 'part') return { kind: 'part', title: row.title, chapterCount };
  return { kind: 'chapter', title: row.title, target: targetFromFact(row), chapterCount };
}

async function materializeOccurrencePage(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
  write: HostedVersionWrite<HostedVersionPublicationStoredValue>,
  cursor: HostedVersionPublicBaselineCursor,
): Promise<{ cursor: HostedVersionPublicBaselineCursor; count: number }> {
  const facts = await readOccurrencePage(tx, work, { ...state, cursor });
  if (facts.length === 0) return { cursor: { ...cursor, phase: 'nodes', occurrenceAfterOrdinal: '-1' }, count: 0 };

  const materialized: HostedVersionMaterializedOccurrence<HostedVersionPublicationStoredValue>[] = [];
  for (const fact of facts) {
    const subtree = await readSubtree(tx, work, state, fact.occurrence_id);
    const childrenSize = subtree === null ? 0n : BigInt(subtree.subtree_size);
    const childrenChapters = subtree === null ? 0n : BigInt(subtree.chapter_count);
    const chapterCount = (fact.kind === 'chapter' ? 1n : 0n) + childrenChapters;
    const subtreeSize = 1n + childrenSize;
    const value = occurrenceValue(fact, chapterCount);
    materialized.push({
      occurrenceId: fact.occurrence_id,
      state: { parentOccurrenceId: fact.parent_id, subtreeSize, value },
    });
    if (fact.parent_id !== null) await addParentSubtree(tx, work, state, fact.parent_id, subtreeSize, chapterCount);
  }
  stageHostedVersionMaterializedOccurrences(write, materialized);
  const last = facts[facts.length - 1]!;
  const exhausted = facts.length < HOSTED_VERSION_PUBLIC_BASELINE_PAGE_MAX || last.source_ordinal === '0';
  return {
    cursor: { ...cursor, phase: exhausted ? 'nodes' : 'occurrences', occurrenceAfterOrdinal: last.source_ordinal },
    count: facts.length,
  };
}

function indexKind(kind: SequenceKind): 'sibling' | 'preorder' | 'chapter' {
  if (kind === 'siblings') return 'sibling';
  if (kind === 'chapters') return 'chapter';
  return 'preorder';
}

async function materializeNodePage(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
  snapshot: HostedVersionSnapshot,
  write: HostedVersionWrite<HostedVersionPublicationStoredValue>,
  cursor: HostedVersionPublicBaselineCursor,
): Promise<{ cursor: HostedVersionPublicBaselineCursor; count: number }> {
  const nodes = await readNodePage(tx, work, state, cursor);
  if (nodes.length === 0) {
    return {
      cursor: {
        ...cursor,
        phase: 'roots',
        nodeAfterKind: 'siblings',
        nodeAfterId: HOSTED_VERSION_PUBLIC_BASELINE_ZERO_ID,
      },
      count: 0,
    };
  }
  const materialized: HostedVersionMaterializedNode<HostedVersionPublicationStoredValue>[] = [];
  for (const node of nodes) {
    const occurrence = await readHostedVersionOccurrence<HostedVersionPublicationStoredValue>(
      tx,
      snapshot,
      node.node_id,
    );
    if (occurrence === null) {
      throw new HostedVersionPublicBaselineError(
        'incomplete-source',
        'A sealed public index node has no candidate occurrence',
      );
    }
    materialized.push({
      indexKind: indexKind(node.sequence_kind),
      id: node.node_id,
      value: occurrence.value,
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
  const exhausted = nodes.length < HOSTED_VERSION_PUBLIC_BASELINE_PAGE_MAX;
  return {
    cursor: {
      ...cursor,
      phase: exhausted ? 'roots' : 'nodes',
      nodeAfterKind: last.sequence_kind,
      nodeAfterId: last.node_id,
    },
    count: nodes.length,
  };
}

async function materializeSiblingRootPage(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
  write: HostedVersionWrite<HostedVersionPublicationStoredValue>,
  cursor: HostedVersionPublicBaselineCursor,
): Promise<{ cursor: HostedVersionPublicBaselineCursor; count: number; complete: boolean }> {
  const roots = await readSiblingRootPage(tx, work, state, cursor);
  if (roots.length === 0) {
    return {
      cursor: {
        ...cursor,
        phase: 'complete',
        rootNullDone: true,
        rootAfterParentId: HOSTED_VERSION_PUBLIC_BASELINE_ZERO_ID,
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
  const exhausted = roots.length < HOSTED_VERSION_PUBLIC_BASELINE_PAGE_MAX;
  return {
    cursor: {
      ...cursor,
      phase: exhausted ? 'complete' : 'roots',
      rootNullDone: true,
      rootAfterParentId: last.parent_id ?? HOSTED_VERSION_PUBLIC_BASELINE_ZERO_ID,
    },
    count: roots.length,
    complete: exhausted,
  };
}

function pageWork(
  work: SqlWork,
  written: Readonly<{ occurrences: number; nodes: number; roots: number }>,
): HostedVersionPublicBaselinePageWork {
  return {
    sqlStatements: work.statements,
    sqlRowsReturned: work.rowsReturned,
    sqlRowsAffected: work.rowsAffected,
    occurrencesWritten: written.occurrences,
    nodesWritten: written.nodes,
    siblingRootsWritten: written.roots,
  };
}

async function persistPage(
  tx: CommandTransaction,
  work: SqlWork,
  state: HostedVersionPublicBaselineState,
  from: HostedVersionPublicBaselineCursor,
  to: HostedVersionPublicBaselineCursor,
  written: Readonly<{ occurrences: number; nodes: number; roots: number }>,
  complete: boolean,
  sequence: bigint,
): Promise<void> {
  await trackedQuery(
    tx,
    work,
    'write',
    `UPDATE content.hosted_version_public_baseline
     SET phase=$4,occurrence_after_ordinal=$5::bigint,node_after_kind=$6,node_after_id=$7,
         root_null_done=$8,root_after_parent_id=$9,
         occurrences_written=occurrences_written+$10::bigint,
         nodes_written=nodes_written+$11::bigint,
         sibling_roots_written=sibling_roots_written+$12::bigint,
         coverage_complete=$13,status=$14,updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND build_id=$3 AND status='materializing'`,
    [
      routeFor(state.catalogueId, state.buildId),
      state.catalogueId,
      state.buildId,
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
      complete ? 'complete' : 'materializing',
    ],
  );
  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_public_baseline_page
       (route,catalogue_id,build_id,from_phase,from_occurrence_after_ordinal,from_node_after_kind,
        from_node_after_id,from_root_null_done,from_root_after_parent_id,to_phase,
        to_occurrence_after_ordinal,to_node_after_kind,to_node_after_id,to_root_null_done,
        to_root_after_parent_id,occurrences_written,nodes_written,sibling_roots_written,
        coverage_complete,generation_sequence,created_at)
     VALUES ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11::bigint,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             transaction_timestamp())`,
    [
      routeFor(state.catalogueId, state.buildId),
      state.catalogueId,
      state.buildId,
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

/** Copy one bounded source page into the private candidate; replay uses its retained receipt. */
export async function applyHostedVersionPublicBaselinePage(
  tx: CommandTransaction,
  catalogueId: string,
  buildId: string,
  fromCursor?: HostedVersionPublicBaselineCursor,
): Promise<HostedVersionPublicBaselinePageResult> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const row = await readBaseline(tx, work, catalogueId, buildId, true);
  if (!row) throw new HostedVersionPublicBaselineError('source-mismatch', 'Public baseline receiving was not started');
  const state = stateFromRow(row);
  await assertCurrentSource(tx, work, state);
  const requested = fromCursor ?? state.cursor;
  const receipt = await readPageReceipt(tx, work, state, requested);
  if (receipt) {
    if (receipt.coverage_complete && state.status !== 'complete') {
      throw new HostedVersionPublicBaselineError(
        'incomplete-source',
        'Final baseline receipt has no completed candidate state',
      );
    }
    return { replayed: true, state, work: pageWork(work, { occurrences: 0, nodes: 0, roots: 0 }) };
  }
  if (state.status === 'complete') {
    if (sameHostedVersionPublicBaselineCursor(requested, state.cursor)) {
      return { replayed: true, state, work: pageWork(work, { occurrences: 0, nodes: 0, roots: 0 }) };
    }
    throw new HostedVersionPublicBaselineError(
      'stale-frontier',
      'Completed public baseline has no receipt for this cursor',
    );
  }
  if (!sameHostedVersionPublicBaselineCursor(requested, state.cursor)) {
    throw new HostedVersionPublicBaselineError(
      'stale-frontier',
      'Public baseline page does not continue its retained cursor',
    );
  }

  const current = await readHostedVersionHead(tx, catalogueId, state.generationId);
  if (!current || current.generationKind !== 'candidate') {
    throw new HostedVersionPublicBaselineError('invalid-tree', 'Private public baseline candidate is missing');
  }
  const write = createHostedVersionWrite<HostedVersionPublicationStoredValue>(tx, current);
  let cursor = state.cursor;
  const written = { occurrences: 0, nodes: 0, roots: 0 };
  let complete = false;

  while (!complete) {
    if (cursor.phase === 'occurrences') {
      const page = await materializeOccurrencePage(tx, work, state, write, cursor);
      if (page.count > 0) {
        written.occurrences = page.count;
        cursor = page.cursor;
        break;
      }
      cursor = page.cursor;
      continue;
    }
    if (cursor.phase === 'nodes') {
      const page = await materializeNodePage(tx, work, state, current, write, cursor);
      if (page.count > 0) {
        written.nodes = page.count;
        cursor = page.cursor;
        break;
      }
      cursor = page.cursor;
      continue;
    }
    if (cursor.phase === 'roots') {
      const page = await materializeSiblingRootPage(tx, work, state, write, cursor);
      if (page.count > 0) written.roots = page.count;
      cursor = page.cursor;
      complete = page.complete;
      break;
    }
    complete = true;
  }

  const totalNodes = 2n * state.placementCount + state.chapterCount;
  const nextOccurrences = state.occurrencesWritten + BigInt(written.occurrences);
  const nextNodes = state.nodesWritten + BigInt(written.nodes);
  const nextRoots = state.siblingRootsWritten + BigInt(written.roots);
  if (
    complete &&
    (nextOccurrences !== state.placementCount ||
      nextNodes !== totalNodes ||
      (state.placementCount > 0n && nextRoots === 0n) ||
      (state.placementCount === 0n && nextRoots !== 0n))
  ) {
    throw new HostedVersionPublicBaselineError(
      'incomplete-source',
      'Public baseline pages do not match sealed coverage counts',
    );
  }

  const next = await (async () => {
    if (complete) {
      stageHostedVersionSnapshotRoots(write, {
        preorderRootId: state.preorderRootId,
        chapterRootId: state.chapterRootId,
        placementCount: state.placementCount,
        chapterCount: state.chapterCount,
      });
    } else {
      stageHostedVersionSnapshotRoots(write, {
        preorderRootId: current.preorderRootId,
        chapterRootId: current.chapterRootId,
        placementCount: current.placementCount,
        chapterCount: current.chapterCount,
      });
    }
    return commitHostedVersionWrite(tx, write);
  })();
  const committed = await next;
  await persistPage(tx, work, state, requested, cursor, written, complete, committed.sequence);
  const after = await readBaseline(tx, work, catalogueId, buildId, false);
  if (!after) throw new Error('Hosted public baseline receiving state disappeared after page commit');
  return { replayed: false, state: stateFromRow(after), work: pageWork(work, written) };
}

function sameSnapshot(left: HostedVersionSnapshot, right: HostedVersionSnapshot): boolean {
  return (
    left.route === right.route &&
    left.catalogueId === right.catalogueId &&
    left.generationId === right.generationId &&
    left.generationKind === right.generationKind &&
    left.sequence === right.sequence &&
    left.preorderRootId === right.preorderRootId &&
    left.chapterRootId === right.chapterRootId &&
    left.placementCount === right.placementCount &&
    left.chapterCount === right.chapterCount
  );
}

async function verifyCompleteCandidate(
  tx: CommandTransaction,
  state: HostedVersionPublicBaselineState,
  snapshot: HostedVersionSnapshot,
): Promise<void> {
  const expectedNodes = 2n * state.placementCount + state.chapterCount;
  if (
    state.status !== 'complete' ||
    !state.coverageComplete ||
    state.cursor.phase !== 'complete' ||
    state.occurrencesWritten !== state.placementCount ||
    state.nodesWritten !== expectedNodes ||
    (state.placementCount > 0n && state.siblingRootsWritten === 0n) ||
    snapshot.generationKind !== 'candidate' ||
    snapshot.generationId !== state.generationId ||
    snapshot.catalogueId !== state.catalogueId ||
    snapshot.preorderRootId !== state.preorderRootId ||
    snapshot.chapterRootId !== state.chapterRootId ||
    snapshot.placementCount !== state.placementCount ||
    snapshot.chapterCount !== state.chapterCount
  ) {
    throw new HostedVersionPublicBaselineError(
      'incomplete-source',
      'Public baseline candidate has incomplete temporal coverage',
    );
  }
  const siblingRoot = await readHostedVersionSiblingRoot(tx, snapshot, null);
  if ((siblingRoot?.rootNodeId ?? null) !== state.siblingRootId) {
    throw new HostedVersionPublicBaselineError(
      'invalid-tree',
      'Public baseline root siblings changed during materialization',
    );
  }
  const write = createHostedVersionWrite<HostedVersionPublicationStoredValue>(tx, snapshot);
  const preorder = state.preorderRootId
    ? await hostedVersionSequence(write, 'preorder').readNode(state.preorderRootId)
    : null;
  const chapters = state.chapterRootId
    ? await hostedVersionSequence(write, 'chapter').readNode(state.chapterRootId)
    : null;
  const siblings = state.siblingRootId
    ? await hostedVersionSequence(write, 'sibling').readNode(state.siblingRootId)
    : null;
  if (
    (state.placementCount === 0n
      ? preorder !== null || chapters !== null || siblings !== null
      : preorder === null ||
        preorder.treeParentId !== null ||
        preorder.count !== state.placementCount ||
        preorder.chapterCount !== state.chapterCount ||
        siblings === null ||
        siblings.treeParentId !== null ||
        siblings.count !== state.rootCount) ||
    (state.chapterCount === 0n
      ? chapters !== null
      : chapters === null ||
        chapters.treeParentId !== null ||
        chapters.count !== state.chapterCount ||
        chapters.chapterCount !== state.chapterCount)
  ) {
    throw new HostedVersionPublicBaselineError(
      'incomplete-source',
      'Public baseline candidate roots do not match sealed counts',
    );
  }
}

/** Return the native point-writer baseline only after exact source and candidate verification. */
export async function completeHostedVersionPublicBaseline(
  tx: CommandTransaction,
  catalogueId: string,
  buildId: string,
): Promise<HostedVersionPublicBaselineResult> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const row = await readBaseline(tx, work, catalogueId, buildId, true);
  if (!row) throw new HostedVersionPublicBaselineError('source-mismatch', 'Public baseline receiving was not started');
  const state = stateFromRow(row);
  await assertCurrentSource(tx, work, state);
  if (state.status !== 'complete' || !state.coverageComplete || state.cursor.phase !== 'complete') {
    throw new HostedVersionPublicBaselineError('incomplete-source', 'Public baseline receiving has unfinished pages');
  }
  const snapshot = await readHostedVersionHead(tx, catalogueId, state.generationId);
  if (!snapshot)
    throw new HostedVersionPublicBaselineError('invalid-tree', 'Completed public baseline candidate is missing');
  await verifyCompleteCandidate(tx, state, snapshot);
  const exact = await readHostedVersionHead(tx, catalogueId, state.generationId);
  if (!exact || !sameSnapshot(snapshot, exact)) {
    throw new HostedVersionPublicBaselineError(
      'invalid-tree',
      'Completed public baseline snapshot changed during verification',
    );
  }
  return { sourcePublicationId: state.sourcePublicationId, snapshot };
}
