import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import {
  createVersionedOutlineSequenceReadWriteSet,
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceReadWriteSet,
} from './versioned-outline-sequence.ts';
import commitVersion from './hosted-version-commit.sql';
import createGeneration from './hosted-version-create-generation.sql';
import readHead from './hosted-version-read-head.sql';
import readNode from './hosted-version-read-node.sql';
import readOccurrence from './hosted-version-read-occurrence.sql';
import readSiblingRoot from './hosted-version-read-sibling-root.sql';
import readSnapshot from './hosted-version-read-snapshot.sql';
import {
  HostedVersionHeadChangedError,
  InvalidHostedVersionIdentityError,
  HOSTED_VERSION_INDEX_KINDS,
  type HostedVersionGenerationKind,
  type HostedVersionIndexKind,
  type HostedVersionOccurrenceState,
  type HostedVersionOccurrenceValue,
  type HostedVersionSiblingRoot,
  type HostedVersionSnapshot,
  type HostedVersionSnapshotRoots,
} from './hosted-version-model.ts';

type SnapshotRow = {
  route: number;
  catalogue_id: string;
  generation_id: string;
  generation_kind: HostedVersionGenerationKind;
  sequence: string;
  preorder_root_id: string | null;
  chapter_root_id: string | null;
  placement_count: string;
  chapter_count: string;
};
type NodeRow = {
  node_id: string;
  tree_parent_id: string | null;
  node_state: EncodedValue;
  is_deleted: boolean;
  sequence: string;
};
type OccurrenceRow = {
  occurrence_id: string;
  parent_occurrence_id: string | null;
  subtree_size: string;
  occurrence_state: EncodedValue;
  is_deleted: boolean;
  sequence: string;
};
type SiblingRootRow = { parent_id: string | null; root_node_id: string | null; sequence: string };

const ROOT_KEY = '00000000-0000-0000-0000-000000000000';
type EncodedValue =
  | Readonly<{ kind: 'bigint'; value: string }>
  | Readonly<{ kind: 'array'; value: readonly EncodedValue[] }>
  | Readonly<{ kind: 'object'; value: readonly (readonly [string, EncodedValue])[] }>
  | Readonly<{ kind: 'primitive'; value: string | number | boolean | null }>;
type PersistedSequenceNode<Value> = Omit<VersionedOutlineSequenceNode<Value>, 'id' | 'treeParentId'>;
type SequenceWriteSet<Value> = VersionedOutlineSequenceReadWriteSet<Value>;
type OccurrenceWrite = Readonly<{
  occurrenceId: string;
  parentOccurrenceId: string | null;
  subtreeSize: bigint;
  value: unknown | null;
}>;
type SiblingRootWrite = Readonly<{
  parentOccurrenceId: string | null;
  parentIsNull: boolean;
  parentKey: string;
  rootNodeId: string | null;
}>;
type Overlay<Value> = {
  sequences: Map<HostedVersionIndexKind, SequenceWriteSet<Value>>;
  occurrences: Map<string, OccurrenceWrite>;
  siblingRoots: Map<string, SiblingRootWrite>;
  roots: HostedVersionSnapshotRoots;
};

/** One transaction overlay, with a producer-owned final-per-ID node map for each index. */
export type HostedVersionWrite<Value extends object> = Readonly<{
  snapshot: HostedVersionSnapshot;
  sequence: bigint;
}>;
const overlays = new WeakMap<object, unknown>();

function routeForOwner(catalogueId: string, generationId: string): number {
  const route = routeOf(catalogueId);
  if (route === null || routeOf(generationId) !== route) throw new InvalidHostedVersionIdentityError();
  return route;
}

function checkOwnedId(route: number, id: string | null): void {
  if (id !== null && routeOf(id) !== route) throw new InvalidHostedVersionIdentityError();
}

function checkSnapshot(snapshot: HostedVersionSnapshot): void {
  if (routeForOwner(snapshot.catalogueId, snapshot.generationId) !== snapshot.route || snapshot.sequence < 0n)
    throw new InvalidHostedVersionIdentityError();
}

