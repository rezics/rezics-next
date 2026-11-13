import {
  hostedVersionSequence,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  type HostedVersionWrite,
} from './hosted-version-store.ts';
import type { HostedVersionIndexKind, HostedVersionOccurrenceState } from './hosted-version-model.ts';

export type HostedVersionMaterializedOccurrence<Value extends object> = Readonly<{
  occurrenceId: string;
  state: HostedVersionOccurrenceState<Value>;
}>;

export type HostedVersionMaterializedNode<Value extends object> = Readonly<{
  indexKind: HostedVersionIndexKind;
  id: string;
  value: Value;
  leftId: string | null;
  rightId: string | null;
  treeParentId: string | null;
  height: number;
  count: bigint;
  chapterWeight: 0n | 1n;
  chapterCount: bigint;
}>;

export type HostedVersionMaterializedSiblingRoot = Readonly<{
  parentId: string | null;
  rootId: string | null;
}>;

/** Shared temporal-store seam for bounded copies from sealed Book builders. */
export function stageHostedVersionMaterializedOccurrences<Value extends object>(
  write: HostedVersionWrite<Value>,
  occurrences: readonly HostedVersionMaterializedOccurrence<Value>[],
): void {
  for (const { occurrenceId, state } of occurrences) stageHostedVersionOccurrence(write, occurrenceId, state);
}

export function stageHostedVersionMaterializedNodes<Value extends object>(
  write: HostedVersionWrite<Value>,
  nodes: readonly HostedVersionMaterializedNode<Value>[],
): void {
  for (const node of nodes) {
    hostedVersionSequence(write, node.indexKind).writeNode({
      id: node.id,
      value: node.value,
      leftId: node.leftId,
      rightId: node.rightId,
      treeParentId: node.treeParentId,
      height: node.height,
      count: node.count,
      chapterWeight: node.chapterWeight,
      chapterCount: node.chapterCount,
    });
  }
}

export function stageHostedVersionMaterializedSiblingRoots<Value extends object>(
  write: HostedVersionWrite<Value>,
  roots: readonly HostedVersionMaterializedSiblingRoot[],
): void {
  for (const { parentId, rootId } of roots) stageHostedVersionSiblingRoot(write, parentId, rootId);
}
