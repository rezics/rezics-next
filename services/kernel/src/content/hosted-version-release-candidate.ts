import type { QueryResultRow } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { Actor, AccessClient } from '../request/access.ts';
import { newId, routeOf } from '../route/route.ts';
import { readHostedPublicationStagingCandidates } from './hosted-publication-staging.ts';
import type {
  HostedPublicationStagedCandidate,
  HostedPublicationStagingSeal,
} from './hosted-publication-staging-model.ts';
import {
  applyHostedVersionBuilderSequencePage,
  type HostedVersionBuilderIndexes,
  type HostedVersionBuilderSequenceItem,
  type HostedVersionBuilderSequenceState,
  type HostedVersionBuilderAncestor,
} from './hosted-version-builder.ts';
import type {
  HostedVersionReleaseCandidateCheckpoint,
  HostedVersionReleaseCandidateCoverage,
  HostedVersionReleaseCandidateProgress,
  HostedVersionReleaseCandidateSeal,
  HostedVersionReleaseCandidateValue,
} from './hosted-version-release-candidate-model.ts';
import {
  HOSTED_VERSION_RELEASE_CANDIDATE_PAGE_MAX,
  HostedVersionReleaseCandidateError,
  HostedVersionReleaseCandidateNotFoundError,
} from './hosted-version-release-candidate-model.ts';
import type { HostedVersionSnapshot, HostedVersionOccurrenceState } from './hosted-version-model.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionHead,
  readHostedVersionSnapshot,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
} from './hosted-version-store.ts';
import type {
  VersionedOutlineSequenceNode,
  VersionedOutlineSequenceReadWriteSet,
} from './versioned-outline-sequence.ts';

export {
  HOSTED_VERSION_RELEASE_CANDIDATE_PAGE_MAX,
  HostedVersionReleaseCandidateError,
  HostedVersionReleaseCandidateNotFoundError,
  type HostedVersionReleaseCandidateCheckpoint,
  type HostedVersionReleaseCandidateCoverage,
  type HostedVersionReleaseCandidateProgress,
  type HostedVersionReleaseCandidateSeal,
  type HostedVersionReleaseCandidateValue,
} from './hosted-version-release-candidate-model.ts';

type CandidateValue = HostedVersionReleaseCandidateValue;
type ActivePart = {
  occurrenceId: string;
  childSiblingRootId: string | null;
  nextChildPosition: number;
  parentId: string | null;
  title: string | null;
  subtreeSize: string;
  chapterCount: string;
  subtreeHeight: number;
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
  mode: HostedPublicationStagingSeal['mode'];
  input_version: string;
  source_candidate_count: string;
  source_sealed_at: string;
  after_source_order: string;
  placement_count: string;
  chapter_count: string;
  root_next_position: string;
  root_sibling_root_id: string | null;
  preorder_root_id: string | null;
  chapter_root_id: string | null;
  active_path: ActivePart[] | string;
  generation_sequence: string;
  coverage_complete: boolean;
  status: 'building' | 'sealed';
};
type SourceFenceRow = QueryResultRow & {
  route: number;
  catalogue_id: string;
  stage_id: string;
  initiator_account_id: string;
  owner_epoch: string;
  source_revision_id: string;
  expected_head_revision_id: string;
  expected_publication_id: string | null;
  mode: HostedPublicationStagingSeal['mode'];
  status: string;
  input_version: string;
  input_frozen_version: string | null;
  candidate_count: string;
  stage_sealed_at: string | null;
  is_expired: boolean;
  seal_input_version: string;
  seal_candidate_count: string;
  seal_sealed_at: string;
  head_revision_id: string;
  publication_id: string | null;
};
type PageReceiptRow = QueryResultRow & {
  processed: number;
  to_generation_sequence: string;
  to_placement_count: string;
  to_chapter_count: string;
};
type OpenPartClose = Readonly<{
  occurrenceId: string;
  parentId: string | null;
  subtreeSize: string;
  value: CandidateValue;
}>;
type CandidateSequenceValue = CandidateValue;
type CandidateSequenceIndex = VersionedOutlineSequenceReadWriteSet<CandidateSequenceValue>;
type CandidateWrite = ReturnType<typeof createHostedVersionWrite<CandidateSequenceValue>>;

