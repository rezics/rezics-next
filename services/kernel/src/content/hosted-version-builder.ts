import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { QueryResultRow } from 'pg';
import { HOSTED_DEPTH_LIMIT } from './hosted-chapters-model.ts';
import {
  createVersionedOutlineSequenceReadWriteSet,
  insertVersionedOutlineSequenceNode,
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceReadWriteSet,
} from './versioned-outline-sequence.ts';
import type { HostedMigrationFrontier, HostedMigrationInputCaptureResult } from './hosted-migration-input-model.ts';
import {
  hostedVersionBuilderFrontierCount,
  sameHostedVersionBuilderFrontier,
  sameHostedVersionBuilderSource,
  HostedVersionBuilderError,
  HOSTED_VERSION_BUILDER_PAGE_MAX,
  hostedVersionBuilderSource,
  type HostedVersionBuilderAncestor,
  type HostedVersionBuilderApplication,
  type HostedVersionBuilderIndexes,
  type HostedVersionBuilderPage,
  type HostedVersionBuilderPointFact,
  type HostedVersionBuilderSiblingRootChange,
  type HostedVersionBuilderSource,
  type HostedVersionBuilderState,
} from './hosted-version-builder-model.ts';

export {
  HOSTED_VERSION_BUILDER_PAGE_MAX,
  HostedVersionBuilderError,
  hostedVersionBuilderSource,
  type HostedVersionBuilderAncestor,
  type HostedVersionBuilderApplication,
  type HostedVersionBuilderIndexes,
  type HostedVersionBuilderPage,
  type HostedVersionBuilderPointFact,
  type HostedVersionBuilderSiblingRootChange,
  type HostedVersionBuilderSource,
  type HostedVersionBuilderState,
} from './hosted-version-builder-model.ts';

type SequenceKind = 'siblings' | 'preorder' | 'chapters';
type SqlWork = { statements: number; rowsReturned: number; rowsAffected: number };
type TrackedQuery<Row> = Readonly<{ rows: Row[]; rowCount: number | null }>;

type BuilderRow = Readonly<{
  route: number;
  catalogue_id: string;
  input_id: string;
  source_revision_id: string;
  source_kind: 'snapshot' | 'prefix';
  base_revision_id: string;
  base_placement_count: string;
  base_root_count: string;
  source_high_water: string;
  expected_placement_count: string;
  frontier_segment: 'base' | 'prefix' | 'complete';
  after_ordinal: string;
  after_offset: string;
  root_sibling_root_id: string | null;
  preorder_root_id: string | null;
  chapter_root_id: string | null;
  root_next_position: string;
  active_ancestors: HostedVersionBuilderAncestor[] | string;
  coverage_complete: boolean;
  source_current: boolean;
  status: 'building' | 'sealed';
}>;

type SequenceRow = Readonly<{
  node_id: string;
  left_id: string | null;
  right_id: string | null;
  tree_parent_id: string | null;
  height: number;
  node_count: string;
  chapter_weight: string;
  chapter_count: string;
}>;

type AggregateRow = Readonly<{
  count: string;
  first_ordinal: string | null;
  last_ordinal: string | null;
  chapter_count: string;
}>;

export type HostedVersionBuilderPersistenceWork = Readonly<{
  sqlStatements: number;
  sqlRowsReturned: number;
  sqlRowsAffected: number;
}>;

export type HostedVersionBuilderPageResult = Readonly<{
  replayed: boolean;
  state: HostedVersionBuilderState;
  application: HostedVersionBuilderApplication | null;
  persistenceWork: HostedVersionBuilderPersistenceWork;
}>;

export type HostedVersionBuilderSealFacts = Readonly<{
  inputId: string;
  source: HostedVersionBuilderSource['identity'];
  placementCount: bigint;
  rootCount: bigint;
  chapterCount: bigint;
  siblingRootId: string | null;
  preorderRootId: string | null;
  chapterRootId: string | null;
}>;

const BUILDER_SELECT = `
  SELECT route,catalogue_id,input_id,source_revision_id,source_kind,base_revision_id,
         base_placement_count::text,base_root_count::text,source_high_water::text,
         expected_placement_count::text,frontier_segment,after_ordinal::text,after_offset::text,
         root_sibling_root_id,preorder_root_id,chapter_root_id,root_next_position::text,
         active_ancestors,coverage_complete,source_current,status
  FROM content.hosted_version_builder
  WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`;

function routeFor(catalogueId: string, inputId: string): number {
  const route = routeOf(catalogueId);
  if (route === null || routeOf(inputId) !== route) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted version builder identities use different routes');
  }
  return route;
}

function frontierColumns(value: HostedMigrationFrontier): readonly [string, string, string] {
  if (value.segment === 'base') return ['base', String(value.afterOrdinal), '-1'];
  if (value.segment === 'prefix') return ['prefix', '-1', value.afterOffset];
  return ['complete', '-1', '-1'];
}

