import type { AccessClient } from '../request/access.ts';
import { newId, routeOf } from '../route/route.ts';
import { ContentNotFoundError, RevisionPreconditionError } from './commands.ts';
import { HOSTED_DEPTH_LIMIT } from './hosted-chapters-limits.ts';
import {
  InvalidHostedStructureError,
  type HostedChapterTarget,
  type HostedDraftPointInsertInput,
  type HostedDraftPointRemoveInput,
} from './hosted-chapters-model.ts';
import {
  HostedVersionDraftPointError,
  type HostedVersionDraftPointIndexes,
  type HostedVersionDraftPointInput,
  type HostedVersionDraftPointOccurrence,
  type HostedVersionDraftPointPlan,
  type HostedVersionDraftPointSelection,
} from './hosted-version-draft-points-model.ts';
import { prepareHostedVersionDraftPointPlan } from './hosted-version-draft-points.ts';
import {
  HostedVersionHeadChangedError,
  InvalidHostedVersionIdentityError,
  type HostedVersionOccurrenceValue,
  type HostedVersionSnapshot,
} from './hosted-version-model.ts';
import {
  commitHostedVersionRevision,
  HostedVersionRevisionPointerChangedError,
  resolveHostedVersionRevision,
} from './hosted-version-revision.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionMaximumChildSubtreeHeight,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
  readHostedVersionSnapshot,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
  type HostedVersionWrite,
} from './hosted-version-store.ts';
import type {
  VersionedOutlineSequenceNode,
  VersionedOutlineSequenceReadWriteSet,
} from './versioned-outline-sequence.ts';

/** Product value stored on both sequence nodes and occurrence state. */
export type HostedVersionPointValue = Readonly<{
  kind: 'part' | 'chapter';
  title: string;
  subtreeHeight: number;
  chapterCount: bigint;
  target: HostedChapterTarget | null;
}>;

export type { HostedDraftPointInsertInput, HostedDraftPointRemoveInput };

export type HostedDraftPointMutation =
  | ({ operation: 'insert' } & HostedDraftPointInsertInput)
  | ({ operation: 'remove' } & HostedDraftPointRemoveInput);

export type HostedDraftPointRevisionWrite = Readonly<{
  revisionId: string;
  recordedTransactionId: string;
  recordedAt: string;
}>;

function pointError(error: unknown): never {
  if (error instanceof HostedVersionDraftPointError) {
    if (error.code === 'stale-head') throw new RevisionPreconditionError();
    throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
  }
  if (error instanceof HostedVersionHeadChangedError || error instanceof HostedVersionRevisionPointerChangedError)
    throw new RevisionPreconditionError();
  if (error instanceof InvalidHostedVersionIdentityError)
    throw new InvalidHostedStructureError('Invalid hosted version identity');
  throw error;
}

function insertValue(input: HostedDraftPointInsertInput): HostedVersionPointValue {
  return input.placement.kind === 'chapter'
    ? {
        kind: 'chapter',
        title: input.title,
        subtreeHeight: 0,
        chapterCount: 1n,
        target: input.placement.target,
      }
    : { kind: 'part', title: input.title, subtreeHeight: 0, chapterCount: 0n, target: null };
}

function asOccurrence(
  expectedRevisionId: string,
  row: HostedVersionOccurrenceValue<HostedVersionPointValue>,
  subtreeHeight = row.value.subtreeHeight,
): HostedVersionDraftPointOccurrence {
  return {
    snapshotId: expectedRevisionId,
    occurrenceId: row.occurrenceId,
    parentId: row.parentOccurrenceId,
    kind: row.value.kind,
    subtreeSize: row.subtreeSize,
    chapterCount: row.value.chapterCount,
    subtreeHeight,
  };
}