const CANDIDATE_SELECT = `
  SELECT route,catalogue_id,stage_id,generation_id,initiator_account_id,owner_epoch::text AS owner_epoch,
         source_revision_id,expected_head_revision_id,expected_publication_id,mode,input_version::text,
         source_candidate_count::text,
         to_char(source_sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_sealed_at,
         after_source_order::text,
         placement_count::text,chapter_count::text,root_next_position::text,root_sibling_root_id,
         preorder_root_id,chapter_root_id,active_path,generation_sequence::text,coverage_complete,status
  FROM content.hosted_version_release_candidate
  WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`;

function routeForSeal(seal: HostedPublicationStagingSeal): number {
  const route = routeOf(seal.locator.catalogueId);
  if (route === null || routeOf(seal.locator.stageId) !== route)
    throw new HostedVersionReleaseCandidateError(
      'source-mismatch',
      'Release candidate source identities use different routes',
    );
  return route;
}

function accountActor(actor: Actor): Extract<Actor, { kind: 'account' }> {
  if (actor.kind !== 'account' || !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 0)
    throw new HostedVersionReleaseCandidateNotFoundError();
  return actor;
}

function sealFromRow(row: CandidateRow): HostedPublicationStagingSeal {
  return {
    locator: { catalogueId: row.catalogue_id, stageId: row.stage_id },
    sourceRevisionId: row.source_revision_id,
    expectedHeadRevisionId: row.expected_head_revision_id,
    expectedPublicationId: row.expected_publication_id,
    mode: row.mode,
    inputVersion: row.input_version,
    candidateCount: row.source_candidate_count,
    sealedAt: row.source_sealed_at,
  };
}

function sameSeal(left: HostedPublicationStagingSeal, right: HostedPublicationStagingSeal): boolean {
  return (
    left.locator.catalogueId === right.locator.catalogueId &&
    left.locator.stageId === right.locator.stageId &&
    left.sourceRevisionId === right.sourceRevisionId &&
    left.expectedHeadRevisionId === right.expectedHeadRevisionId &&
    left.expectedPublicationId === right.expectedPublicationId &&
    left.mode === right.mode &&
    left.inputVersion === right.inputVersion &&
    left.candidateCount === right.candidateCount &&
    left.sealedAt === right.sealedAt
  );
}