function snapshotFromRow(row: SnapshotRow): HostedVersionSnapshot {
  const snapshot = {
    route: row.route,
    catalogueId: row.catalogue_id,
    generationId: row.generation_id,
    generationKind: row.generation_kind,
    sequence: BigInt(row.sequence),
    preorderRootId: row.preorder_root_id,
    chapterRootId: row.chapter_root_id,
    placementCount: BigInt(row.placement_count),
    chapterCount: BigInt(row.chapter_count),
  } satisfies HostedVersionSnapshot;
  checkSnapshot(snapshot);
  return Object.freeze(snapshot);
}

/** Encode BigInt fields without JSON number conversion or collisions with owner value keys. */
function encodeValue(value: unknown): EncodedValue {
  if (typeof value === 'bigint') return { kind: 'bigint', value: value.toString() };
  if (Array.isArray(value)) return { kind: 'array', value: value.map(encodeValue) };
  if (value && typeof value === 'object')
    return { kind: 'object', value: Object.entries(value).map(([key, item]) => [key, encodeValue(item)] as const) };
  return { kind: 'primitive', value: value as string | number | boolean | null };
}

function decodeValue<Value>(value: EncodedValue): Value {
  const revive = (item: EncodedValue): unknown => {
    if (item.kind === 'bigint') return BigInt(item.value);
    if (item.kind === 'array') return item.value.map(revive);
    if (item.kind === 'object') return Object.fromEntries(item.value.map(([key, child]) => [key, revive(child)]));
    return item.value;
  };
  return revive(value) as Value;
}

function overlayFor<Value extends object>(write: HostedVersionWrite<Value>): Overlay<Value> {
  const overlay = overlays.get(write);
  if (!overlay) throw new InvalidHostedVersionIdentityError();
  return overlay as Overlay<Value>;
}

/** Creates an empty private generation and its first exact empty snapshot. */
export async function createHostedVersionGeneration(
  client: AccessClient,
  catalogueId: string,
  generationId: string,
  generationKind: HostedVersionGenerationKind,
): Promise<HostedVersionSnapshot> {
  const route = routeForOwner(catalogueId, generationId);
  const row = (
    await client.query<SnapshotRow>(createGeneration.sql, [route, catalogueId, generationId, generationKind])
  ).rows[0];
  if (!row) throw new Error('Hosted version generation was not created');
  return snapshotFromRow(row);
}

/** Exact snapshots are isolated by the complete owner and generation identity. */
export async function readHostedVersionSnapshot(
  client: AccessClient,
  catalogueId: string,
  generationId: string,
  sequence: bigint,
): Promise<HostedVersionSnapshot | null> {
  const route = routeForOwner(catalogueId, generationId);
  if (sequence < 0n) return null;
  const row = (
    await client.query<SnapshotRow>(readSnapshot.sql, [route, catalogueId, generationId, sequence.toString()])
  ).rows[0];
  return row ? snapshotFromRow(row) : null;
}

/** Reads only the generation head and its matching root tuple; it never enumerates sources. */
export async function readHostedVersionHead(
  client: AccessClient,
  catalogueId: string,
  generationId: string,
): Promise<HostedVersionSnapshot | null> {
  const route = routeForOwner(catalogueId, generationId);
  const row = (await client.query<SnapshotRow>(readHead.sql, [route, catalogueId, generationId])).rows[0];
  return row ? snapshotFromRow(row) : null;
}

/** One equality-prefix predecessor query, pinned to the immutable snapshot selected by the core port. */
async function readHostedVersionSequenceNode<Value extends object>(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  indexKind: HostedVersionIndexKind,
  nodeId: string,
): Promise<VersionedOutlineSequenceNode<Value> | null> {
  checkSnapshot(snapshot);
  checkOwnedId(snapshot.route, nodeId);
  const row = (
    await client.query<NodeRow>(readNode.sql, [
      snapshot.route,
      snapshot.catalogueId,
      snapshot.generationId,
      indexKind,
      nodeId,
      snapshot.sequence.toString(),
    ])
  ).rows[0];
  if (!row || row.is_deleted) return null;
  return {
    id: row.node_id,
    treeParentId: row.tree_parent_id,
    ...decodeValue<PersistedSequenceNode<Value>>(row.node_state),
  };
}

