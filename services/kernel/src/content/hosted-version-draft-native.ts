import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import {
  chapterRankVersionedOutlineSequenceNodes,
  readVersionedOutlineSequenceRanks,
  selectVersionedOutlineSequenceChapters,
  selectVersionedOutlineSequenceNodes,
} from './versioned-outline-sequence.ts';
import { HOSTED_DEPTH_LIMIT } from './hosted-chapters-model.ts';
import {
  HostedVersionHeadChangedError,
  InvalidHostedVersionIdentityError,
  type HostedVersionSnapshot,
} from './hosted-version-model.ts';
import {
  HostedVersionDraftMoveError,
  type HostedVersionDraftMoveAncestor,
  type HostedVersionDraftMoveIndexes,
  type HostedVersionDraftMoveInput,
  type HostedVersionDraftMoveNativeAdapter,
  type HostedVersionDraftMoveNativeSnapshot,
  type HostedVersionDraftMoveOccurrence,
  type HostedVersionDraftMoveSelection,
} from './hosted-version-draft-edit-model.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionHead,
  readHostedVersionMaximumChildSubtreeHeight,
  readHostedVersionOccurrences,
  readHostedVersionSiblingRoots,
  readHostedVersionSnapshot,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
} from './hosted-version-store.ts';
import type {
  VersionedOutlineSequenceNode,
  VersionedOutlineSequenceReadWriteSet,
  VersionedOutlineSequenceRanks,
} from './versioned-outline-sequence.ts';
import { HostedVersionRevisionPointerChangedError, commitHostedVersionRevision } from './hosted-version-revision.ts';
import type {
  HostedVersionDraftMoveDescriptor,
  HostedVersionDraftMoveNativeContext,
  HostedVersionDraftMoveSelectedOccurrence,
  HostedVersionDraftMoveStoredValue,
} from './hosted-version-draft-native-model.ts';
import readHead from './hosted-version-draft-native-read-head.sql';

type DraftHeadRow = Readonly<{ head_revision_id: string }>;

const HOSTED_VERSION_SIBLING_ROOT_BATCH_SIZE = 512;

const contexts = new WeakMap<object, HostedVersionDraftMoveNativeContext>();

function invalidAnchor(): never {
  throw new HostedVersionDraftMoveError('invalid-anchor');
}

function occurrenceFact(
  revisionId: string,
  occurrence: HostedVersionDraftMoveSelectedOccurrence,
  subtreeHeight = occurrence.value.subtreeHeight,
): HostedVersionDraftMoveOccurrence {
  return {
    snapshotId: revisionId,
    occurrenceId: occurrence.occurrenceId,
    parentId: occurrence.parentOccurrenceId,
    kind: occurrence.value.kind,
    subtreeSize: occurrence.subtreeSize,
    subtreeHeight,
    chapterCount: occurrence.value.chapterCount,
  };
}

function ancestorFact(
  revisionId: string,
  occurrence: HostedVersionDraftMoveSelectedOccurrence,
  subtreeHeight = occurrence.value.subtreeHeight,
): HostedVersionDraftMoveAncestor {
  return {
    snapshotId: revisionId,
    occurrenceId: occurrence.occurrenceId,
    parentId: occurrence.parentOccurrenceId,
    subtreeSize: occurrence.subtreeSize,
    chapterCount: occurrence.value.chapterCount,
    subtreeHeight,
  };
}