function frontierFromRow(row: BuilderRow): HostedMigrationFrontier {
  if (row.frontier_segment === 'complete') return { segment: 'complete' };
  if (row.frontier_segment === 'base') return { segment: 'base', afterOrdinal: Number(row.after_ordinal) };
  return { segment: 'prefix', afterOffset: row.after_offset };
}

function identityFromRow(row: BuilderRow): HostedVersionBuilderSource['identity'] {
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

function stateFromRow(row: BuilderRow): HostedVersionBuilderState {
  const ancestors =
    typeof row.active_ancestors === 'string'
      ? (JSON.parse(row.active_ancestors) as HostedVersionBuilderAncestor[])
      : row.active_ancestors;
  return {
    inputId: row.input_id,
    identity: identityFromRow(row),
    frontier: frontierFromRow(row),
    rootSiblingRootId: row.root_sibling_root_id,
    preorderRootId: row.preorder_root_id,
    chapterRootId: row.chapter_root_id,
    rootNextPosition: Number(row.root_next_position),
    activeAncestors: ancestors,
    coverageComplete: row.coverage_complete,
    sealed: row.status === 'sealed',
  };
}

function builderSource(capture: HostedMigrationInputCaptureResult): HostedVersionBuilderSource {
  return hostedVersionBuilderSource(capture);
}

function assertSource(source: HostedVersionBuilderSource): void {
  const count = hostedVersionBuilderFrontierCount(source.identity, source.frontier);
  if (count !== 0n) {
    throw new HostedVersionBuilderError(
      'source-mismatch',
      'Hosted version builder must start at the captured source origin',
    );
  }
  if (routeOf(source.identity.catalogueId) !== routeOf(source.inputId)) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted version builder identities use different routes');
  }
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

async function readBuilder(
  tx: CommandTransaction,
  work: SqlWork,
  catalogueId: string,
  inputId: string,
  lock: boolean,
): Promise<BuilderRow> {
  const route = routeFor(catalogueId, inputId);
  const row = (
    await trackedQuery<BuilderRow>(tx, work, 'read', BUILDER_SELECT + (lock ? ' FOR UPDATE' : ''), [
      route,
      catalogueId,
      inputId,
    ])
  ).rows[0];
  if (!row) throw new HostedVersionBuilderError('source-mismatch', 'Hosted version builder has no captured source');
  return row;
}

/** Create the isolated receiving state in the caller's transaction. */
export async function beginHostedVersionBuilder(
  tx: CommandTransaction,
  capture: HostedMigrationInputCaptureResult,
): Promise<HostedVersionBuilderState> {
  const source = builderSource(capture);
  assertSource(source);
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const route = routeFor(source.identity.catalogueId, source.inputId);
  const [segment, afterOrdinal, afterOffset] = frontierColumns(source.frontier);
  const initiallyComplete = source.frontier.segment === 'complete';
  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_builder
       (route,catalogue_id,input_id,source_revision_id,source_kind,base_revision_id,base_placement_count,
        base_root_count,source_high_water,expected_placement_count,frontier_segment,after_ordinal,after_offset,
        root_sibling_root_id,preorder_root_id,chapter_root_id,root_next_position,active_ancestors,
        coverage_complete,source_current,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8::bigint,$9::bigint,$10::bigint,$11,$12::bigint,$13::bigint,
             NULL,NULL,NULL,0,'[]'::jsonb,$14,true,'building',transaction_timestamp(),transaction_timestamp())
     ON CONFLICT (route,catalogue_id,input_id) DO NOTHING`,
    [
      route,
      source.identity.catalogueId,
      source.inputId,
      source.identity.revisionId,
      source.identity.kind,
      source.identity.baseRevisionId,
      source.identity.basePlacementCount,
      source.identity.baseRootCount,
      source.identity.highWater,
      source.identity.expectedPlacementCount,
      segment,
      afterOrdinal,
      afterOffset,
      initiallyComplete,
    ],
  );
  const row = await readBuilder(tx, work, source.identity.catalogueId, source.inputId, true);
  if (!sameHostedVersionBuilderSource(identityFromRow(row), source.identity)) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted version builder is already bound to another source');
  }
  return stateFromRow(row);
}

function sequenceReader(
  tx: CommandTransaction,
  work: SqlWork,
  source: HostedVersionBuilderSource,
  kind: SequenceKind,
): VersionedOutlineSequenceReadWriteSet<string> {
  const route = routeFor(source.identity.catalogueId, source.inputId);
  const reader = async (id: string): Promise<VersionedOutlineSequenceNode<string> | null> => {
    const row = (
      await trackedQuery<SequenceRow>(
        tx,
        work,
        'read',
        `SELECT node_id,left_id,right_id,tree_parent_id,height,node_count::text,chapter_weight::text,chapter_count::text
         FROM content.hosted_version_builder_sequence_node
         WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND sequence_kind=$4 AND node_id=$5`,
        [route, source.identity.catalogueId, source.inputId, kind, id],
      )
    ).rows[0];
    if (!row) return null;
    return {
      id: row.node_id,
      value: row.node_id,
      leftId: row.left_id,
      rightId: row.right_id,
      treeParentId: row.tree_parent_id,
      height: row.height,
      count: BigInt(row.node_count),
      chapterWeight: BigInt(row.chapter_weight) as 0n | 1n,
      chapterCount: BigInt(row.chapter_count),
    };
  };
  return createVersionedOutlineSequenceReadWriteSet(reader);
}

function sourcePageCount(page: HostedVersionBuilderPage): bigint {
  return hostedVersionBuilderFrontierCount(page.result.source, page.result.frontier);
}

function assertPageHeader(state: HostedVersionBuilderState, page: HostedVersionBuilderPage): void {
  if (page.inputId !== state.inputId || page.result.inputId !== state.inputId) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted version page belongs to another migration input');
  }
  if (!sameHostedVersionBuilderSource(state.identity, page.result.source)) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted version page changed its captured source identity');
  }
  if (state.sealed) throw new HostedVersionBuilderError('sealed', 'Hosted version builder is already sealed');
  if (!page.result.sourceCurrent) {
    throw new HostedVersionBuilderError(
      'stale-source',
      'Hosted version source is no longer the current catalogue head',
    );
  }
  if (!sameHostedVersionBuilderFrontier(state.frontier, page.fromFrontier)) {
    throw new HostedVersionBuilderError(
      'stale-frontier',
      'Hosted version page does not continue the retained frontier',
    );
  }
  if (page.result.status !== 'open' && page.result.status !== 'complete') {
    throw new HostedVersionBuilderError(
      'incomplete-source',
      'Hosted version source is no longer available for building',
    );
  }
  if (page.result.items.length > HOSTED_VERSION_BUILDER_PAGE_MAX) {
    throw new HostedVersionBuilderError('invalid-page', 'Hosted version page exceeds its 20-entry bound');
  }
  const fromCount = hostedVersionBuilderFrontierCount(state.identity, page.fromFrontier);
  const toCount = sourcePageCount(page);
  const expected = BigInt(state.identity.expectedPlacementCount);
  if (
    page.result.coverage.expected !== state.identity.expectedPlacementCount ||
    BigInt(page.result.coverage.visited) !== toCount ||
    toCount - fromCount !== BigInt(page.result.items.length) ||
    toCount > expected ||
    page.result.coverage.complete !== (page.result.frontier.segment === 'complete') ||
    (page.result.status === 'complete') !== page.result.coverage.complete
  ) {
    throw new HostedVersionBuilderError(
      'incomplete-source',
      'Hosted version page coverage does not match its source frontier',
    );
  }
  if (
    page.result.items.length === 0 &&
    !page.result.coverage.complete &&
    sameHostedVersionBuilderFrontier(page.fromFrontier, page.result.frontier)
  ) {
    throw new HostedVersionBuilderError('incomplete-source', 'Hosted version source page made no frontier progress');
  }
}

async function requireSequenceCount(
  access: HostedVersionBuilderIndexes['siblings'],
  rootId: string | null,
  expected: bigint,
): Promise<void> {
  if (rootId === null) {
    if (expected !== 0n) throw new HostedVersionBuilderError('invalid-tree', 'Hosted version sequence root is missing');
    return;
  }
  const node = await access.readNode(rootId);
  if (node === null || node.treeParentId !== null || node.count !== expected) {
    throw new HostedVersionBuilderError('invalid-tree', 'Hosted version sequence root count does not match its source');
  }
}

/** Apply one contiguous page into transaction-local sibling, preorder and chapter AVL overlays. */
export async function buildHostedVersionBuilderPage(
  state: HostedVersionBuilderState,
  page: HostedVersionBuilderPage,
  indexes: HostedVersionBuilderIndexes,
): Promise<HostedVersionBuilderApplication> {
  assertPageHeader(state, page);
  const fromCount = hostedVersionBuilderFrontierCount(state.identity, page.fromFrontier);
  const mutableAncestors = state.activeAncestors.map((ancestor) => ({ ...ancestor }));
  const pointFacts: HostedVersionBuilderPointFact[] = [];
  const siblingRoots = new Map<string | null, HostedVersionBuilderSiblingRootChange>();
  let rootSiblingRootId = state.rootSiblingRootId;
  let rootNextPosition = state.rootNextPosition;
  let preorderRootId = state.preorderRootId;
  let chapterRootId = state.chapterRootId;
  const pageOccurrences = new Set<string>();

  await requireSequenceCount(indexes.siblings, rootSiblingRootId, BigInt(rootNextPosition));
  await requireSequenceCount(indexes.preorder, preorderRootId, fromCount);

  for (let index = 0; index < page.result.items.length; index += 1) {
    const item = page.result.items[index]!;
    const expectedOrdinal = fromCount + BigInt(index);
    if (!Number.isSafeInteger(item.ordinal) || BigInt(item.ordinal) !== expectedOrdinal) {
      throw new HostedVersionBuilderError('invalid-page', 'Hosted version source ordinals are not contiguous');
    }
    if (!Number.isSafeInteger(item.position) || item.position < 0 || !item.occurrenceId) {
      throw new HostedVersionBuilderError('invalid-page', 'Hosted version source placement facts are malformed');
    }
    if (pageOccurrences.has(item.occurrenceId)) {
      throw new HostedVersionBuilderError('invalid-page', 'Hosted version page repeats an occurrence identity');
    }
    pageOccurrences.add(item.occurrenceId);

    if (item.address.segment === 'base') {
      if (
        item.address.revisionId !== state.identity.baseRevisionId ||
        item.address.ordinal !== item.ordinal ||
        BigInt(item.ordinal) >= BigInt(state.identity.basePlacementCount)
      ) {
        throw new HostedVersionBuilderError(
          'invalid-page',
          'Hosted version base address does not match its pinned snapshot',
        );
      }
    } else if (
      state.identity.kind !== 'prefix' ||
      item.address.streamId !== state.identity.baseRevisionId ||
      BigInt(item.ordinal) !== BigInt(state.identity.basePlacementCount) + BigInt(item.address.offset)
    ) {
      throw new HostedVersionBuilderError(
        'invalid-page',
        'Hosted version prefix address does not match its pinned stream',
      );
    }

    let parentAncestorIndex = -1;
    if (item.parentId !== null) {
      parentAncestorIndex = mutableAncestors.findIndex((ancestor) => ancestor.occurrenceId === item.parentId);
      if (parentAncestorIndex < 0) {
        throw new HostedVersionBuilderError(
          'invalid-tree',
          'Hosted version placement parent is outside the active source path',
        );
      }
      mutableAncestors.splice(parentAncestorIndex + 1);
    } else {
      mutableAncestors.length = 0;
    }

    const depth = item.parentId === null ? 1 : mutableAncestors.length + 1;
    if (depth > HOSTED_DEPTH_LIMIT) {
      throw new HostedVersionBuilderError('invalid-tree', 'Hosted version nesting exceeds the hosted depth limit');
    }

    const nextPosition =
      item.parentId === null ? rootNextPosition : mutableAncestors[parentAncestorIndex]!.nextChildPosition;
    if (item.position !== nextPosition) {
      throw new HostedVersionBuilderError('invalid-tree', 'Hosted version sibling positions are not contiguous');
    }

    const siblingRootId =
      item.parentId === null ? rootSiblingRootId : mutableAncestors[parentAncestorIndex]!.childSiblingRootId;
    const siblingsExpectedCount = BigInt(nextPosition);
    await requireSequenceCount(indexes.siblings, siblingRootId, siblingsExpectedCount);
    const siblingRootAfter = await insertVersionedOutlineSequenceNode(
      indexes.siblings,
      siblingRootId,
      siblingsExpectedCount,
      item.occurrenceId,
      item.occurrenceId,
      item.kind === 'chapter' ? 1n : 0n,
    );
    if (item.parentId === null) {
      rootSiblingRootId = siblingRootAfter;
      rootNextPosition += 1;
      siblingRoots.set(null, { parentId: null, rootId: siblingRootAfter, nextPosition: rootNextPosition });
    } else {
      mutableAncestors[parentAncestorIndex] = {
        ...mutableAncestors[parentAncestorIndex]!,
        childSiblingRootId: siblingRootAfter,
        nextChildPosition: nextPosition + 1,
      };
      siblingRoots.set(item.parentId, {
        parentId: item.parentId,
        rootId: siblingRootAfter,
        nextPosition: nextPosition + 1,
      });
    }

    const preorderAfter = await insertVersionedOutlineSequenceNode(
      indexes.preorder,
      preorderRootId,
      expectedOrdinal,
      item.occurrenceId,
      item.occurrenceId,
      item.kind === 'chapter' ? 1n : 0n,
    );
    preorderRootId = preorderAfter;
    if (item.kind === 'chapter') {
      const chapterCount =
        chapterRootId === null ? 0n : ((await indexes.chapters.readNode(chapterRootId))?.count ?? -1n);
      if (chapterCount < 0n) {
        throw new HostedVersionBuilderError('invalid-tree', 'Hosted version chapter root is missing');
      }
      chapterRootId = await insertVersionedOutlineSequenceNode(
        indexes.chapters,
        chapterRootId,
        chapterCount,
        item.occurrenceId,
        item.occurrenceId,
        1n,
      );
    }

    const title = item.availability === 'available' ? item.title : null;
    const target = item.kind === 'chapter' && item.availability === 'available' ? item.target : null;
    pointFacts.push({
      sourceOrdinal: item.ordinal,
      address: item.address,
      occurrenceId: item.occurrenceId,
      parentId: item.parentId,
      position: item.position,
      kind: item.kind,
      title,
      target,
    });

    if (item.kind === 'part') {
      mutableAncestors.push({ occurrenceId: item.occurrenceId, childSiblingRootId: null, nextChildPosition: 0 });
    }
  }

  const stateAfter: HostedVersionBuilderState = {
    ...state,
    frontier: page.result.frontier,
    rootSiblingRootId,
    preorderRootId,
    chapterRootId,
    rootNextPosition,
    activeAncestors: mutableAncestors,
    coverageComplete: page.result.coverage.complete,
  };
  const application: HostedVersionBuilderApplication = {
    state: stateAfter,
    pointFacts,
    siblingRootChanges: [...siblingRoots.values()],
    logicalWork: {
      siblings: indexes.siblings.work(),
      preorder: indexes.preorder.work(),
      chapters: indexes.chapters.work(),
      pointFactsWritten: pointFacts.length,
      siblingRootsChanged: siblingRoots.size,
    },
  };
  return application;
}

function sequenceChanges(indexes: HostedVersionBuilderIndexes): readonly Readonly<Record<string, unknown>>[] {
  const changes: Record<string, unknown>[] = [];
  for (const [sequenceKind, access] of [
    ['siblings', indexes.siblings],
    ['preorder', indexes.preorder],
    ['chapters', indexes.chapters],
  ] as const) {
    for (const node of access.nodeWrites.values()) {
      changes.push({
        sequence_kind: sequenceKind,
        node_id: node.id,
        left_id: node.leftId,
        right_id: node.rightId,
        tree_parent_id: node.treeParentId,
        height: node.height,
        node_count: node.count.toString(),
        chapter_weight: (node.chapterWeight ?? 0n).toString(),
        chapter_count: node.chapterCount.toString(),
      });
    }
  }
  return changes;
}

function pointFactRows(facts: readonly HostedVersionBuilderPointFact[]): readonly Readonly<Record<string, unknown>>[] {
  return facts.map((fact) => ({
    source_ordinal: String(fact.sourceOrdinal),
    address_segment: fact.address.segment,
    source_revision_id: fact.address.segment === 'base' ? fact.address.revisionId : null,
    source_stream_id: fact.address.segment === 'prefix' ? fact.address.streamId : null,
    source_offset: fact.address.segment === 'prefix' ? fact.address.offset : null,
    source_address_ordinal: fact.address.segment === 'base' ? String(fact.address.ordinal) : null,
    occurrence_id: fact.occurrenceId,
    parent_id: fact.parentId,
    position: String(fact.position),
    kind: fact.kind,
    title: fact.title,
    target_thread_id: fact.target?.threadId ?? null,
    target_post_id: fact.target?.postId ?? null,
    target_revision_id: fact.target?.revisionId ?? null,
    target_sha256: fact.target?.sha256 ?? null,
  }));
}

async function persistPage(
  tx: CommandTransaction,
  work: SqlWork,
  page: HostedVersionBuilderPage,
  application: HostedVersionBuilderApplication,
): Promise<void> {
  const route = routeFor(page.result.source.catalogueId, page.inputId);
  const catalogueId = page.result.source.catalogueId;
  if (application.pointFacts.length > 0) {
    await trackedQuery(
      tx,
      work,
      'write',
      `INSERT INTO content.hosted_version_builder_point
         (route,catalogue_id,input_id,source_ordinal,address_segment,source_revision_id,source_stream_id,
          source_offset,source_address_ordinal,occurrence_id,parent_id,position,kind,title,target_thread_id,
          target_post_id,target_revision_id,target_sha256)
       SELECT $1,$2,$3,x.source_ordinal::bigint,x.address_segment,x.source_revision_id,x.source_stream_id,
              x.source_offset::bigint,x.source_address_ordinal::bigint,x.occurrence_id,x.parent_id,
              x.position::bigint,x.kind,x.title,x.target_thread_id,x.target_post_id,x.target_revision_id,
              CASE WHEN x.target_sha256 IS NULL THEN NULL ELSE decode(x.target_sha256,'hex') END
       FROM jsonb_to_recordset($4::jsonb) AS x(
         source_ordinal text,address_segment text,source_revision_id uuid,source_stream_id uuid,source_offset text,
         source_address_ordinal text,occurrence_id uuid,parent_id uuid,position text,kind text,title text,
         target_thread_id uuid,target_post_id uuid,target_revision_id uuid,target_sha256 text)`,
      [route, catalogueId, page.inputId, JSON.stringify(pointFactRows(application.pointFacts))],
    );
  }

  if (application.siblingRootChanges.length > 0) {
    await trackedQuery(
      tx,
      work,
      'write',
      `INSERT INTO content.hosted_version_builder_sibling_root
         (route,catalogue_id,input_id,parent_id,root_id,next_position)
       SELECT $1,$2,$3,x.parent_id,x.root_id,x.next_position::bigint
       FROM jsonb_to_recordset($4::jsonb) AS x(parent_id uuid,root_id uuid,next_position text)
       ON CONFLICT (route,catalogue_id,input_id,parent_id)
       DO UPDATE SET root_id=EXCLUDED.root_id,next_position=EXCLUDED.next_position`,
      [
        route,
        catalogueId,
        page.inputId,
        JSON.stringify(
          application.siblingRootChanges.map((change) => ({
            parent_id: change.parentId,
            root_id: change.rootId,
            next_position: String(change.nextPosition),
          })),
        ),
      ],
    );
  }
}

/** Apply one page and persist its facts, all index writes, root changes and replay receipt atomically. */
export async function applyHostedVersionBuilderPage(
  tx: CommandTransaction,
  page: HostedVersionBuilderPage,
): Promise<HostedVersionBuilderPageResult> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const row = await readBuilder(tx, work, page.result.source.catalogueId, page.inputId, true);
  const state = stateFromRow(row);
  const route = routeFor(page.result.source.catalogueId, page.inputId);
  const [fromSegment, fromOrdinal, fromOffset] = frontierColumns(page.fromFrontier);
  const receipt = (
    await trackedQuery<{
      to_segment: 'base' | 'prefix' | 'complete';
      to_after_ordinal: string;
      to_after_offset: string;
    }>(
      tx,
      work,
      'read',
      `SELECT to_segment,to_after_ordinal::text,to_after_offset::text
       FROM content.hosted_version_builder_page
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3
         AND from_segment=$4 AND from_after_ordinal=$5::bigint AND from_after_offset=$6::bigint`,
      [route, page.result.source.catalogueId, page.inputId, fromSegment, fromOrdinal, fromOffset],
    )
  ).rows[0];
  if (receipt) {
    const [toSegment, toOrdinal, toOffset] = frontierColumns(page.result.frontier);
    if (
      !sameHostedVersionBuilderSource(state.identity, page.result.source) ||
      receipt.to_segment !== toSegment ||
      receipt.to_after_ordinal !== toOrdinal ||
      receipt.to_after_offset !== toOffset
    ) {
      throw new HostedVersionBuilderError(
        'stale-frontier',
        'Hosted version replay changed its committed source interval',
      );
    }
    return {
      replayed: true,
      state,
      application: null,
      persistenceWork: {
        sqlStatements: work.statements,
        sqlRowsReturned: work.rowsReturned,
        sqlRowsAffected: work.rowsAffected,
      },
    };
  }

  if (page.fromFrontier.segment === 'complete') {
    throw new HostedVersionBuilderError('stale-frontier', 'Hosted version source is already complete');
  }
  assertPageHeader(state, page);
  const source: HostedVersionBuilderSource = {
    inputId: state.inputId,
    identity: state.identity,
    frontier: state.frontier,
  };
  const indexes: HostedVersionBuilderIndexes = {
    siblings: sequenceReader(tx, work, source, 'siblings'),
    preorder: sequenceReader(tx, work, source, 'preorder'),
    chapters: sequenceReader(tx, work, source, 'chapters'),
  };
  const application = await buildHostedVersionBuilderPage(state, page, indexes);
  await persistPage(tx, work, page, application);

  const changedNodes = sequenceChanges(indexes);
  if (changedNodes.length > 0) {
    await trackedQuery(
      tx,
      work,
      'write',
      `INSERT INTO content.hosted_version_builder_sequence_node
         (route,catalogue_id,input_id,sequence_kind,node_id,left_id,right_id,tree_parent_id,height,
          node_count,chapter_weight,chapter_count)
       SELECT $1,$2,$3,x.sequence_kind,x.node_id,x.left_id,x.right_id,x.tree_parent_id,x.height::integer,
              x.node_count::bigint,x.chapter_weight::smallint,x.chapter_count::bigint
       FROM jsonb_to_recordset($4::jsonb) AS x(
         sequence_kind text,node_id uuid,left_id uuid,right_id uuid,tree_parent_id uuid,height text,
         node_count text,chapter_weight text,chapter_count text)
       ON CONFLICT (route,catalogue_id,input_id,sequence_kind,node_id)
       DO UPDATE SET left_id=EXCLUDED.left_id,right_id=EXCLUDED.right_id,tree_parent_id=EXCLUDED.tree_parent_id,
                     height=EXCLUDED.height,node_count=EXCLUDED.node_count,
                     chapter_weight=EXCLUDED.chapter_weight,chapter_count=EXCLUDED.chapter_count`,
      [route, page.result.source.catalogueId, page.inputId, JSON.stringify(changedNodes)],
    );
  }

  const [toSegment, toOrdinal, toOffset] = frontierColumns(page.result.frontier);
  await trackedQuery(
    tx,
    work,
    'write',
    `UPDATE content.hosted_version_builder
     SET frontier_segment=$4,after_ordinal=$5::bigint,after_offset=$6::bigint,
         root_sibling_root_id=$7,preorder_root_id=$8,chapter_root_id=$9,root_next_position=$10::bigint,
         active_ancestors=$11::jsonb,coverage_complete=$12,source_current=true,updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND status='building'`,
    [
      route,
      page.result.source.catalogueId,
      page.inputId,
      toSegment,
      toOrdinal,
      toOffset,
      application.state.rootSiblingRootId,
      application.state.preorderRootId,
      application.state.chapterRootId,
      String(application.state.rootNextPosition),
      JSON.stringify(application.state.activeAncestors),
      application.state.coverageComplete,
    ],
  );
  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_builder_page
       (route,catalogue_id,input_id,from_segment,from_after_ordinal,from_after_offset,to_segment,
        to_after_ordinal,to_after_offset,processed,source_current,coverage_complete,created_at)
     VALUES ($1,$2,$3,$4,$5::bigint,$6::bigint,$7,$8::bigint,$9::bigint,$10,true,$11,transaction_timestamp())`,
    [
      route,
      page.result.source.catalogueId,
      page.inputId,
      fromSegment,
      fromOrdinal,
      fromOffset,
      toSegment,
      toOrdinal,
      toOffset,
      page.result.items.length,
      page.result.coverage.complete,
    ],
  );

  return {
    replayed: false,
    state: application.state,
    application,
    persistenceWork: {
      sqlStatements: work.statements,
      sqlRowsReturned: work.rowsReturned,
      sqlRowsAffected: work.rowsAffected,
    },
  };
}