function stringIndex(
  inner: VersionedOutlineSequenceReadWriteSet<HostedVersionPointValue>,
  payloads: Map<string, HostedVersionPointValue>,
): VersionedOutlineSequenceReadWriteSet<string> {
  const asString = (
    node: VersionedOutlineSequenceNode<HostedVersionPointValue> | null,
  ): VersionedOutlineSequenceNode<string> | null => (node === null ? null : { ...node, value: node.id });
  const nodeReads = new Map<string, VersionedOutlineSequenceNode<string> | null>();
  const nodeWrites = new Map<string, VersionedOutlineSequenceNode<string>>();
  return {
    async readNode(id) {
      const node = asString(await inner.readNode(id));
      nodeReads.set(id, node);
      return node;
    },
    writeNode(node) {
      const previous = inner.nodeWrites.get(node.id) ?? inner.nodeReads.get(node.id);
      const previousValue = previous?.value ?? payloads.get(node.id);
      if (!previousValue) throw new Error('Hosted draft point sequence write is missing its occurrence value');
      const value =
        node.subtreeHeight === undefined ||
        node.subtreeHeight === null ||
        node.subtreeHeight === previousValue.subtreeHeight
          ? previousValue
          : { ...previousValue, subtreeHeight: node.subtreeHeight };
      inner.writeNode({ ...node, value });
      nodeWrites.set(node.id, node);
    },
    nodeReads,
    nodeWrites,
    work: () => inner.work(),
  };
}

function indexesFor(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  write: HostedVersionWrite<HostedVersionPointValue>,
  payloads: Map<string, HostedVersionPointValue>,
): HostedVersionDraftPointIndexes {
  return {
    siblings: stringIndex(hostedVersionSequence(write, 'sibling'), payloads),
    preorder: stringIndex(hostedVersionSequence(write, 'preorder'), payloads),
    chapters: stringIndex(hostedVersionSequence(write, 'chapter'), payloads),
    readLegacyMaximum: async (parentId, excludedOccurrenceIds) =>
      readHostedVersionMaximumChildSubtreeHeight(client, snapshot, parentId, excludedOccurrenceIds),
  };
}

async function occurrenceIdentityExists(client: AccessClient, catalogueId: string, occurrenceId: string) {
  const route = routeOf(catalogueId);
  if (route === null || routeOf(occurrenceId) !== route) throw new InvalidHostedStructureError();
  return (
    ((
      await client.query(
        `SELECT 1 FROM content.hosted_occurrence WHERE route=$1 AND catalogue_id=$2 AND occurrence_id=$3`,
        [route, catalogueId, occurrenceId],
      )
    ).rowCount ?? 0) > 0
  );
}

async function ancestorPath(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  expectedRevisionId: string,
  parentId: string | null,
): Promise<HostedVersionDraftPointOccurrence[]> {
  const path: HostedVersionDraftPointOccurrence[] = [];
  let current = parentId;
  const seen = new Set<string>();
  while (current !== null) {
    if (seen.has(current) || path.length >= HOSTED_DEPTH_LIMIT) {
      throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
    }
    seen.add(current);
    const row = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, current);
    if (!row) throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
    path.push(asOccurrence(expectedRevisionId, row));
    current = row.parentOccurrenceId;
  }
  return path;
}

async function snapshotForDescriptor(
  client: AccessClient,
  catalogueId: string,
  generationId: string,
  generationKind: HostedVersionSnapshot['generationKind'],
  sequence: bigint,
): Promise<HostedVersionSnapshot> {
  const snapshot = await readHostedVersionSnapshot(client, catalogueId, generationId, sequence);
  if (!snapshot) throw new ContentNotFoundError();
  if (snapshot.generationKind !== generationKind || snapshot.sequence !== sequence) throw new ContentNotFoundError();
  return snapshot;
}

async function emptyLegacyPlacementCount(client: AccessClient, catalogueId: string, revisionId: string) {
  const route = routeOf(catalogueId);
  const count = (
    await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM content.hosted_placement
     WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`,
      [route, catalogueId, revisionId],
    )
  ).rows[0]!.n;
  const appends =
    (
      await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM content.hosted_append
     WHERE route=$1 AND catalogue_id=$2 AND stream_id IN (
       SELECT base_revision_id FROM content.hosted_append_descriptor
       WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3)`,
        [route, catalogueId, revisionId],
      )
    ).rows[0]?.n ?? '0';
  return BigInt(count) + BigInt(appends);
}

/** Activate one new empty draft generation for a compatibility empty head. Do not map that head. */
async function activateEmptyDraftGeneration(client: AccessClient, catalogueId: string): Promise<HostedVersionSnapshot> {
  const route = routeOf(catalogueId);
  if (route === null) throw new InvalidHostedStructureError();
  const snapshot = await createHostedVersionGeneration(client, catalogueId, newId(route), 'draft');
  if (snapshot.generationKind !== 'draft') throw new ContentNotFoundError();
  return snapshot;
}