/** Product containment state is read independently from index-tree node state. */
export async function readHostedVersionOccurrence<Value extends object>(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  occurrenceId: string,
): Promise<HostedVersionOccurrenceValue<Value> | null> {
  checkSnapshot(snapshot);
  checkOwnedId(snapshot.route, occurrenceId);
  const row = (
    await client.query<OccurrenceRow>(readOccurrence.sql, [
      snapshot.route,
      snapshot.catalogueId,
      snapshot.generationId,
      occurrenceId,
      snapshot.sequence.toString(),
    ])
  ).rows[0];
  if (!row || row.is_deleted) return null;
  return {
    occurrenceId: row.occurrence_id,
    parentOccurrenceId: row.parent_occurrence_id,
    subtreeSize: BigInt(row.subtree_size),
    value: decodeValue<Value>(row.occurrence_state),
    sequence: BigInt(row.sequence),
  };
}

/** Finds the last root row for one exact sibling parent at or before the snapshot. */
export async function readHostedVersionSiblingRoot(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
  parentOccurrenceId: string | null,
): Promise<HostedVersionSiblingRoot | null> {
  checkSnapshot(snapshot);
  checkOwnedId(snapshot.route, parentOccurrenceId);
  const row = (
    await client.query<SiblingRootRow>(readSiblingRoot.sql, [
      snapshot.route,
      snapshot.catalogueId,
      snapshot.generationId,
      parentOccurrenceId === null,
      parentOccurrenceId ?? ROOT_KEY,
      snapshot.sequence.toString(),
    ])
  ).rows[0];
  return row
    ? { parentOccurrenceId: row.parent_id, rootNodeId: row.root_node_id, sequence: BigInt(row.sequence) }
    : null;
}

/** Creates the producer's snapshot reader and final-per-ID node overlays for all three Book indexes. */
export function createHostedVersionWrite<Value extends object>(
  client: AccessClient,
  snapshot: HostedVersionSnapshot,
): HostedVersionWrite<Value> {
  checkSnapshot(snapshot);
  const boundSnapshot = Object.freeze({ ...snapshot });
  const write: HostedVersionWrite<Value> = Object.freeze({
    snapshot: boundSnapshot,
    sequence: boundSnapshot.sequence + 1n,
  });
  const sequences = new Map<HostedVersionIndexKind, SequenceWriteSet<Value>>();
  for (const indexKind of HOSTED_VERSION_INDEX_KINDS)
    sequences.set(
      indexKind,
      createVersionedOutlineSequenceReadWriteSet<Value>((id) =>
        readHostedVersionSequenceNode<Value>(client, boundSnapshot, indexKind, id),
      ),
    );
  overlays.set(write, {
    sequences,
    occurrences: new Map(),
    siblingRoots: new Map(),
    roots: {
      preorderRootId: snapshot.preorderRootId,
      chapterRootId: snapshot.chapterRootId,
      placementCount: snapshot.placementCount,
      chapterCount: snapshot.chapterCount,
    },
  } satisfies Overlay<Value>);
  return write;
}

/** Return the producer-owned write set for one sibling, preorder, or chapter forest. */
export function hostedVersionSequence<Value extends object>(
  write: HostedVersionWrite<Value>,
  indexKind: HostedVersionIndexKind,
): VersionedOutlineSequenceReadWriteSet<Value> {
  return overlayFor<Value>(write).sequences.get(indexKind)!;
}

