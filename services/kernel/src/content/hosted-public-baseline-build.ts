import type { CommandTransaction } from '../command/command.ts';
import type { QueryResultRow } from 'pg';
import { newId, routeOf } from '../route/route.ts';
import {
  applyHostedVersionBuilderSequencePage,
  HostedVersionBuilderError,
  type HostedVersionBuilderIndexes,
  type HostedVersionBuilderSequenceItem,
  type HostedVersionBuilderSequenceState,
} from './hosted-version-builder.ts';
import type {
  HostedPublicBaselineCaptureResult,
  HostedPublicBaselineEntry,
  HostedPublicBaselineSource,
} from './hosted-public-baseline-input-model.ts';
import {
  HOSTED_PUBLIC_BASELINE_BUILD_PAGE_MAX,
  type HostedPublicBaselineBuildApplication,
  type HostedPublicBaselineBuildItemAddress,
  type HostedPublicBaselineBuildPage,
  type HostedPublicBaselineBuildPageResult,
  type HostedPublicBaselineBuildSealFacts,
  type HostedPublicBaselineBuildState,
} from './hosted-public-baseline-build-model.ts';
import {
  createVersionedOutlineSequenceReadWriteSet,
  type VersionedOutlineSequenceNode,
} from './versioned-outline-sequence.ts';

export {
  HOSTED_PUBLIC_BASELINE_BUILD_PAGE_MAX,
  type HostedPublicBaselineBuildApplication,
  type HostedPublicBaselineBuildItemAddress,
  type HostedPublicBaselineBuildPage,
  type HostedPublicBaselineBuildPageResult,
  type HostedPublicBaselineBuildSealFacts,
  type HostedPublicBaselineBuildState,
} from './hosted-public-baseline-build-model.ts';

type SqlWork = { statements: number; rowsReturned: number; rowsAffected: number };
type TrackedQuery<Row> = Readonly<{ rows: Row[]; rowCount: number | null }>;
type SequenceKind = 'siblings' | 'preorder' | 'chapters';
type BuilderRow = Readonly<{
  route: number;
  catalogue_id: string;
  input_id: string;
  source_revision_id: string;
  source_kind: 'public';
  base_revision_id: string;
  base_placement_count: string;
  base_root_count: string;
  source_high_water: string;
  expected_placement_count: string;
  frontier_segment: 'base' | 'complete';
  after_ordinal: string;
  after_offset: string;
  root_sibling_root_id: string | null;
  preorder_root_id: string | null;
  chapter_root_id: string | null;
  root_next_position: string;
  active_ancestors: HostedPublicBaselineBuildState['activeAncestors'] | string;
  coverage_complete: boolean;
  source_current: boolean;
  status: 'building' | 'sealed';
  publication_id: string;
  thread_id: string;
  actor_binding: Uint8Array;
}>;

type SourceRow = Readonly<{
  input_id: string;
  publication_id: string;
  thread_id: string;
  actor_binding: Uint8Array;
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

const BUILD_SELECT = `
  SELECT b.route,b.catalogue_id,b.input_id,b.source_revision_id,b.source_kind,b.base_revision_id,
         b.base_placement_count::text,b.base_root_count::text,b.source_high_water::text,
         b.expected_placement_count::text,b.frontier_segment,b.after_ordinal::text,b.after_offset::text,
         b.root_sibling_root_id,b.preorder_root_id,b.chapter_root_id,b.root_next_position::text,
         b.active_ancestors,b.coverage_complete,b.source_current,b.status,
         s.publication_id,s.thread_id,s.actor_binding
  FROM content.hosted_version_builder b
  JOIN content.hosted_version_builder_source s
    ON s.route=b.route AND s.catalogue_id=b.catalogue_id AND s.input_id=b.input_id
  WHERE b.route=$1 AND b.catalogue_id=$2 AND b.input_id=$3 AND s.source_kind='public'`;

function routeFor(source: HostedPublicBaselineSource, buildId?: string): number {
  const route = routeOf(source.catalogueId);
  if (route === null || source.route !== route || (buildId !== undefined && routeOf(buildId) !== route)) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted public baseline identities use different routes');
  }
  return route;
}

function sameSource(left: HostedPublicBaselineSource, right: HostedPublicBaselineSource): boolean {
  return (
    left.catalogueId === right.catalogueId &&
    left.route === right.route &&
    left.threadId === right.threadId &&
    left.publicationId === right.publicationId &&
    left.actorBinding === right.actorBinding &&
    left.expectedPlacementCount === right.expectedPlacementCount
  );
}