async function requireCurrentSource(
  tx: CommandTransaction,
  actorInput: Actor,
  seal: HostedPublicationStagingSeal,
): Promise<SourceFenceRow> {
  const actor = accountActor(actorInput);
  const route = routeForSeal(seal);
  const row = (
    await tx.query<SourceFenceRow>(
      `SELECT stage.route,stage.catalogue_id,stage.stage_id,stage.initiator_account_id,
              stage.owner_epoch::text AS owner_epoch,stage.source_revision_id,stage.expected_head_revision_id,
              stage.expected_publication_id,stage.mode,stage.status,stage.input_version::text,
              stage.input_frozen_version::text,stage.candidate_count::text,
              to_char(stage.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stage_sealed_at,
              (stage.expires_at<=clock_timestamp()) AS is_expired,
              source_seal.input_version::text AS seal_input_version,
              source_seal.candidate_count::text AS seal_candidate_count,
              to_char(source_seal.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS seal_sealed_at,
              catalogue.head_revision_id,catalogue.publication_id
       FROM content.hosted_publication_staging stage
       JOIN content.hosted_publication_staging_seal source_seal
         ON source_seal.route=stage.route AND source_seal.catalogue_id=stage.catalogue_id
        AND source_seal.stage_id=stage.stage_id
       JOIN content.hosted_catalogue catalogue
         ON catalogue.route=stage.route AND catalogue.catalogue_id=stage.catalogue_id
       WHERE stage.route=$1 AND stage.catalogue_id=$2 AND stage.stage_id=$3
       FOR UPDATE OF stage,catalogue`,
      [route, seal.locator.catalogueId, seal.locator.stageId],
    )
  ).rows[0];
  if (!row) throw new HostedVersionReleaseCandidateNotFoundError();
  if (row.initiator_account_id !== actor.accountId || row.owner_epoch !== String(actor.authnEpoch))
    throw new HostedVersionReleaseCandidateNotFoundError();
  if (row.is_expired)
    throw new HostedVersionReleaseCandidateError('stale-source', 'The sealed staging source has expired');
  if (
    row.status !== 'sealed' ||
    row.source_revision_id !== row.expected_head_revision_id ||
    row.input_version !== row.seal_input_version ||
    row.candidate_count !== row.seal_candidate_count ||
    row.stage_sealed_at !== row.seal_sealed_at ||
    (row.mode === 'selection' && row.input_frozen_version !== row.input_version) ||
    row.seal_input_version !== seal.inputVersion ||
    row.seal_candidate_count !== seal.candidateCount ||
    row.source_revision_id !== seal.sourceRevisionId ||
    row.expected_head_revision_id !== seal.expectedHeadRevisionId ||
    row.expected_publication_id !== seal.expectedPublicationId ||
    row.mode !== seal.mode ||
    row.seal_sealed_at !== seal.sealedAt
  ) {
    throw new HostedVersionReleaseCandidateError('source-mismatch', 'The exact native staging seal does not match');
  }
  if (row.head_revision_id !== seal.expectedHeadRevisionId || row.publication_id !== seal.expectedPublicationId)
    throw new HostedVersionReleaseCandidateError('stale-source', 'The pinned draft or public release has changed');
  return row;
}

async function readCandidate(
  tx: CommandTransaction,
  seal: HostedPublicationStagingSeal,
  lock: boolean,
): Promise<CandidateRow | null> {
  const route = routeForSeal(seal);
  const row = (
    await tx.query<CandidateRow>(CANDIDATE_SELECT + (lock ? ' FOR UPDATE' : ''), [
      route,
      seal.locator.catalogueId,
      seal.locator.stageId,
    ])
  ).rows[0];
  return row ?? null;
}

function assertCandidateBinding(row: CandidateRow, actorInput: Actor, seal: HostedPublicationStagingSeal): void {
  const actor = accountActor(actorInput);
  if (
    row.initiator_account_id !== actor.accountId ||
    row.owner_epoch !== String(actor.authnEpoch) ||
    !sameSeal(sealFromRow(row), seal)
  ) {
    throw new HostedVersionReleaseCandidateNotFoundError();
  }
}

function activePathFromRow(row: CandidateRow): ActivePart[] {
  return (typeof row.active_path === 'string' ? JSON.parse(row.active_path) : row.active_path) as ActivePart[];
}

function checkpoint(row: CandidateRow): HostedVersionReleaseCandidateCheckpoint {
  const after = BigInt(row.after_source_order);
  return {
    candidateId: row.stage_id,
    generationId: row.generation_id,
    sourceSeal: sealFromRow(row),
    afterSourceOrder: after < 0n ? null : after.toString(),
    placementCount: row.placement_count,
    rootCount: row.root_next_position,
    chapterCount: row.chapter_count,
    coverageComplete: row.coverage_complete,
    sealed: row.status === 'sealed',
  };
}

async function exactSnapshot(
  tx: CommandTransaction,
  row: CandidateRow,
  sequence = BigInt(row.generation_sequence),
): Promise<HostedVersionSnapshot> {
  const snapshot = await readHostedVersionSnapshot(tx, row.catalogue_id, row.generation_id, sequence);
  if (
    !snapshot ||
    snapshot.generationKind !== 'candidate' ||
    snapshot.placementCount !== BigInt(row.placement_count) ||
    snapshot.chapterCount !== BigInt(row.chapter_count)
  ) {
    throw new HostedVersionReleaseCandidateError(
      'invalid-tree',
      'The private release snapshot does not match its frontier',
    );
  }
  return snapshot;
}