export async function resolveHostedDraftPointSnapshot(
  client: AccessClient,
  catalogueId: string,
  expectedRevisionId: string,
): Promise<HostedVersionSnapshot> {
  const resolved = await resolveHostedVersionRevision(client, catalogueId, expectedRevisionId);
  if (resolved.kind === 'missing') throw new ContentNotFoundError();
  if (resolved.kind === 'ordered') {
    if (resolved.revisionKind !== 'structure' || resolved.snapshot.generationKind !== 'draft') {
      throw new InvalidHostedStructureError('Hosted draft point writes require an activated versioned draft');
    }
    return snapshotForDescriptor(
      client,
      catalogueId,
      resolved.snapshot.generationId,
      resolved.snapshot.generationKind,
      resolved.snapshot.sequence,
    );
  }
  if ((await emptyLegacyPlacementCount(client, catalogueId, expectedRevisionId)) !== 0n) {
    throw new InvalidHostedStructureError('Hosted draft point writes require an activated versioned draft');
  }
  return activateEmptyDraftGeneration(client, catalogueId);
}

export async function readHostedDraftPointSnapshot(
  client: AccessClient,
  catalogueId: string,
  revisionId: string,
): Promise<HostedVersionSnapshot | null> {
  const resolved = await resolveHostedVersionRevision(client, catalogueId, revisionId);
  if (resolved.kind === 'missing' || resolved.kind === 'compatibility') return null;
  return snapshotForDescriptor(
    client,
    catalogueId,
    resolved.snapshot.generationId,
    resolved.snapshot.generationKind,
    resolved.snapshot.sequence,
  );
}

async function insertOccurrenceIdentity(client: AccessClient, catalogueId: string, input: HostedDraftPointInsertInput) {
  const route = routeOf(catalogueId)!;
  const target = input.placement.kind === 'chapter' ? input.placement.target : null;
  const inserted = await client.query(
    `INSERT INTO content.hosted_occurrence(route,catalogue_id,occurrence_id,kind,thread_id,post_id)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (route,catalogue_id,occurrence_id) DO NOTHING RETURNING occurrence_id`,
    [route, catalogueId, input.occurrenceId, input.placement.kind, target?.threadId ?? null, target?.postId ?? null],
  );
  if (!inserted.rows.length) throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
}

async function selectPoint(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  input: HostedDraftPointMutation,
): Promise<HostedVersionDraftPointSelection> {
  const expectedRevisionId = input.expectedRevisionId;
  const parentId = input.operation === 'insert' ? input.parentId : null;
  if (input.operation === 'insert') {
    const parentPath = await ancestorPath(client, snapshot, expectedRevisionId, parentId);
    const before =
      input.beforeOccurrenceId === null
        ? null
        : await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, input.beforeOccurrenceId);
    if (input.beforeOccurrenceId !== null && !before) {
      throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
    }
    const siblingRoot = await readHostedVersionSiblingRoot(client, snapshot, input.parentId);
    const siblingRootByParent = await siblingRootsFor(client, snapshot, parentPath);
    return {
      operation: 'insert',
      snapshotId: expectedRevisionId,
      headRevisionId: expectedRevisionId,
      siblingRootId: siblingRoot?.rootNodeId ?? null,
      preorderRootId: snapshot.preorderRootId,
      chapterRootId: snapshot.chapterRootId,
      siblingRootByParent,
      parentPath,
      before: before ? asOccurrence(expectedRevisionId, before) : null,
      occurrenceIdentityExists: await occurrenceIdentityExists(client, snapshot.catalogueId, input.occurrenceId),
    };
  }
  const source = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, input.occurrenceId);
  if (!source) throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
  const siblingRoot = await readHostedVersionSiblingRoot(client, snapshot, source.parentOccurrenceId);
  const rawSourceAncestors = await ancestorPath(client, snapshot, expectedRevisionId, source.parentOccurrenceId);
  const siblingRootByParent = await siblingRootsFor(client, snapshot, [
    asOccurrence(expectedRevisionId, source),
    ...rawSourceAncestors,
  ]);
  return {
    operation: 'remove',
    snapshotId: expectedRevisionId,
    headRevisionId: expectedRevisionId,
    siblingRootId: siblingRoot?.rootNodeId ?? null,
    preorderRootId: snapshot.preorderRootId,
    chapterRootId: snapshot.chapterRootId,
    source: asOccurrence(expectedRevisionId, source),
    sourceAncestors: rawSourceAncestors,
    siblingRootByParent,
  };
}