function stateFromRow(row: BuilderRow): HostedPublicBaselineBuildState {
  const ancestors = typeof row.active_ancestors === 'string' ? JSON.parse(row.active_ancestors) : row.active_ancestors;
  return {
    buildId: row.input_id,
    candidateId: row.input_id,
    source: {
      catalogueId: row.catalogue_id,
      route: row.route,
      threadId: row.thread_id,
      publicationId: row.publication_id,
      actorBinding: Buffer.from(row.actor_binding).toString('hex'),
      expectedPlacementCount: Number(row.expected_placement_count),
    },
    frontier: { afterOrdinal: Number(row.after_ordinal) },
    rootSiblingRootId: row.root_sibling_root_id,
    preorderRootId: row.preorder_root_id,
    chapterRootId: row.chapter_root_id,
    rootNextPosition: Number(row.root_next_position),
    activeAncestors: ancestors as HostedPublicBaselineBuildState['activeAncestors'],
    coverageComplete: row.coverage_complete,
    sealed: row.status === 'sealed',
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

async function readBuild(
  tx: CommandTransaction,
  work: SqlWork,
  source: HostedPublicBaselineSource,
  buildId: string,
  lock: boolean,
): Promise<BuilderRow> {
  const route = routeFor(source, buildId);
  const row = (
    await trackedQuery<BuilderRow>(tx, work, 'read', BUILD_SELECT + (lock ? ' FOR UPDATE OF b,s' : ''), [
      route,
      source.catalogueId,
      buildId,
    ])
  ).rows[0];
  if (!row) throw new HostedVersionBuilderError('source-mismatch', 'Hosted public baseline build was not captured');
  return row;
}

/** Persist a public source binding, then resume its one shared private candidate identity. */
export async function beginHostedPublicBaselineBuild(
  tx: CommandTransaction,
  capture: HostedPublicBaselineCaptureResult,
): Promise<HostedPublicBaselineBuildState> {
  const { source } = capture;
  const route = routeFor(source);
  if (capture.frontier.afterOrdinal !== -1) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted public baseline build must start at ordinal zero');
  }
  const proposedId = newId(route);
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const actorBinding = Buffer.from(source.actorBinding, 'hex');
  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_builder_source
       (route,catalogue_id,input_id,source_kind,migration_input_id,publication_id,thread_id,actor_binding,created_at)
     VALUES ($1,$2,$3,'public',NULL,$4,$5,$6,transaction_timestamp())
     ON CONFLICT (route,catalogue_id,publication_id,actor_binding) DO NOTHING`,
    [route, source.catalogueId, proposedId, source.publicationId, source.threadId, actorBinding],
  );
  const binding = (
    await trackedQuery<SourceRow>(
      tx,
      work,
      'read',
      `SELECT input_id,publication_id,thread_id,actor_binding
       FROM content.hosted_version_builder_source
       WHERE route=$1 AND catalogue_id=$2 AND source_kind='public' AND publication_id=$3 AND actor_binding=$4
       FOR UPDATE`,
      [route, source.catalogueId, source.publicationId, actorBinding],
    )
  ).rows[0];
  if (!binding)
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted public baseline source binding is missing');
  if (
    binding.publication_id !== source.publicationId ||
    binding.thread_id !== source.threadId ||
    !Buffer.from(binding.actor_binding).equals(actorBinding)
  ) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted public baseline source binding changed');
  }

  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_builder
       (route,catalogue_id,input_id,source_revision_id,source_kind,base_revision_id,base_placement_count,
        base_root_count,source_high_water,expected_placement_count,frontier_segment,after_ordinal,after_offset,
        root_sibling_root_id,preorder_root_id,chapter_root_id,root_next_position,active_ancestors,
        coverage_complete,source_current,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'public',$4,$5::bigint,0,-1,$5::bigint,'base',-1,-1,
             NULL,NULL,NULL,0,'[]'::jsonb,false,true,'building',transaction_timestamp(),transaction_timestamp())
     ON CONFLICT (route,catalogue_id,input_id) DO NOTHING`,
    [route, source.catalogueId, binding.input_id, source.publicationId, String(source.expectedPlacementCount)],
  );
  const row = await readBuild(tx, work, source, binding.input_id, true);
  if (!sameSource(stateFromRow(row).source, source)) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted public baseline build is bound to another source');
  }
  return stateFromRow(row);
}