/** Stage final Book containment state; removed occurrences retain only a tombstone in this sequence. */
export function stageHostedVersionOccurrence<Value extends object>(
  write: HostedVersionWrite<Value>,
  occurrenceId: string,
  value: HostedVersionOccurrenceState<Value> | null,
): void {
  const { snapshot } = write;
  checkOwnedId(snapshot.route, occurrenceId);
  if (value) {
    checkOwnedId(snapshot.route, value.parentOccurrenceId);
    if (value.subtreeSize < 1n) throw new InvalidHostedVersionIdentityError();
  }
  overlayFor(write).occurrences.set(occurrenceId, {
    occurrenceId,
    parentOccurrenceId: value?.parentOccurrenceId ?? null,
    subtreeSize: value?.subtreeSize ?? 0n,
    value: value === null ? null : value.value,
  });
}

/** Stage the final sibling root for a product parent, including an explicit empty root. */
export function stageHostedVersionSiblingRoot<Value extends object>(
  write: HostedVersionWrite<Value>,
  parentOccurrenceId: string | null,
  rootNodeId: string | null,
): void {
  const { snapshot } = write;
  checkOwnedId(snapshot.route, parentOccurrenceId);
  checkOwnedId(snapshot.route, rootNodeId);
  const parentIsNull = parentOccurrenceId === null;
  const parentKey = parentOccurrenceId ?? ROOT_KEY;
  overlayFor(write).siblingRoots.set(parentIsNull ? 'root' : parentKey, {
    parentOccurrenceId,
    parentIsNull,
    parentKey,
    rootNodeId,
  });
}

/** Carry forward untouched index roots while replacing the new snapshot tuple. */
export function stageHostedVersionSnapshotRoots<Value extends object>(
  write: HostedVersionWrite<Value>,
  roots: HostedVersionSnapshotRoots,
): void {
  const { snapshot } = write;
  checkOwnedId(snapshot.route, roots.preorderRootId);
  checkOwnedId(snapshot.route, roots.chapterRootId);
  if (roots.placementCount < 0n || roots.chapterCount < 0n || roots.chapterCount > roots.placementCount)
    throw new InvalidHostedVersionIdentityError();
  overlayFor(write).roots = roots;
}

/**
 * Atomically advances the one generation head fence and appends each producer overlay's final node per ID.
 * Callers provide their normal owner transaction; a failed insert rolls the fence back with the statement.
 */
export async function commitHostedVersionWrite<Value extends object>(
  client: AccessClient,
  write: HostedVersionWrite<Value>,
): Promise<HostedVersionSnapshot> {
  const overlay = overlayFor(write);
  const { snapshot } = write;
  checkSnapshot(snapshot);
  const nodeRows = [...overlay.sequences].flatMap(([indexKind, sequence]) =>
    [...sequence.nodeWrites.values()].map((node) => {
      const { id: nodeId, treeParentId, ...state } = node;
      return {
        index_kind: indexKind,
        node_id: nodeId,
        tree_parent_id: treeParentId,
        node_state: encodeValue(state),
        is_deleted: false,
      };
    }),
  );
  const occurrenceRows = [...overlay.occurrences.values()].map((row) => ({
    occurrence_id: row.occurrenceId,
    parent_occurrence_id: row.parentOccurrenceId,
    subtree_size: row.subtreeSize.toString(),
    occurrence_state: row.value === null ? null : encodeValue(row.value),
    is_deleted: row.value === null,
  }));
  const siblingRootRows = [...overlay.siblingRoots.values()].map((row) => ({
    parent_id: row.parentOccurrenceId,
    parent_is_null: row.parentIsNull,
    parent_key: row.parentKey,
    root_node_id: row.rootNodeId,
  }));
  const row = (
    await client.query<{ sequence: string }>(commitVersion.sql, [
      snapshot.route,
      snapshot.catalogueId,
      snapshot.generationId,
      write.sequence.toString(),
      snapshot.sequence.toString(),
      JSON.stringify(nodeRows),
      JSON.stringify(occurrenceRows),
      JSON.stringify(siblingRootRows),
      overlay.roots.preorderRootId,
      overlay.roots.chapterRootId,
      overlay.roots.placementCount.toString(),
      overlay.roots.chapterCount.toString(),
    ])
  ).rows[0];
  if (!row) throw new HostedVersionHeadChangedError();
  return Object.freeze({ ...snapshot, ...overlay.roots, sequence: BigInt(row.sequence) });
}