async function currentSnapshot(tx: CommandTransaction, row: CandidateRow): Promise<HostedVersionSnapshot> {
  const snapshot = await readHostedVersionHead(tx, row.catalogue_id, row.generation_id);
  if (
    !snapshot ||
    snapshot.generationKind !== 'candidate' ||
    snapshot.sequence !== BigInt(row.generation_sequence) ||
    snapshot.placementCount !== BigInt(row.placement_count) ||
    snapshot.chapterCount !== BigInt(row.chapter_count)
  ) {
    throw new HostedVersionReleaseCandidateError('stale-frontier', 'The private candidate generation changed');
  }
  return snapshot;
}

function asStringIndex(
  inner: CandidateSequenceIndex,
  payloads: Map<string, CandidateValue>,
): VersionedOutlineSequenceReadWriteSet<string> {
  const project = (
    node: VersionedOutlineSequenceNode<CandidateValue> | null,
  ): VersionedOutlineSequenceNode<string> | null => (node === null ? null : { ...node, value: node.id });
  const nodeReads = new Map<string, VersionedOutlineSequenceNode<string> | null>();
  const nodeWrites = new Map<string, VersionedOutlineSequenceNode<string>>();
  return {
    async readNode(id) {
      const node = project(await inner.readNode(id));
      nodeReads.set(id, node);
      return node;
    },
    writeNode(node) {
      const current = inner.nodeWrites.get(node.id) ?? inner.nodeReads.get(node.id);
      const value = payloads.get(node.id) ?? current?.value;
      if (value === undefined) throw new Error('Hosted release sequence write is missing its occurrence value');
      inner.writeNode({ ...node, value });
      nodeWrites.set(node.id, node);
    },
    nodeReads,
    nodeWrites,
    work: () => inner.work(),
  };
}

function indexesFor(write: CandidateWrite, payloads: Map<string, CandidateValue>): HostedVersionBuilderIndexes {
  return {
    siblings: asStringIndex(hostedVersionSequence(write, 'sibling'), payloads),
    preorder: asStringIndex(hostedVersionSequence(write, 'preorder'), payloads),
    chapters: asStringIndex(hostedVersionSequence(write, 'chapter'), payloads),
  };
}

function valueFor(item: HostedPublicationStagedCandidate): CandidateValue {
  return {
    kind: item.kind,
    title: item.title,
    subtreeHeight: 0,
    chapterCount: item.kind === 'chapter' ? 1n : 0n,
    target: item.kind === 'chapter' ? item.target : null,
  };
}