function assertSealPage(row: BuilderRow, page: HostedVersionBuilderPage): void {
  const state = stateFromRow(row);
  if (
    page.inputId !== state.inputId ||
    page.result.inputId !== state.inputId ||
    !sameHostedVersionBuilderSource(state.identity, page.result.source)
  ) {
    throw new HostedVersionBuilderError(
      'source-mismatch',
      'Hosted version seal page changed its captured source identity',
    );
  }
  if (
    !page.result.sourceCurrent ||
    page.result.status !== 'complete' ||
    !page.result.coverage.complete ||
    page.result.frontier.segment !== 'complete' ||
    page.result.coverage.expected !== state.identity.expectedPlacementCount ||
    page.result.coverage.visited !== state.identity.expectedPlacementCount
  ) {
    throw new HostedVersionBuilderError(
      'incomplete-source',
      'Hosted version cannot seal stale or incomplete source coverage',
    );
  }
  if (!state.coverageComplete || state.frontier.segment !== 'complete') {
    throw new HostedVersionBuilderError(
      'incomplete-source',
      'Hosted version builder has not applied complete source coverage',
    );
  }
}

async function readSequenceRoot(
  tx: CommandTransaction,
  work: SqlWork,
  source: HostedVersionBuilderSource,
  kind: SequenceKind,
  rootId: string | null,
): Promise<SequenceRow | null> {
  if (rootId === null) return null;
  const route = routeFor(source.identity.catalogueId, source.inputId);
  return (
    (
      await trackedQuery<SequenceRow>(
        tx,
        work,
        'read',
        `SELECT node_id,left_id,right_id,tree_parent_id,height,node_count::text,chapter_weight::text,chapter_count::text
       FROM content.hosted_version_builder_sequence_node
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND sequence_kind=$4 AND node_id=$5`,
        [route, source.identity.catalogueId, source.inputId, kind, rootId],
      )
    ).rows[0] ?? null
  );
}

