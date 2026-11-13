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
  type HostedVersionWrite,
} from './hosted-version-model.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionHead,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
  readHostedVersionSnapshot,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
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

type VersionRevisionRow = Readonly<{
  generation_id: string;
  sequence: string;
}>;

function pointError(error: unknown): never {
  if (error instanceof HostedVersionDraftPointError) {
    if (error.code === 'stale-head') throw new RevisionPreconditionError();
    throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
  }
  if (error instanceof HostedVersionHeadChangedError) throw new RevisionPreconditionError();
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
): HostedVersionDraftPointOccurrence {
  return {
    snapshotId: expectedRevisionId,
    occurrenceId: row.occurrenceId,
    parentId: row.parentOccurrenceId,
    kind: row.value.kind,
    subtreeSize: row.subtreeSize,
    chapterCount: row.value.chapterCount,
    subtreeHeight: row.value.subtreeHeight,
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
      const value = previous?.value ?? payloads.get(node.id);
      if (!value) throw new Error('Hosted draft point sequence write is missing its occurrence value');
      inner.writeNode({ ...node, value });
      nodeWrites.set(node.id, node);
    },
    nodeReads,
    nodeWrites,
    work: () => inner.work(),
  };
}

function indexesFor(
  write: HostedVersionWrite<HostedVersionPointValue>,
  payloads: Map<string, HostedVersionPointValue>,
): HostedVersionDraftPointIndexes {
  return {
    siblings: stringIndex(hostedVersionSequence(write, 'sibling'), payloads),
    preorder: stringIndex(hostedVersionSequence(write, 'preorder'), payloads),
    chapters: stringIndex(hostedVersionSequence(write, 'chapter'), payloads),
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

async function mappedSnapshot(
  client: AccessClient,
  catalogueId: string,
  revisionId: string,
): Promise<HostedVersionSnapshot | null> {
  const route = routeOf(catalogueId);
  if (route === null || routeOf(revisionId) !== route) throw new InvalidHostedStructureError();
  const row = (
    await client.query<VersionRevisionRow>(
      `SELECT generation_id,sequence::text AS sequence
     FROM content.hosted_version_revision WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`,
      [route, catalogueId, revisionId],
    )
  ).rows[0];
  if (!row) return null;
  const snapshot = await readHostedVersionSnapshot(client, catalogueId, row.generation_id, BigInt(row.sequence));
  if (!snapshot) throw new ContentNotFoundError();
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

async function bindEmptyDraftSnapshot(
  client: AccessClient,
  catalogueId: string,
  expectedRevisionId: string,
): Promise<HostedVersionSnapshot> {
  if ((await emptyLegacyPlacementCount(client, catalogueId, expectedRevisionId)) !== 0n) {
    throw new InvalidHostedStructureError('Hosted draft point writes require an activated versioned draft');
  }
  const route = routeOf(catalogueId)!;
  const existing = (
    await client.query<{ generation_id: string }>(
      `SELECT generation_id FROM content.hosted_tree_generation
     WHERE route=$1 AND catalogue_id=$2 AND generation_kind='draft' ORDER BY created_at ASC LIMIT 1`,
      [route, catalogueId],
    )
  ).rows[0];
  const snapshot = existing
    ? await readHostedVersionHead(client, catalogueId, existing.generation_id)
    : await createHostedVersionGeneration(client, catalogueId, newId(route), 'draft');
  if (!snapshot || snapshot.generationKind !== 'draft') throw new ContentNotFoundError();
  await client.query(
    `INSERT INTO content.hosted_version_revision(route,catalogue_id,revision_id,generation_id,sequence)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (route,catalogue_id,revision_id) DO NOTHING`,
    [route, catalogueId, expectedRevisionId, snapshot.generationId, snapshot.sequence.toString()],
  );
  return (await mappedSnapshot(client, catalogueId, expectedRevisionId)) ?? snapshot;
}

export async function resolveHostedDraftPointSnapshot(
  client: AccessClient,
  catalogueId: string,
  expectedRevisionId: string,
): Promise<HostedVersionSnapshot> {
  return (
    (await mappedSnapshot(client, catalogueId, expectedRevisionId)) ??
    bindEmptyDraftSnapshot(client, catalogueId, expectedRevisionId)
  );
}

export async function readHostedDraftPointSnapshot(
  client: AccessClient,
  catalogueId: string,
  revisionId: string,
): Promise<HostedVersionSnapshot | null> {
  return mappedSnapshot(client, catalogueId, revisionId);
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
    return {
      operation: 'insert',
      snapshotId: expectedRevisionId,
      headRevisionId: expectedRevisionId,
      siblingRootId: siblingRoot?.rootNodeId ?? null,
      preorderRootId: snapshot.preorderRootId,
      chapterRootId: snapshot.chapterRootId,
      parentPath,
      before: before ? asOccurrence(expectedRevisionId, before) : null,
      occurrenceIdentityExists: await occurrenceIdentityExists(client, snapshot.catalogueId, input.occurrenceId),
    };
  }
  const source = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, input.occurrenceId);
  if (!source) throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
  const siblingRoot = await readHostedVersionSiblingRoot(client, snapshot, source.parentOccurrenceId);
  return {
    operation: 'remove',
    snapshotId: expectedRevisionId,
    headRevisionId: expectedRevisionId,
    siblingRootId: siblingRoot?.rootNodeId ?? null,
    preorderRootId: snapshot.preorderRootId,
    chapterRootId: snapshot.chapterRootId,
    source: asOccurrence(expectedRevisionId, source),
    sourceAncestors: await ancestorPath(client, snapshot, expectedRevisionId, source.parentOccurrenceId),
  };
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
  let childHeight = input.operation === 'insert' ? insertValue(input).subtreeHeight : 0;
  for (const delta of plan.ancestorDeltas) {
    const current = await readHostedVersionOccurrence<HostedVersionPointValue>(client, snapshot, delta.occurrenceId);
    if (!current) throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
    const subtreeHeight =
      input.operation === 'insert'
        ? Math.max(current.value.subtreeHeight, childHeight + 1)
        : current.value.subtreeHeight;
    stageHostedVersionOccurrence(write, delta.occurrenceId, {
      parentOccurrenceId: current.parentOccurrenceId,
      subtreeSize: delta.subtreeSize,
      value: {
        ...current.value,
        chapterCount: delta.chapterCount,
        subtreeHeight,
      },
    });
    childHeight = subtreeHeight;
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
  revisionId: string,
  input: HostedDraftPointMutation,
): Promise<HostedVersionSnapshot> {
  try {
    const snapshot = await resolveHostedDraftPointSnapshot(client, catalogueId, input.expectedRevisionId);
    const write = createHostedVersionWrite<HostedVersionPointValue>(client, snapshot);
    const payloads = new Map<string, HostedVersionPointValue>();
    if (input.operation === 'insert') payloads.set(input.occurrenceId, insertValue(input));
    const selection = await selectPoint(client, snapshot, input);
    const plan = await prepareHostedVersionDraftPointPlan(
      input as HostedVersionDraftPointInput,
      selection,
      indexesFor(write, payloads),
    );
    if (input.operation === 'insert') await insertOccurrenceIdentity(client, catalogueId, input);
    await stagePlan(client, write, snapshot, input, plan);
    const next = await commitHostedVersionWrite(client, write);
    const route = routeOf(catalogueId)!;
    await client.query(
      `INSERT INTO content.hosted_version_revision(route,catalogue_id,revision_id,generation_id,sequence)
       VALUES ($1,$2,$3,$4,$5)`,
      [route, catalogueId, revisionId, next.generationId, next.sequence.toString()],
    );
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