function appendOccurrencePage(
  row: CandidateRow,
  items: readonly HostedPublicationStagedCandidate[],
  exhausted: boolean,
): Readonly<{
  sequenceItems: readonly HostedVersionBuilderSequenceItem<Readonly<{ sourceOrder: string }>>[];
  activePath: readonly ActivePart[];
  closedParts: readonly OpenPartClose[];
  chapters: readonly Readonly<{ occurrenceId: string; parentId: string | null; value: CandidateValue }>[];
}> {
  const activePath = activePathFromRow(row).map((part) => ({ ...part }));
  const closedParts: OpenPartClose[] = [];
  const chapters: { occurrenceId: string; parentId: string | null; value: CandidateValue }[] = [];
  const sequenceItems: HostedVersionBuilderSequenceItem<Readonly<{ sourceOrder: string }>>[] = [];
  let rootNextPosition = Number(row.root_next_position);
  const firstOrdinal = BigInt(row.placement_count);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    let parentIndex = -1;
    if (item.parentId !== null) {
      parentIndex = activePath.findIndex((ancestor) => ancestor.occurrenceId === item.parentId);
      if (parentIndex < 0)
        throw new HostedVersionReleaseCandidateError('invalid-tree', 'Selected parent is outside the source frontier');
    }
    const keepThrough = item.parentId === null ? 0 : parentIndex + 1;
    closedParts.push(...activePath.splice(keepThrough).map(finalizePart));
    const position = item.parentId === null ? rootNextPosition++ : activePath[parentIndex]!.nextChildPosition++;
    for (let ancestorIndex = 0; ancestorIndex < activePath.length; ancestorIndex += 1) {
      const ancestor = activePath[ancestorIndex]!;
      ancestor.subtreeSize = (BigInt(ancestor.subtreeSize) + 1n).toString();
      if (item.kind === 'chapter') ancestor.chapterCount = (BigInt(ancestor.chapterCount) + 1n).toString();
      ancestor.subtreeHeight = Math.max(ancestor.subtreeHeight, activePath.length - ancestorIndex);
    }

    const value = valueFor(item);
    if (item.kind === 'chapter') chapters.push({ occurrenceId: item.occurrenceId, parentId: item.parentId, value });
    else {
      activePath.push({
        occurrenceId: item.occurrenceId,
        childSiblingRootId: null,
        nextChildPosition: 0,
        parentId: item.parentId,
        title: item.title,
        subtreeSize: '1',
        chapterCount: '0',
        subtreeHeight: 0,
      });
    }

    const common = {
      address: { sourceOrder: item.sourceOrder },
      occurrenceId: item.occurrenceId,
      parentId: item.parentId,
      position,
      ordinal: Number(firstOrdinal + BigInt(index)),
      availability: 'available' as const,
      title: item.title ?? '',
    };
    sequenceItems.push(
      item.kind === 'part' ? { ...common, kind: 'part' } : { ...common, kind: 'chapter', target: item.target! },
    );
  }

  if (exhausted) {
    closedParts.push(...activePath.splice(0).map(finalizePart));
  }

  return { sequenceItems, activePath, closedParts, chapters };
}

function finalizePart(part: ActivePart): OpenPartClose {
  return {
    occurrenceId: part.occurrenceId,
    parentId: part.parentId,
    subtreeSize: part.subtreeSize,
    value: {
      kind: 'part',
      title: part.title,
      subtreeHeight: part.subtreeHeight,
      chapterCount: BigInt(part.chapterCount),
      target: null,
    },
  };
}

function mergeSequencePath(
  activePath: readonly ActivePart[],
  activeAncestors: readonly HostedVersionBuilderAncestor[],
): readonly ActivePart[] {
  if (activePath.length !== activeAncestors.length)
    throw new HostedVersionReleaseCandidateError(
      'invalid-tree',
      'Selected path state does not match the sequence frontier',
    );
  return activePath.map((part, index) => {
    const sequencePart = activeAncestors[index]!;
    if (part.occurrenceId !== sequencePart.occurrenceId)
      throw new HostedVersionReleaseCandidateError(
        'invalid-tree',
        'Selected path order does not match the sequence frontier',
      );
    return {
      ...part,
      childSiblingRootId: sequencePart.childSiblingRootId,
      nextChildPosition: sequencePart.nextChildPosition,
    };
  });
}

function closePart(part: OpenPartClose): HostedVersionOccurrenceState<CandidateValue> {
  return {
    parentOccurrenceId: part.parentId,
    subtreeSize: BigInt(part.subtreeSize),
    value: part.value,
  };
}

async function verifyCompleteRoots(
  indexes: HostedVersionBuilderIndexes,
  rootSiblingRootId: string | null,
  preorderRootId: string | null,
  chapterRootId: string | null,
  rootCount: bigint,
  placementCount: bigint,
  chapterCount: bigint,
): Promise<void> {
  const [siblings, preorder, chapters] = await Promise.all([
    rootSiblingRootId === null ? null : indexes.siblings.readNode(rootSiblingRootId),
    preorderRootId === null ? null : indexes.preorder.readNode(preorderRootId),
    chapterRootId === null ? null : indexes.chapters.readNode(chapterRootId),
  ]);
  if (
    (siblings?.treeParentId ?? null) !== null ||
    (siblings?.count ?? 0n) !== rootCount ||
    (preorder?.treeParentId ?? null) !== null ||
    (preorder?.count ?? 0n) !== placementCount ||
    (preorder?.chapterCount ?? 0n) !== chapterCount ||
    (chapters?.treeParentId ?? null) !== null ||
    (chapters?.count ?? 0n) !== chapterCount ||
    (chapters?.chapterCount ?? 0n) !== chapterCount
  ) {
    throw new HostedVersionReleaseCandidateError(
      'invalid-tree',
      'Release candidate roots do not cover its selected rows',
    );
  }
}