/** Verify the source fence, complete coverage and all three durable sequence roots before sealing. */
export async function requireHostedVersionBuilderSealFacts(
  tx: CommandTransaction,
  page: HostedVersionBuilderPage,
): Promise<HostedVersionBuilderSealFacts> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const row = await readBuilder(tx, work, page.result.source.catalogueId, page.inputId, true);
  assertSealPage(row, page);
  const state = stateFromRow(row);
  const source: HostedVersionBuilderSource = {
    inputId: state.inputId,
    identity: state.identity,
    frontier: state.frontier,
  };
  const route = routeFor(source.identity.catalogueId, source.inputId);
  const sourceFence = (
    await trackedQuery<{
      head_revision_id: string;
      state: string;
      coverage_complete: boolean;
      raw_visited: string;
      expected_placement_count: string;
    }>(
      tx,
      work,
      'read',
      `SELECT c.head_revision_id,i.state,i.coverage_complete,i.raw_visited::text,
              i.expected_placement_count::text
       FROM content.hosted_catalogue c
       JOIN content.hosted_migration_input i
         ON i.route=c.route AND i.catalogue_id=c.catalogue_id
       WHERE c.route=$1 AND c.catalogue_id=$2 AND i.input_id=$3
       FOR SHARE OF c,i`,
      [route, source.identity.catalogueId, source.inputId],
    )
  ).rows[0];
  if (
    !sourceFence ||
    sourceFence.head_revision_id !== source.identity.revisionId ||
    !['complete', 'consumed'].includes(sourceFence.state) ||
    !sourceFence.coverage_complete ||
    sourceFence.raw_visited !== source.identity.expectedPlacementCount ||
    sourceFence.expected_placement_count !== source.identity.expectedPlacementCount
  ) {
    throw new HostedVersionBuilderError(
      'stale-source',
      'Hosted version source is stale, erased or incomplete at seal time',
    );
  }
  const aggregate = (
    await trackedQuery<AggregateRow>(
      tx,
      work,
      'read',
      `SELECT count(*)::text,min(source_ordinal)::text AS first_ordinal,
              max(source_ordinal)::text AS last_ordinal,
              count(*) FILTER (WHERE kind='chapter')::text AS chapter_count
       FROM content.hosted_version_builder_point
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
      [route, source.identity.catalogueId, source.inputId],
    )
  ).rows[0]!;
  const expectedPlacements = BigInt(source.identity.expectedPlacementCount);
  const placementCount = BigInt(aggregate.count);
  const chapterCount = BigInt(aggregate.chapter_count);
  if (
    placementCount !== expectedPlacements ||
    (expectedPlacements > 0n &&
      (aggregate.first_ordinal !== '0' || BigInt(aggregate.last_ordinal!) !== expectedPlacements - 1n)) ||
    (expectedPlacements === 0n && aggregate.last_ordinal !== null)
  ) {
    throw new HostedVersionBuilderError(
      'incomplete-source',
      'Hosted version candidate facts do not cover the source ordinals',
    );
  }

  const expectedRoots =
    BigInt(source.identity.baseRootCount) +
    (source.identity.kind === 'prefix' && BigInt(source.identity.highWater) >= 0n
      ? BigInt(source.identity.highWater) + 1n
      : 0n);
  const [siblingRoot, preorderRoot, chapterRoot] = await Promise.all([
    readSequenceRoot(tx, work, source, 'siblings', state.rootSiblingRootId),
    readSequenceRoot(tx, work, source, 'preorder', state.preorderRootId),
    readSequenceRoot(tx, work, source, 'chapters', state.chapterRootId),
  ]);
  if (
    state.rootNextPosition !== Number(expectedRoots) ||
    (siblingRoot?.tree_parent_id ?? null) !== null ||
    BigInt(siblingRoot?.node_count ?? '0') !== expectedRoots ||
    (preorderRoot?.tree_parent_id ?? null) !== null ||
    BigInt(preorderRoot?.node_count ?? '0') !== expectedPlacements ||
    BigInt(preorderRoot?.chapter_count ?? '0') !== chapterCount ||
    (chapterRoot?.tree_parent_id ?? null) !== null ||
    BigInt(chapterRoot?.node_count ?? '0') !== chapterCount ||
    BigInt(chapterRoot?.chapter_count ?? '0') !== chapterCount
  ) {
    throw new HostedVersionBuilderError('invalid-tree', 'Hosted version sequence roots do not match candidate facts');
  }

  const rootMismatch = (
    await trackedQuery<{ invalid: string }>(
      tx,
      work,
      'read',
      `SELECT count(*) FILTER (
                WHERE n.node_id IS NULL OR n.tree_parent_id IS NOT NULL OR n.node_count<>r.next_position
              )::text AS invalid
       FROM content.hosted_version_builder_sibling_root r
       LEFT JOIN content.hosted_version_builder_sequence_node n
         ON n.route=r.route AND n.catalogue_id=r.catalogue_id AND n.input_id=r.input_id
        AND n.sequence_kind='siblings' AND n.node_id=r.root_id
       WHERE r.route=$1 AND r.catalogue_id=$2 AND r.input_id=$3`,
      [route, source.identity.catalogueId, source.inputId],
    )
  ).rows[0]!;
  if (BigInt(rootMismatch.invalid) !== 0n) {
    throw new HostedVersionBuilderError(
      'invalid-tree',
      'Hosted version sibling roots do not match their sequence nodes',
    );
  }

  return {
    inputId: source.inputId,
    source: source.identity,
    placementCount,
    rootCount: expectedRoots,
    chapterCount,
    siblingRootId: state.rootSiblingRootId,
    preorderRootId: state.preorderRootId,
    chapterRootId: state.chapterRootId,
  };
}

/** Mark an already verified candidate as sealed; this never updates a live catalogue pointer. */
export async function sealHostedVersionBuilder(
  tx: CommandTransaction,
  page: HostedVersionBuilderPage,
): Promise<HostedVersionBuilderSealFacts> {
  const facts = await requireHostedVersionBuilderSealFacts(tx, page);
  const route = routeFor(facts.source.catalogueId, facts.inputId);
  await tx.query(
    `UPDATE content.hosted_version_builder
     SET status='sealed',sealed_at=transaction_timestamp(),updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND status='building'`,
    [route, facts.source.catalogueId, facts.inputId],
  );
  return facts;
}