function sequenceReader(
  tx: CommandTransaction,
  work: SqlWork,
  source: HostedPublicBaselineSource,
  buildId: string,
  kind: SequenceKind,
) {
  const route = routeFor(source, buildId);
  return createVersionedOutlineSequenceReadWriteSet<string>(
    async (id): Promise<VersionedOutlineSequenceNode<string> | null> => {
      const row = (
        await trackedQuery<SequenceRow>(
          tx,
          work,
          'read',
          `SELECT node_id,left_id,right_id,tree_parent_id,height,node_count::text,chapter_weight::text,chapter_count::text
         FROM content.hosted_version_builder_sequence_node
         WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND sequence_kind=$4 AND node_id=$5`,
          [route, source.catalogueId, buildId, kind, id],
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
    },
  );
}

function frontierCount(
  frontier: HostedPublicBaselineBuildPage['fromFrontier'] | HostedPublicBaselineBuildPage['result']['frontier'],
): bigint {
  return BigInt(frontier.afterOrdinal) + 1n;
}

function segmentFor(complete: boolean): 'base' | 'complete' {
  return complete ? 'complete' : 'base';
}

function assertPageHeader(state: HostedPublicBaselineBuildState, page: HostedPublicBaselineBuildPage): void {
  if (page.buildId !== state.buildId || !sameSource(state.source, page.result.source)) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted public baseline page changed its captured identity');
  }
  if (state.sealed) throw new HostedVersionBuilderError('sealed', 'Hosted public baseline candidate is already sealed');
  if (!page.result.sourceCurrent) {
    throw new HostedVersionBuilderError('stale-source', 'Hosted public baseline publication is no longer current');
  }
  if (page.fromFrontier.afterOrdinal !== state.frontier.afterOrdinal) {
    throw new HostedVersionBuilderError('stale-frontier', 'Hosted public baseline page does not continue its frontier');
  }
  const fromCount = frontierCount(page.fromFrontier);
  const toCount = frontierCount(page.result.frontier);
  const expected = BigInt(state.source.expectedPlacementCount);
  if (
    !Number.isSafeInteger(page.result.frontier.afterOrdinal) ||
    page.result.frontier.afterOrdinal < -1 ||
    page.result.frontier.afterOrdinal >= state.source.expectedPlacementCount ||
    page.result.items.length > HOSTED_PUBLIC_BASELINE_BUILD_PAGE_MAX ||
    page.result.coverage.expected !== state.source.expectedPlacementCount ||
    BigInt(page.result.coverage.visited) !== toCount ||
    toCount - fromCount !== BigInt(page.result.items.length) ||
    toCount > expected ||
    page.result.coverage.complete !== (toCount === expected)
  ) {
    throw new HostedVersionBuilderError('incomplete-source', 'Hosted public baseline page coverage is inconsistent');
  }
  if (
    page.result.items.length === 0 &&
    !page.result.coverage.complete &&
    page.fromFrontier.afterOrdinal === page.result.frontier.afterOrdinal
  ) {
    throw new HostedVersionBuilderError('incomplete-source', 'Hosted public baseline page made no frontier progress');
  }
  for (const item of page.result.items) {
    if (item.publicationId !== state.source.publicationId) {
      throw new HostedVersionBuilderError(
        'source-mismatch',
        'Hosted public baseline item left its captured publication',
      );
    }
  }
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

function pointFactRows(
  application: HostedPublicBaselineBuildApplication,
): readonly Readonly<Record<string, unknown>>[] {
  return application.pointFacts.map((fact) => ({
    source_ordinal: String(fact.sourceOrdinal),
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
  page: HostedPublicBaselineBuildPage,
  application: HostedPublicBaselineBuildApplication,
  indexes: HostedVersionBuilderIndexes,
): Promise<void> {
  const route = routeFor(page.result.source, page.buildId);
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
       SELECT $1,$2,$3,x.source_ordinal::bigint,'base',$4,NULL,NULL,x.source_ordinal::bigint,
              x.occurrence_id,x.parent_id,x.position::bigint,x.kind,x.title,x.target_thread_id,
              x.target_post_id,x.target_revision_id,
              CASE WHEN x.target_sha256 IS NULL THEN NULL ELSE decode(x.target_sha256,'hex') END
       FROM jsonb_to_recordset($5::jsonb) AS x(
         source_ordinal text,occurrence_id uuid,parent_id uuid,position text,kind text,title text,
         target_thread_id uuid,target_post_id uuid,target_revision_id uuid,target_sha256 text)`,
      [route, catalogueId, page.buildId, page.result.source.publicationId, JSON.stringify(pointFactRows(application))],
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
        page.buildId,
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
      [route, catalogueId, page.buildId, JSON.stringify(changedNodes)],
    );
  }

  const toOrdinal = page.result.frontier.afterOrdinal;
  const toSegment = segmentFor(page.result.coverage.complete);
  await trackedQuery(
    tx,
    work,
    'write',
    `UPDATE content.hosted_version_builder
     SET frontier_segment=$4,after_ordinal=$5::bigint,after_offset=-1,root_sibling_root_id=$6,
         preorder_root_id=$7,chapter_root_id=$8,root_next_position=$9::bigint,active_ancestors=$10::jsonb,
         coverage_complete=$11,source_current=true,updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND source_kind='public' AND status='building'`,
    [
      route,
      catalogueId,
      page.buildId,
      toSegment,
      String(toOrdinal),
      application.state.rootSiblingRootId,
      application.state.preorderRootId,
      application.state.chapterRootId,
      String(application.state.rootNextPosition),
      JSON.stringify(application.state.activeAncestors),
      page.result.coverage.complete,
    ],
  );
  await trackedQuery(
    tx,
    work,
    'write',
    `INSERT INTO content.hosted_version_builder_page
       (route,catalogue_id,input_id,from_segment,from_after_ordinal,from_after_offset,to_segment,
        to_after_ordinal,to_after_offset,processed,source_current,coverage_complete,created_at)
     VALUES ($1,$2,$3,'base',$4::bigint,-1,$5,$6::bigint,-1,$7,true,$8,transaction_timestamp())`,
    [
      route,
      catalogueId,
      page.buildId,
      String(page.fromFrontier.afterOrdinal),
      toSegment,
      String(toOrdinal),
      page.result.items.length,
      page.result.coverage.complete,
    ],
  );
}

/** Apply one exact public-manifest page. Facts, index writes, cursor and replay receipt commit atomically. */
export async function applyHostedPublicBaselineBuildPage(
  tx: CommandTransaction,
  page: HostedPublicBaselineBuildPage,
): Promise<HostedPublicBaselineBuildPageResult> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const row = await readBuild(tx, work, page.result.source, page.buildId, true);
  const state = stateFromRow(row);
  if (!sameSource(state.source, page.result.source)) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted public baseline page changed its captured source');
  }
  const route = routeFor(state.source, state.buildId);
  const receipt = (
    await trackedQuery<{
      to_segment: 'base' | 'complete';
      to_after_ordinal: string;
      processed: number;
      coverage_complete: boolean;
    }>(
      tx,
      work,
      'read',
      `SELECT to_segment,to_after_ordinal::text,processed,coverage_complete
       FROM content.hosted_version_builder_page
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3
         AND from_segment='base' AND from_after_ordinal=$4::bigint AND from_after_offset=-1`,
      [route, state.source.catalogueId, state.buildId, String(page.fromFrontier.afterOrdinal)],
    )
  ).rows[0];
  if (receipt) {
    const expectedSegment = segmentFor(page.result.coverage.complete);
    if (
      receipt.to_segment !== expectedSegment ||
      receipt.to_after_ordinal !== String(page.result.frontier.afterOrdinal) ||
      receipt.processed !== page.result.items.length ||
      receipt.coverage_complete !== page.result.coverage.complete
    ) {
      throw new HostedVersionBuilderError(
        'stale-frontier',
        'Hosted public baseline replay changed its committed interval',
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
  assertPageHeader(state, page);

  const indexes: HostedVersionBuilderIndexes = {
    siblings: sequenceReader(tx, work, state.source, state.buildId, 'siblings'),
    preorder: sequenceReader(tx, work, state.source, state.buildId, 'preorder'),
    chapters: sequenceReader(tx, work, state.source, state.buildId, 'chapters'),
  };
  const items: HostedVersionBuilderSequenceItem<HostedPublicBaselineBuildItemAddress>[] = page.result.items.map(
    (item: HostedPublicBaselineEntry) => ({
      ...item,
      address: { publicationId: item.publicationId, ordinal: item.ordinal },
    }),
  );
  const sequenceState: HostedVersionBuilderSequenceState = {
    rootSiblingRootId: state.rootSiblingRootId,
    preorderRootId: state.preorderRootId,
    chapterRootId: state.chapterRootId,
    rootNextPosition: state.rootNextPosition,
    activeAncestors: state.activeAncestors,
  };
  const built = await applyHostedVersionBuilderSequencePage(
    sequenceState,
    frontierCount(page.fromFrontier),
    items,
    indexes,
  );
  const application: HostedPublicBaselineBuildApplication = built;
  await persistPage(tx, work, page, application, indexes);
  const nextState: HostedPublicBaselineBuildState = {
    ...state,
    ...application.state,
    frontier: page.result.frontier,
    coverageComplete: page.result.coverage.complete,
  };
  return {
    replayed: false,
    state: nextState,
    application,
    persistenceWork: {
      sqlStatements: work.statements,
      sqlRowsReturned: work.rowsReturned,
      sqlRowsAffected: work.rowsAffected,
    },
  };
}

async function readSequenceRoot(
  tx: CommandTransaction,
  work: SqlWork,
  source: HostedPublicBaselineSource,
  buildId: string,
  kind: SequenceKind,
  rootId: string | null,
): Promise<SequenceRow | null> {
  if (rootId === null) return null;
  const route = routeFor(source, buildId);
  return (
    (
      await trackedQuery<SequenceRow>(
        tx,
        work,
        'read',
        `SELECT node_id,left_id,right_id,tree_parent_id,height,node_count::text,chapter_weight::text,chapter_count::text
         FROM content.hosted_version_builder_sequence_node
         WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND sequence_kind=$4 AND node_id=$5`,
        [route, source.catalogueId, buildId, kind, rootId],
      )
    ).rows[0] ?? null
  );
}

/** Seal only complete coverage that still names the active original publication. */
export async function sealHostedPublicBaselineBuild(
  tx: CommandTransaction,
  page: HostedPublicBaselineBuildPage,
): Promise<HostedPublicBaselineBuildSealFacts> {
  const work: SqlWork = { statements: 0, rowsReturned: 0, rowsAffected: 0 };
  const row = await readBuild(tx, work, page.result.source, page.buildId, true);
  const state = stateFromRow(row);
  if (!sameSource(state.source, page.result.source)) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted public baseline seal changed its captured source');
  }
  if (
    !page.result.sourceCurrent ||
    !page.result.coverage.complete ||
    page.result.coverage.expected !== state.source.expectedPlacementCount ||
    page.result.coverage.visited !== state.source.expectedPlacementCount ||
    page.result.frontier.afterOrdinal !== state.source.expectedPlacementCount - 1 ||
    !state.coverageComplete ||
    state.frontier.afterOrdinal !== state.source.expectedPlacementCount - 1
  ) {
    throw new HostedVersionBuilderError(
      'incomplete-source',
      'Hosted public baseline candidate has incomplete coverage',
    );
  }

  const route = routeFor(state.source, state.buildId);
  const current = (
    await trackedQuery<{ publication_id: string | null; thread_id: string }>(
      tx,
      work,
      'read',
      `SELECT publication_id,thread_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2 FOR SHARE`,
      [route, state.source.catalogueId],
    )
  ).rows[0];
  if (
    !current ||
    current.thread_id !== state.source.threadId ||
    current.publication_id !== state.source.publicationId
  ) {
    throw new HostedVersionBuilderError(
      'stale-source',
      'Hosted public baseline original publication changed before seal',
    );
  }

  const [siblingRoot, preorderRoot, chapterRoot] = await Promise.all([
    readSequenceRoot(tx, work, state.source, state.buildId, 'siblings', state.rootSiblingRootId),
    readSequenceRoot(tx, work, state.source, state.buildId, 'preorder', state.preorderRootId),
    readSequenceRoot(tx, work, state.source, state.buildId, 'chapters', state.chapterRootId),
  ]);
  const placementCount = BigInt(state.source.expectedPlacementCount);
  const rootCount = BigInt(state.rootNextPosition);
  const chapterCount = BigInt(chapterRoot?.node_count ?? '0');
  if (
    (siblingRoot?.tree_parent_id ?? null) !== null ||
    BigInt(siblingRoot?.node_count ?? '0') !== rootCount ||
    (preorderRoot?.tree_parent_id ?? null) !== null ||
    BigInt(preorderRoot?.node_count ?? '0') !== placementCount ||
    BigInt(preorderRoot?.chapter_count ?? '0') !== chapterCount ||
    (chapterRoot?.tree_parent_id ?? null) !== null ||
    chapterCount > placementCount ||
    BigInt(chapterRoot?.chapter_count ?? '0') !== chapterCount
  ) {
    throw new HostedVersionBuilderError('invalid-tree', 'Hosted public baseline sequence roots do not match coverage');
  }

  await trackedQuery(
    tx,
    work,
    'write',
    `UPDATE content.hosted_version_builder
     SET status='sealed',coverage_complete=true,sealed_at=COALESCE(sealed_at,transaction_timestamp()),
         updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND source_kind='public'
       AND status IN ('building','sealed')`,
    [route, state.source.catalogueId, state.buildId],
  );
  return {
    buildId: state.buildId,
    candidateId: state.candidateId,
    source: state.source,
    expectedPublicationId: state.source.publicationId,
    placementCount,
    rootCount,
    chapterCount,
    siblingRootId: state.rootSiblingRootId,
    preorderRootId: state.preorderRootId,
    chapterRootId: state.chapterRootId,
  };
}