function sourceCursor(value: string | null): bigint {
  return value === null ? -1n : BigInt(value);
}

/** Bind one exact staging seal to an isolated temporal candidate generation. */
export async function beginHostedVersionReleaseCandidate(
  tx: CommandTransaction,
  actorInput: Actor,
  sourceSeal: HostedPublicationStagingSeal,
): Promise<HostedVersionReleaseCandidateProgress> {
  const actor = accountActor(actorInput);
  const source = await requireCurrentSource(tx, actor, sourceSeal);
  let row = await readCandidate(tx, sourceSeal, true);
  let replayed = row !== null;
  if (row) {
    assertCandidateBinding(row, actor, sourceSeal);
  } else {
    const generationId = newId(source.route);
    const initial = await createHostedVersionGeneration(tx, source.catalogue_id, generationId, 'candidate');
    await tx.query(
      `INSERT INTO content.hosted_version_release_candidate
         (route,catalogue_id,stage_id,generation_id,initiator_account_id,owner_epoch,source_revision_id,
          expected_head_revision_id,expected_publication_id,mode,input_version,source_candidate_count,
          source_sealed_at,generation_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        source.route,
        source.catalogue_id,
        source.stage_id,
        generationId,
        actor.accountId,
        actor.authnEpoch,
        source.source_revision_id,
        source.expected_head_revision_id,
        source.expected_publication_id,
        source.mode,
        source.seal_input_version,
        source.seal_candidate_count,
        source.seal_sealed_at,
        initial.sequence.toString(),
      ],
    );
    row = await readCandidate(tx, sourceSeal, true);
    if (!row) throw new HostedVersionReleaseCandidateError('source-mismatch', 'The release candidate was not retained');
    replayed = false;
  }
  const snapshot = await currentSnapshot(tx, row);
  return { replayed, processed: 0, checkpoint: checkpoint(row), snapshot };
}

/** Consume one indexed source page and commit it with its output snapshot and replay receipt. */
export async function applyHostedVersionReleaseCandidatePage(
  tx: CommandTransaction,
  actorInput: Actor,
  sourceSeal: HostedPublicationStagingSeal,
  afterSourceOrder: string | null,
): Promise<HostedVersionReleaseCandidateProgress> {
  const actor = accountActor(actorInput);
  await requireCurrentSource(tx, actor, sourceSeal);
  const row = await readCandidate(tx, sourceSeal, true);
  if (!row) throw new HostedVersionReleaseCandidateNotFoundError();
  assertCandidateBinding(row, actor, sourceSeal);
  const from = sourceCursor(afterSourceOrder);
  const route = routeForSeal(sourceSeal);
  const prior = (
    await tx.query<PageReceiptRow>(
      `SELECT processed,to_generation_sequence::text,to_placement_count::text,to_chapter_count::text
       FROM content.hosted_version_release_candidate_page
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND from_source_order=$4`,
      [route, sourceSeal.locator.catalogueId, sourceSeal.locator.stageId, from.toString()],
    )
  ).rows[0];
  if (prior) {
    const snapshot = await readHostedVersionSnapshot(
      tx,
      row.catalogue_id,
      row.generation_id,
      BigInt(prior.to_generation_sequence),
    );
    if (
      !snapshot ||
      snapshot.generationKind !== 'candidate' ||
      snapshot.placementCount !== BigInt(prior.to_placement_count) ||
      snapshot.chapterCount !== BigInt(prior.to_chapter_count)
    ) {
      throw new HostedVersionReleaseCandidateError('invalid-tree', 'The replay snapshot is unavailable');
    }
    return { replayed: true, processed: prior.processed, checkpoint: checkpoint(row), snapshot };
  }
  if (row.status === 'sealed')
    throw new HostedVersionReleaseCandidateError('sealed', 'The release candidate is already sealed');
  if (from !== BigInt(row.after_source_order))
    throw new HostedVersionReleaseCandidateError(
      'stale-frontier',
      'The source cursor does not match the retained frontier',
    );
  const current = await currentSnapshot(tx, row);
  const sourcePage = await readHostedPublicationStagingCandidates(
    tx as AccessClient,
    actor,
    sourceSeal.locator,
    afterSourceOrder,
    HOSTED_VERSION_RELEASE_CANDIDATE_PAGE_MAX,
  );
  const exhausted = sourcePage.next === null;
  const nextCount = BigInt(row.placement_count) + BigInt(sourcePage.items.length);
  const sourceCount = BigInt(row.source_candidate_count);
  if (nextCount > sourceCount || (exhausted && nextCount !== sourceCount) || (!exhausted && nextCount >= sourceCount)) {
    throw new HostedVersionReleaseCandidateError(
      'incomplete-source',
      'The exact stage page does not cover its sealed count',
    );
  }

  const page = appendOccurrencePage(row, sourcePage.items, exhausted);
  const payloads = new Map<string, CandidateValue>();
  for (const item of sourcePage.items) payloads.set(item.occurrenceId, valueFor(item));
  const write = createHostedVersionWrite<CandidateValue>(tx, current);
  const indexes = indexesFor(write, payloads);
  const sequenceState: HostedVersionBuilderSequenceState = {
    rootSiblingRootId: row.root_sibling_root_id,
    preorderRootId: row.preorder_root_id,
    chapterRootId: row.chapter_root_id,
    rootNextPosition: Number(row.root_next_position),
    activeAncestors: activePathFromRow(row),
  };
  const application = await applyHostedVersionBuilderSequencePage(
    sequenceState,
    BigInt(row.placement_count),
    page.sequenceItems,
    indexes,
  );
  const activePath = exhausted ? [] : mergeSequencePath(page.activePath, application.state.activeAncestors);
  const chapterCount =
    BigInt(row.chapter_count) + BigInt(sourcePage.items.filter((item) => item.kind === 'chapter').length);
  const rootCount = BigInt(application.state.rootNextPosition);
  const placementCount = nextCount;

  for (const close of page.closedParts) stageHostedVersionOccurrence(write, close.occurrenceId, closePart(close));
  for (const chapter of page.chapters)
    stageHostedVersionOccurrence(write, chapter.occurrenceId, {
      parentOccurrenceId: chapter.parentId,
      subtreeSize: 1n,
      value: chapter.value,
    });
  for (const change of application.siblingRootChanges)
    stageHostedVersionSiblingRoot(write, change.parentId, change.rootId);

  if (exhausted) {
    await verifyCompleteRoots(
      indexes,
      application.state.rootSiblingRootId,
      application.state.preorderRootId,
      application.state.chapterRootId,
      rootCount,
      placementCount,
      chapterCount,
    );
  }
  stageHostedVersionSnapshotRoots(write, {
    preorderRootId: application.state.preorderRootId,
    chapterRootId: application.state.chapterRootId,
    placementCount,
    chapterCount,
  });
  const snapshot = await commitHostedVersionWrite(tx, write);
  const toSourceOrder = sourcePage.items.at(-1)?.sourceOrder ?? afterSourceOrder;
  const nextFrontier = toSourceOrder === null ? -1n : BigInt(toSourceOrder);
  const updatedCount = await tx.query(
    `UPDATE content.hosted_version_release_candidate
     SET after_source_order=$4,placement_count=$5,chapter_count=$6,root_next_position=$7,
         root_sibling_root_id=$8,preorder_root_id=$9,chapter_root_id=$10,active_path=$11::jsonb,
         generation_sequence=$12,coverage_complete=$13,updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND status='building'`,
    [
      route,
      sourceSeal.locator.catalogueId,
      sourceSeal.locator.stageId,
      nextFrontier.toString(),
      placementCount.toString(),
      chapterCount.toString(),
      application.state.rootNextPosition,
      application.state.rootSiblingRootId,
      application.state.preorderRootId,
      application.state.chapterRootId,
      JSON.stringify(activePath),
      snapshot.sequence.toString(),
      exhausted,
    ],
  );
  if (updatedCount.rowCount !== 1)
    throw new HostedVersionReleaseCandidateError(
      'stale-frontier',
      'The release candidate frontier changed during its page',
    );
  await tx.query(
    `INSERT INTO content.hosted_version_release_candidate_page
       (route,catalogue_id,stage_id,from_source_order,to_source_order,processed,to_generation_sequence,
        to_placement_count,to_root_count,to_chapter_count,coverage_complete)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      route,
      sourceSeal.locator.catalogueId,
      sourceSeal.locator.stageId,
      from.toString(),
      nextFrontier.toString(),
      sourcePage.items.length,
      snapshot.sequence.toString(),
      placementCount.toString(),
      rootCount.toString(),
      chapterCount.toString(),
      exhausted,
    ],
  );
  const updated = await readCandidate(tx, sourceSeal, false);
  if (!updated)
    throw new HostedVersionReleaseCandidateError('source-mismatch', 'The release candidate frontier was lost');
  return {
    replayed: false,
    processed: sourcePage.items.length,
    checkpoint: checkpoint(updated),
    snapshot,
  };
}

