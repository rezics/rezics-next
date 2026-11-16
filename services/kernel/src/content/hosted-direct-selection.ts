import type { AccessClient } from '../request/access.ts';
import { newId, routeOf } from '../route/route.ts';
import {
  HOSTED_PLACEMENT_LIMIT,
  InvalidHostedStructureError,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';
import { ensureHostedOccurrenceIdentities } from './hosted-chapters-store.ts';
import type { HostedVersionPointValue } from './hosted-version-draft-write.ts';
import {
  createHostedVersionGeneration,
  createHostedVersionWrite,
  commitHostedVersionWrite,
  stageHostedVersionSnapshotRoots,
} from './hosted-version-store.ts';
import {
  stageHostedVersionMaterializedNodes,
  stageHostedVersionMaterializedOccurrences,
  stageHostedVersionMaterializedSiblingRoots,
  type HostedVersionMaterializedNode,
} from './hosted-version-materialization.ts';
import { commitHostedVersionRevision } from './hosted-version-revision.ts';
import type { HostedVersionIndexKind } from './hosted-version-model.ts';

type DirectSelection = Readonly<{
  revisionId: string;
  transactionId: string;
  recordedAt: string;
  expectedDraftRevisionId: string;
}> &
  (Readonly<{ kind: 'structure' }> | Readonly<{ kind: 'publication'; expectedPublicationId: string | null }>);

/** Public request ingestion initializes the existing ordered owner directly. Work and storage follow only
 * the bounded input, never the prior book, its revision history or an old implementation format. */
export async function commitHostedDirectSelection(
  client: AccessClient,
  catalogueId: string,
  placements: readonly OrderedHostedPlacement[],
  selection: DirectSelection,
) {
  if (placements.length > HOSTED_PLACEMENT_LIMIT) throw new InvalidHostedStructureError();
  await materializeHostedSelection(client, catalogueId, placements, selection);
}

/** Initialize an ordered generation from validated preorder placements. */
export async function materializeHostedSelection(
  client: AccessClient,
  catalogueId: string,
  placements: readonly OrderedHostedPlacement[],
  selection: DirectSelection,
) {
  const route = routeOf(catalogueId);
  if (route === null) throw new InvalidHostedStructureError();
  await ensureHostedOccurrenceIdentities(client, catalogueId, placements);
  const children = new Map<string | null, OrderedHostedPlacement[]>();
  const values = new Map<string, HostedVersionPointValue>();
  const sizes = new Map<string, bigint>();
  for (const placement of placements) {
    const siblings = children.get(placement.parentId) ?? [];
    siblings.push(placement);
    children.set(placement.parentId, siblings);
  }
  for (let index = placements.length - 1; index >= 0; index--) {
    const placement = placements[index]!;
    const descendants = children.get(placement.occurrenceId) ?? [];
    let subtreeSize = 1n;
    let chapterCount = placement.kind === 'chapter' ? 1n : 0n;
    let subtreeHeight = 0;
    for (const child of descendants) {
      const value = values.get(child.occurrenceId);
      if (!value) throw new InvalidHostedStructureError('Ordered input must visit each parent before its children');
      subtreeSize += sizes.get(child.occurrenceId)!;
      chapterCount += value.chapterCount;
      subtreeHeight = Math.max(subtreeHeight, value.subtreeHeight + 1);
    }
    values.set(placement.occurrenceId, {
      kind: placement.kind,
      title: placement.title,
      subtreeHeight,
      chapterCount,
      target: placement.kind === 'chapter' ? placement.target : null,
      ...(placement.kind === 'chapter' && placement.bodyLanguages !== undefined
        ? { bodyLanguages: placement.bodyLanguages }
        : {}),
    });
    sizes.set(placement.occurrenceId, subtreeSize);
  }
  const empty = await createHostedVersionGeneration(
    client,
    catalogueId,
    newId(route),
    selection.kind === 'structure' ? 'draft' : 'candidate',
  );
  const write = createHostedVersionWrite<HostedVersionPointValue>(client, empty);
  const nodes: HostedVersionMaterializedNode<HostedVersionPointValue>[] = [];
  const balanced = (items: readonly OrderedHostedPlacement[], indexKind: HostedVersionIndexKind): string | null => {
    const build = (
      start: number,
      end: number,
      parentId: string | null,
    ): HostedVersionMaterializedNode<HostedVersionPointValue> | null => {
      if (start === end) return null;
      const middle = start + Math.floor((end - start) / 2);
      const placement = items[middle]!;
      const id = placement.occurrenceId;
      const left = build(start, middle, id);
      const right = build(middle + 1, end, id);
      const chapterWeight = placement.kind === 'chapter' ? 1n : 0n;
      const node: HostedVersionMaterializedNode<HostedVersionPointValue> = {
        indexKind,
        id,
        value: values.get(id)!,
        leftId: left?.id ?? null,
        rightId: right?.id ?? null,
        treeParentId: parentId,
        height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0),
        count: 1n + (left?.count ?? 0n) + (right?.count ?? 0n),
        chapterWeight,
        chapterCount: chapterWeight + (left?.chapterCount ?? 0n) + (right?.chapterCount ?? 0n),
      };
      nodes.push(node);
      return node;
    };
    return build(0, items.length, null)?.id ?? null;
  };
  const roots = [{ parentId: null as string | null, rootId: balanced(children.get(null) ?? [], 'sibling') }];
  for (const placement of placements)
    if (placement.kind === 'part')
      roots.push({
        parentId: placement.occurrenceId,
        rootId: balanced(children.get(placement.occurrenceId) ?? [], 'sibling'),
      });
  const preorderRootId = balanced(placements, 'preorder');
  const chapters = placements.filter((placement) => placement.kind === 'chapter');
  const chapterRootId = balanced(chapters, 'chapter');
  stageHostedVersionMaterializedNodes(write, nodes);
  stageHostedVersionMaterializedOccurrences(
    write,
    placements.map((placement) => ({
      occurrenceId: placement.occurrenceId,
      state: {
        parentOccurrenceId: placement.parentId,
        subtreeSize: sizes.get(placement.occurrenceId)!,
        value: values.get(placement.occurrenceId)!,
      },
    })),
  );
  stageHostedVersionMaterializedSiblingRoots(write, roots);
  stageHostedVersionSnapshotRoots(write, {
    preorderRootId,
    chapterRootId,
    placementCount: BigInt(placements.length),
    chapterCount: BigInt(chapters.length),
  });
  const committed = await commitHostedVersionWrite(client, write);
  const snapshot = { route, catalogueId, generationId: committed.generationId, sequence: committed.sequence };
  const recorded = {
    revisionId: selection.revisionId,
    recordedTransactionId: selection.transactionId,
    recordedAt: selection.recordedAt,
    expectedDraftRevisionId: selection.expectedDraftRevisionId,
  };
  if (selection.kind === 'structure')
    await commitHostedVersionRevision(client, {
      ...recorded,
      revisionKind: 'structure',
      snapshot: { ...snapshot, generationKind: 'draft' },
    });
  else
    await commitHostedVersionRevision(client, {
      ...recorded,
      revisionKind: 'publication',
      expectedPublicationId: selection.expectedPublicationId,
      snapshot: { ...snapshot, generationKind: 'candidate' },
    });
}