function stringIndex(
  inner: VersionedOutlineSequenceReadWriteSet<HostedVersionDraftMoveStoredValue>,
  occurrences: ReadonlyMap<string, HostedVersionDraftMoveSelectedOccurrence>,
): VersionedOutlineSequenceReadWriteSet<string> {
  const asString = (
    node: VersionedOutlineSequenceNode<HostedVersionDraftMoveStoredValue> | null,
  ): VersionedOutlineSequenceNode<string> | null => (node === null ? null : { ...node, value: node.id });
  const nodeReads = new Map<string, VersionedOutlineSequenceNode<string> | null>();
  const nodeWrites = new Map<string, VersionedOutlineSequenceNode<string>>();
  return {
    async readNode(id) {
      const node = asString(await inner.readNode(id));
      nodeReads.set(id, node);
      return node;
    },
    async readNodes(ids) {
      const selected = await inner.readNodes(ids);
      const nodes = new Map<string, VersionedOutlineSequenceNode<string> | null>();
      for (const [id, node] of selected) {
        const mapped = asString(node);
        nodeReads.set(id, mapped);
        nodes.set(id, mapped);
      }
      return nodes;
    },
    writeNode(node) {
      const previous = inner.nodeWrites.get(node.id) ?? inner.nodeReads.get(node.id);
      const storedValue: unknown = previous?.value;
      const previousValue =
        storedValue !== null && typeof storedValue === 'object'
          ? storedValue
          : (occurrences.get(node.id)?.value ?? storedValue);
      if (!previousValue) throw new InvalidHostedVersionIdentityError();
      const value =
        node.subtreeHeight === undefined ||
        (typeof previousValue === 'object' &&
          previousValue !== null &&
          node.subtreeHeight === (previousValue as HostedVersionDraftMoveStoredValue).subtreeHeight)
          ? previousValue
          : { ...(previousValue as HostedVersionDraftMoveStoredValue), subtreeHeight: node.subtreeHeight };
      inner.writeNode({ ...node, value: value as HostedVersionDraftMoveStoredValue });
      nodeWrites.set(node.id, node);
    },
    nodeReads,
    nodeWrites,
    work: () => inner.work(),
  };
}

function assertDescriptorIdentity(
  route: number,
  catalogueId: string,
  expectedRevisionId: string,
  descriptor: HostedVersionDraftMoveDescriptor,
): void {
  const snapshot = descriptor.snapshot;
  if (
    descriptor.revisionId !== expectedRevisionId ||
    descriptor.revisionKind !== 'structure' ||
    snapshot.route !== route ||
    snapshot.catalogueId !== catalogueId ||
    snapshot.generationKind !== 'draft' ||
    routeOf(snapshot.generationId) !== route ||
    routeOf(descriptor.revisionId) !== route
  ) {
    throw new InvalidHostedVersionIdentityError();
  }
}

function assertSnapshotIdentity(snapshot: HostedVersionSnapshot, descriptor: HostedVersionDraftMoveDescriptor): void {
  const selected = descriptor.snapshot;
  if (
    snapshot.route !== selected.route ||
    snapshot.catalogueId !== selected.catalogueId ||
    snapshot.generationId !== selected.generationId ||
    snapshot.generationKind !== selected.generationKind ||
    snapshot.sequence !== selected.sequence
  ) {
    throw new InvalidHostedVersionIdentityError();
  }
}

function assertRequestIdsUseRoute(route: number, input: HostedVersionDraftMoveInput): void {
  if (
    routeOf(input.occurrenceId) !== route ||
    (input.parentId !== null && routeOf(input.parentId) !== route) ||
    (input.beforeOccurrenceId !== null && routeOf(input.beforeOccurrenceId) !== route)
  ) {
    invalidAnchor();
  }
}

async function assertRootSummary(
  snapshot: HostedVersionSnapshot,
  preorder: HostedVersionDraftMoveIndexes['preorder'],
  chapters: HostedVersionDraftMoveIndexes['chapters'],
): Promise<void> {
  const preorderRoot = snapshot.preorderRootId === null ? null : await preorder.readNode(snapshot.preorderRootId);
  if (snapshot.preorderRootId !== null && preorderRoot === null) {
    throw new Error('Hosted version preorder snapshot root is missing');
  }
  if (
    (preorderRoot?.count ?? 0n) !== snapshot.placementCount ||
    (preorderRoot?.chapterCount ?? 0n) !== snapshot.chapterCount
  ) {
    throw new Error('Hosted version draft snapshot roots do not match their aggregate counts');
  }

  const chapterRoot = snapshot.chapterRootId === null ? null : await chapters.readNode(snapshot.chapterRootId);
  if (snapshot.chapterRootId !== null && chapterRoot === null) {
    throw new Error('Hosted version chapter snapshot root is missing');
  }
  if ((chapterRoot?.count ?? 0n) !== snapshot.chapterCount) {
    throw new Error('Hosted version chapter root does not match its snapshot count');
  }
}