async function siblingRootsFor(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  occurrences: readonly HostedVersionDraftPointOccurrence[],
): Promise<ReadonlyMap<string | null, string | null>> {
  const parents = new Set<string | null>([null]);
  for (const occurrence of occurrences) {
    parents.add(occurrence.occurrenceId);
    parents.add(occurrence.parentId);
  }
  const roots = new Map<string | null, string | null>();
  for (const parentId of parents) {
    const root = await readHostedVersionSiblingRoot(client, snapshot, parentId);
    roots.set(parentId, root?.rootNodeId ?? null);
  }
  return roots;
}

async function stagePlan(
  client: AccessClient,
  write: HostedVersionWrite<HostedVersionPointValue>,
  snapshot: HostedVersionSnapshot,
  input: HostedDraftPointMutation,
  plan: HostedVersionDraftPointPlan,
) {
  if (input.operation === 'insert') {
    stageHostedVersionOccurrence(write, input.occurrenceId, {
      parentOccurrenceId: input.parentId,
      subtreeSize: 1n,
      value: insertValue(input),
    });
  } else {
    stageHostedVersionOccurrence(write, input.occurrenceId, null);
  }
  const heightUpdates = new Map(plan.subtreeHeightUpdates.map((update) => [update.occurrenceId, update.subtreeHeight]));
  for (const delta of plan.ancestorDeltas) {
    const current = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, delta.occurrenceId);
    if (!current) throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
    stageHostedVersionOccurrence(write, delta.occurrenceId, {
      parentOccurrenceId: current.parentOccurrenceId,
      subtreeSize: delta.subtreeSize,
      value: {
        ...current.value,
        chapterCount: delta.chapterCount,
        subtreeHeight: heightUpdates.get(delta.occurrenceId) ?? current.value.subtreeHeight,
      },
    });
  }
  stageHostedVersionSiblingRoot(write, plan.parentId, plan.siblingRootId);
  const placementDelta = input.operation === 'insert' ? 1n : -plan.preorderCount;
  const chapterDelta = input.operation === 'insert' ? plan.chapterCount : -plan.chapterCount;
  stageHostedVersionSnapshotRoots(write, {
    preorderRootId: plan.preorderRootId,
    chapterRootId: plan.chapterRootId,
    placementCount: snapshot.placementCount + placementDelta,
    chapterCount: snapshot.chapterCount + chapterDelta,
  });
}

/** Plan and commit one insert or subtree removal against the producer overlay, then record the new head mapping. */
export async function commitHostedDraftPointWrite(
  client: AccessClient,
  catalogueId: string,
  revision: HostedDraftPointRevisionWrite,
  input: HostedDraftPointMutation,
): Promise<HostedVersionSnapshot> {
  try {
    const snapshot = await resolveHostedDraftPointSnapshot(client, catalogueId, input.expectedRevisionId);
    const write = createHostedVersionWrite<HostedVersionPointValue>(client, snapshot);
    const payloads = new Map<string, HostedVersionPointValue>();
    if (input.operation === 'insert') payloads.set(input.occurrenceId, insertValue(input));
    const indexes = indexesFor(client, snapshot, write, payloads);
    const selection = await selectPoint(client, snapshot, input);
    const plan = await prepareHostedVersionDraftPointPlan(input as HostedVersionDraftPointInput, selection, indexes);
    if (input.operation === 'insert') await insertOccurrenceIdentity(client, catalogueId, input);
    await stagePlan(client, write, snapshot, input, plan);
    const next = await commitHostedVersionWrite(client, write);
    if (next.generationKind !== 'draft') throw new ContentNotFoundError();
    await commitHostedVersionRevision(client, {
      revisionKind: 'structure',
      revisionId: revision.revisionId,
      snapshot: {
        route: next.route,
        catalogueId: next.catalogueId,
        generationId: next.generationId,
        generationKind: 'draft',
        sequence: next.sequence,
      },
      expectedDraftRevisionId: input.expectedRevisionId,
      recordedTransactionId: revision.recordedTransactionId,
      recordedAt: revision.recordedAt,
    });
    return next;
  } catch (error) {
    pointError(error);
  }
}

export async function readHostedVersionPointOccurrence(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  occurrenceId: string,
) {
  return readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, occurrenceId);
}