/** Seal complete indexed coverage without a source reread or catalogue pointer write. */
export async function sealHostedVersionReleaseCandidate(
  tx: CommandTransaction,
  actorInput: Actor,
  sourceSeal: HostedPublicationStagingSeal,
): Promise<Readonly<{ replayed: boolean; candidate: HostedVersionReleaseCandidateSeal }>> {
  const actor = accountActor(actorInput);
  await requireCurrentSource(tx, actor, sourceSeal);
  const row = await readCandidate(tx, sourceSeal, true);
  if (!row) throw new HostedVersionReleaseCandidateNotFoundError();
  assertCandidateBinding(row, actor, sourceSeal);
  if (row.status === 'sealed') {
    const snapshot = await exactSnapshot(tx, row);
    return { replayed: true, candidate: candidateSeal(row, snapshot) };
  }
  if (!row.coverage_complete || BigInt(row.placement_count) !== BigInt(row.source_candidate_count))
    throw new HostedVersionReleaseCandidateError(
      'incomplete-source',
      'The selected candidate has not reached full coverage',
    );
  if (activePathFromRow(row).length !== 0)
    throw new HostedVersionReleaseCandidateError('incomplete-source', 'The final selected path has not been closed');
  const snapshot = await currentSnapshot(tx, row);
  await tx.query(
    `UPDATE content.hosted_version_release_candidate
     SET status='sealed',sealed_at=transaction_timestamp(),updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND status='building' AND coverage_complete`,
    [row.route, row.catalogue_id, row.stage_id],
  );
  const sealed = await readCandidate(tx, sourceSeal, false);
  if (!sealed) throw new HostedVersionReleaseCandidateError('source-mismatch', 'The sealed candidate was not retained');
  return { replayed: false, candidate: candidateSeal(sealed, snapshot) };
}

function candidateSeal(row: CandidateRow, snapshot: HostedVersionSnapshot): HostedVersionReleaseCandidateSeal {
  const coverage: HostedVersionReleaseCandidateCoverage = {
    sourceCandidateCount: row.source_candidate_count,
    placementCount: row.placement_count,
    rootCount: row.root_next_position,
    chapterCount: row.chapter_count,
    complete: true,
  };
  return {
    candidateId: row.stage_id,
    sourceSeal: sealFromRow(row),
    snapshot,
    coverage,
  };
}