/** Bind move selection and persistence to one descriptor-selected store overlay. */
export function createHostedVersionDraftMoveNativeAdapter(): HostedVersionDraftMoveNativeAdapter<CommandTransaction> {
  return {
    async selectExpectedSnapshot(tx, catalogueId, input, descriptor) {
      const route = routeOf(catalogueId);
      if (route === null) throw new InvalidHostedVersionIdentityError();
      assertRequestIdsUseRoute(route, input);
      assertDescriptorIdentity(route, catalogueId, input.expectedRevisionId, descriptor);

      const head = (await tx.query<DraftHeadRow>(readHead.sql, [route, catalogueId])).rows[0];
      if (!head || head.head_revision_id !== descriptor.revisionId) {
        throw new HostedVersionDraftMoveError('stale-head');
      }

      const snapshot = await readHostedVersionSnapshot(
        tx,
        catalogueId,
        descriptor.snapshot.generationId,
        descriptor.snapshot.sequence,
      );
      if (snapshot === null) throw new InvalidHostedVersionIdentityError();
      assertSnapshotIdentity(snapshot, descriptor);

      const versionHead = await readHostedVersionHead(tx, catalogueId, snapshot.generationId);
      if (versionHead === null) throw new InvalidHostedVersionIdentityError();
      if (versionHead.sequence !== snapshot.sequence) throw new HostedVersionDraftMoveError('stale-head');
      assertSnapshotIdentity(versionHead, descriptor);

      const storeWrite = createHostedVersionWrite<HostedVersionDraftMoveStoredValue>(tx, snapshot);
      const occurrences = new Map<string, HostedVersionDraftMoveSelectedOccurrence>();
      const indexes: HostedVersionDraftMoveIndexes = {
        siblings: stringIndex(hostedVersionSequence(storeWrite, 'sibling'), occurrences),
        preorder: stringIndex(hostedVersionSequence(storeWrite, 'preorder'), occurrences),
        chapters: stringIndex(hostedVersionSequence(storeWrite, 'chapter'), occurrences),
        readLegacyMaximum: (parentId, excludedOccurrenceIds) =>
          readHostedVersionMaximumChildSubtreeHeight(tx, snapshot, parentId, excludedOccurrenceIds),
      };
      await assertRootSummary(snapshot, indexes.preorder, indexes.chapters);

      const readOccurrences = async (ids: readonly string[]): Promise<void> => {
        const missing = [...new Set(ids)].filter((id) => !occurrences.has(id));
        if (missing.length === 0) return;
        const selected = await readHostedVersionOccurrences<HostedVersionDraftMoveStoredValue>(tx, snapshot, missing);
        for (const id of missing) {
          const occurrence = selected.get(id);
          if (occurrence === undefined) invalidAnchor();
          occurrences.set(id, occurrence);
        }
      };

      await readOccurrences([
        input.occurrenceId,
        ...(input.parentId === null ? [] : [input.parentId]),
        ...(input.beforeOccurrenceId === null ? [] : [input.beforeOccurrenceId]),
      ]);
      const source = occurrences.get(input.occurrenceId)!;
      const destinationParent = input.parentId === null ? null : occurrences.get(input.parentId)!;
      const before = input.beforeOccurrenceId === null ? null : occurrences.get(input.beforeOccurrenceId)!;
      if (source.parentOccurrenceId === null && input.occurrenceId === input.parentId) invalidAnchor();
      if (destinationParent !== null && destinationParent.value.kind !== 'part') invalidAnchor();
      if (before !== null && before.parentOccurrenceId !== input.parentId) invalidAnchor();

      // Discover only the two containment paths. Parent identities depend on the preceding level;
      // defer rank/aggregate work until all participants are known so shared AVL paths load together.
      const sourcePath: HostedVersionDraftMoveSelectedOccurrence[] = [];
      const destinationPath: HostedVersionDraftMoveSelectedOccurrence[] = [];
      const paths = [
        { child: source, ancestors: sourcePath },
        ...(destinationParent === null ? [] : [{ child: destinationParent, ancestors: destinationPath }]),
      ];
      while (true) {
        const active = paths.filter(({ child }) => child.parentOccurrenceId !== null);
        if (active.length === 0) break;
        for (const { ancestors } of active) {
          if (ancestors.length >= HOSTED_DEPTH_LIMIT) invalidAnchor();
        }
        await readOccurrences(active.map(({ child }) => child.parentOccurrenceId!));
        for (const path of active) {
          const parent = occurrences.get(path.child.parentOccurrenceId!)!;
          path.ancestors.push(parent);
          path.child = parent;
        }
      }

      const participants = [...occurrences.values()];
      const selectedRanks = await readVersionedOutlineSequenceRanks(
        indexes.preorder,
        participants.map(({ occurrenceId }) => ({ rootId: snapshot.preorderRootId, nodeId: occurrenceId })),
      );
      const ranksByOccurrence = new Map<string, VersionedOutlineSequenceRanks>();
      for (let index = 0; index < participants.length; index += 1) {
        const ranks = selectedRanks[index]!;
        if (ranks === null) invalidAnchor();
        ranksByOccurrence.set(participants[index]!.occurrenceId, ranks);
      }

      // Each subtree's exclusive end is either the snapshot end or one selected preorder boundary.
      // Coalesce equal ends (common on ancestor paths) before selecting and ranking those boundaries.
      const ends = new Set<bigint>();
      for (const occurrence of participants) {
        const end = ranksByOccurrence.get(occurrence.occurrenceId)!.rank + occurrence.subtreeSize;
        if (end > snapshot.placementCount) {
          throw new Error('Hosted version occurrence exceeds its selected preorder range');
        }
        if (end !== snapshot.placementCount) ends.add(end);
      }
      const boundaryEnds = [...ends];
      const boundaries = await selectVersionedOutlineSequenceNodes(
        indexes.preorder,
        boundaryEnds.map((rank) => ({ rootId: snapshot.preorderRootId, rank })),
      );
      const boundaryRequests = boundaries.map((boundary) => {
        if (boundary === null) throw new Error('Hosted version preorder boundary is missing');
        return { rootId: snapshot.preorderRootId, nodeId: boundary.id };
      });
      const boundaryChapterRanks = await chapterRankVersionedOutlineSequenceNodes(indexes.preorder, boundaryRequests);
      const chapterRankByEnd = new Map<bigint, bigint>([[snapshot.placementCount, snapshot.chapterCount]]);
      for (let index = 0; index < boundaryEnds.length; index += 1) {
        const rank = boundaryChapterRanks[index]!;
        if (rank === null) throw new Error('Hosted version preorder boundary left its selected root');
        chapterRankByEnd.set(boundaryEnds[index]!, rank);
      }
      for (const occurrence of participants) {
        const start = ranksByOccurrence.get(occurrence.occurrenceId)!;
        const endChapter = chapterRankByEnd.get(start.rank + occurrence.subtreeSize)!;
        if (endChapter - start.chapterRank !== occurrence.value.chapterCount) {
          throw new Error('Hosted version occurrence chapter summary does not match its selected preorder');
        }
      }

      const assertContainedRange = (
        child: HostedVersionDraftMoveSelectedOccurrence,
        parent: HostedVersionDraftMoveSelectedOccurrence,
      ): void => {
        const childStart = ranksByOccurrence.get(child.occurrenceId)!.rank;
        const parentStart = ranksByOccurrence.get(parent.occurrenceId)!.rank;
        if (childStart <= parentStart || childStart + child.subtreeSize > parentStart + parent.subtreeSize) {
          invalidAnchor();
        }
      };
      if (before !== null && destinationParent !== null) assertContainedRange(before, destinationParent);
      for (const [initial, path] of [
        [source, sourcePath],
        [destinationParent, destinationPath],
      ] as const) {
        if (initial === null) continue;
        let child = initial;
        for (const parent of path) {
          assertContainedRange(child, parent);
          child = parent;
        }
      }
      const sourceAncestors = sourcePath.map((parent) => ancestorFact(descriptor.revisionId, parent));
      const destinationAncestors = destinationPath.map((parent) => ancestorFact(descriptor.revisionId, parent));

      if (source.value.chapterCount !== 0n) {
        if (snapshot.chapterRootId === null) {
          throw new Error('Hosted version occurrence has chapters without a chapter projection');
        }
        const start = ranksByOccurrence.get(source.occurrenceId)!.chapterRank;
        const lastRank = start + source.value.chapterCount - 1n;
        const [preorderBoundaries, chapterBoundaries] = await Promise.all([
          selectVersionedOutlineSequenceChapters(
            indexes.preorder,
            [start, lastRank].map((rank) => ({ rootId: snapshot.preorderRootId, rank })),
          ),
          selectVersionedOutlineSequenceNodes(
            indexes.chapters,
            [start, lastRank].map((rank) => ({ rootId: snapshot.chapterRootId, rank })),
          ),
        ]);
        const firstInPreorder = preorderBoundaries[0]!;
        const lastInPreorder = preorderBoundaries[1]!;
        const firstInChapters = chapterBoundaries[0]!;
        const lastInChapters = chapterBoundaries[1]!;
        if (
          firstInPreorder === null ||
          lastInPreorder === null ||
          firstInChapters === null ||
          lastInChapters === null ||
          firstInPreorder.value !== firstInChapters.value ||
          lastInPreorder.value !== lastInChapters.value
        ) {
          throw new Error('Hosted version chapter projection does not match its selected preorder range');
        }
      }

      const siblingParents = new Set<string | null>([
        null,
        source.occurrenceId,
        source.parentOccurrenceId,
        input.parentId,
        ...(before === null ? [] : [before.occurrenceId, before.parentOccurrenceId]),
      ]);
      for (const ancestor of [...sourceAncestors, ...destinationAncestors]) {
        siblingParents.add(ancestor.occurrenceId);
        siblingParents.add(ancestor.parentId);
      }
      const siblingRootByParent = new Map<string | null, string | null>();
      const siblingParentIds = [...siblingParents];
      for (let offset = 0; offset < siblingParentIds.length; offset += HOSTED_VERSION_SIBLING_ROOT_BATCH_SIZE) {
        const parentIds = siblingParentIds.slice(offset, offset + HOSTED_VERSION_SIBLING_ROOT_BATCH_SIZE);
        const roots = await readHostedVersionSiblingRoots(tx, snapshot, parentIds);
        for (const parentId of parentIds) {
          const root = roots.get(parentId) ?? null;
          if (root !== null && (root.parentOccurrenceId !== parentId || root.sequence > snapshot.sequence)) {
            throw new InvalidHostedVersionIdentityError();
          }
          siblingRootByParent.set(parentId, root?.rootNodeId ?? null);
        }
      }
      const sourceSiblingRootId = siblingRootByParent.get(source.parentOccurrenceId) ?? null;
      const destinationSiblingRootId = siblingRootByParent.get(input.parentId) ?? null;

      const selection: HostedVersionDraftMoveSelection = {
        snapshotId: descriptor.revisionId,
        headRevisionId: head.head_revision_id,
        source: occurrenceFact(descriptor.revisionId, source),
        destinationParent:
          destinationParent === null
            ? null
            : { ...occurrenceFact(descriptor.revisionId, destinationParent), kind: 'part' },
        before: before === null ? null : occurrenceFact(descriptor.revisionId, before),
        sourceAncestors,
        destinationAncestors,
        sourceSiblingRootId,
        destinationSiblingRootId,
        preorderRootId: snapshot.preorderRootId,
        chapterRootId: snapshot.chapterRootId,
        siblingRootByParent,
      };
      const selected: HostedVersionDraftMoveNativeSnapshot = { selection, indexes };
      contexts.set(selected, {
        descriptor,
        snapshot,
        write: storeWrite,
        occurrences,
        selection,
      });
      return selected;
    },

    async commitMove(tx, write) {
      const context = contexts.get(write.snapshot);
      if (!context) throw new InvalidHostedVersionIdentityError();
      contexts.delete(write.snapshot);

      const { descriptor, snapshot, write: storeWrite } = context;
      const route = routeOf(write.catalogueId);
      if (route === null) throw new InvalidHostedVersionIdentityError();
      assertDescriptorIdentity(route, write.catalogueId, write.input.expectedRevisionId, descriptor);
      assertRequestIdsUseRoute(route, write.input);
      assertSnapshotIdentity(snapshot, descriptor);
      if (
        write.snapshot.selection !== context.selection ||
        write.plan.expectedRevisionId !== descriptor.revisionId ||
        write.plan.occurrenceId !== write.input.occurrenceId ||
        write.plan.toParentId !== write.input.parentId ||
        write.plan.result !== 'moved'
      ) {
        throw new InvalidHostedVersionIdentityError();
      }

      const source = context.occurrences.get(write.input.occurrenceId);
      if (!source) throw new InvalidHostedVersionIdentityError();
      const depthUpdates = new Map(
        write.plan.subtreeHeightUpdates.map((update) => [update.occurrenceId, update.subtreeHeight]),
      );
      stageHostedVersionOccurrence(storeWrite, source.occurrenceId, {
        parentOccurrenceId: write.plan.toParentId,
        subtreeSize: source.subtreeSize,
        value: {
          ...source.value,
          subtreeHeight: depthUpdates.get(source.occurrenceId) ?? source.value.subtreeHeight,
        },
      });

      for (const delta of write.plan.ancestorDeltas) {
        const ancestor = context.occurrences.get(delta.occurrenceId);
        if (!ancestor) throw new InvalidHostedVersionIdentityError();
        stageHostedVersionOccurrence(storeWrite, ancestor.occurrenceId, {
          parentOccurrenceId: ancestor.parentOccurrenceId,
          subtreeSize: delta.subtreeSize,
          value: {
            ...ancestor.value,
            chapterCount: delta.chapterCount,
            subtreeHeight: depthUpdates.get(ancestor.occurrenceId) ?? ancestor.value.subtreeHeight,
          },
        });
      }
      for (const update of write.plan.subtreeHeightUpdates) {
        if (
          update.occurrenceId === source.occurrenceId ||
          write.plan.ancestorDeltas.some((delta) => delta.occurrenceId === update.occurrenceId)
        ) {
          continue;
        }
        const occurrence = context.occurrences.get(update.occurrenceId);
        if (!occurrence) throw new InvalidHostedVersionIdentityError();
        stageHostedVersionOccurrence(storeWrite, occurrence.occurrenceId, {
          parentOccurrenceId: occurrence.parentOccurrenceId,
          subtreeSize: occurrence.subtreeSize,
          value: { ...occurrence.value, subtreeHeight: update.subtreeHeight },
        });
      }

      stageHostedVersionSiblingRoot(storeWrite, write.plan.fromParentId, write.plan.sourceSiblingRootId);
      if (write.plan.toParentId !== write.plan.fromParentId) {
        stageHostedVersionSiblingRoot(storeWrite, write.plan.toParentId, write.plan.destinationSiblingRootId);
      }
      stageHostedVersionSnapshotRoots(storeWrite, {
        preorderRootId: write.plan.preorderRootId,
        chapterRootId: write.plan.chapterRootId,
        placementCount: snapshot.placementCount,
        chapterCount: snapshot.chapterCount,
      });

      try {
        const committed = await commitHostedVersionWrite(tx, storeWrite);
        await commitHostedVersionRevision(tx, {
          revisionId: write.revisionId,
          snapshot: {
            route: committed.route,
            catalogueId: committed.catalogueId,
            generationId: committed.generationId,
            generationKind: 'draft',
            sequence: committed.sequence,
          },
          recordedTransactionId: write.transactionId,
          recordedAt: write.recordedAt,
          revisionKind: 'structure',
          expectedDraftRevisionId: write.input.expectedRevisionId,
        });
      } catch (error) {
        if (
          error instanceof HostedVersionHeadChangedError ||
          error instanceof HostedVersionRevisionPointerChangedError
        ) {
          return false;
        }
        throw error;
      }
      return true;
    },
  };
}
