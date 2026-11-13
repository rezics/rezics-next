import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import {
  chapterRankVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNode,
  selectVersionedOutlineSequenceChapter,
  selectVersionedOutlineSequenceNode,
} from './versioned-outline-sequence.ts';
import { HOSTED_DEPTH_LIMIT } from './hosted-chapters-model.ts';
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
  HostedVersionHeadChangedError,
  InvalidHostedVersionIdentityError,
  type HostedVersionSnapshot,
  commitHostedVersionWrite,
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
import { HostedVersionRevisionPointerChangedError, commitHostedVersionRevision } from './hosted-version-revision.ts';
import type {
  HostedVersionDraftMoveDescriptor,
  HostedVersionDraftMoveNativeContext,
  HostedVersionDraftMoveSelectedOccurrence,
  HostedVersionDraftMoveStoredValue,
} from './hosted-version-draft-native-model.ts';
import readHead from './hosted-version-draft-native-read-head.sql';

type DraftHeadRow = Readonly<{ head_revision_id: string }>;

const contexts = new WeakMap<object, HostedVersionDraftMoveNativeContext>();

function invalidAnchor(): never {
  throw new HostedVersionDraftMoveError('invalid-anchor');
}

function occurrenceFact(
  revisionId: string,
  occurrence: HostedVersionDraftMoveSelectedOccurrence,
): HostedVersionDraftMoveOccurrence {
  return {
    snapshotId: revisionId,
    occurrenceId: occurrence.occurrenceId,
    parentId: occurrence.parentOccurrenceId,
    kind: occurrence.value.kind,
    subtreeSize: occurrence.subtreeSize,
    subtreeHeight: occurrence.value.subtreeHeight,
    chapterCount: occurrence.value.chapterCount,
  };
}

function ancestorFact(
  revisionId: string,
  occurrence: HostedVersionDraftMoveSelectedOccurrence,
): HostedVersionDraftMoveAncestor {
  return {
    snapshotId: revisionId,
    occurrenceId: occurrence.occurrenceId,
    parentId: occurrence.parentOccurrenceId,
    subtreeSize: occurrence.subtreeSize,
    chapterCount: occurrence.value.chapterCount,
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
    routeOf(input.parentId) !== route ||
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
      const indexes: HostedVersionDraftMoveIndexes = {
        siblings: hostedVersionSequence(storeWrite, 'sibling'),
        preorder: hostedVersionSequence(storeWrite, 'preorder'),
        chapters: hostedVersionSequence(storeWrite, 'chapter'),
      };
      await assertRootSummary(snapshot, indexes.preorder, indexes.chapters);

      const occurrences = new Map<string, HostedVersionDraftMoveSelectedOccurrence>();
      const readOccurrence = async (occurrenceId: string): Promise<HostedVersionDraftMoveSelectedOccurrence> => {
        const existing = occurrences.get(occurrenceId);
        if (existing) return existing;
        const occurrence = await readHostedVersionOccurrence<HostedVersionDraftMoveStoredValue>(
          tx,
          snapshot,
          occurrenceId,
        );
        if (occurrence === null) invalidAnchor();
        occurrences.set(occurrenceId, occurrence);
        return occurrence;
      };

      const preorderRanks = new Map<string, bigint>();
      const requirePreorderMember = async (occurrenceId: string): Promise<bigint> => {
        const existing = preorderRanks.get(occurrenceId);
        if (existing !== undefined) return existing;
        const rank = await rankVersionedOutlineSequenceNode(indexes.preorder, snapshot.preorderRootId, occurrenceId);
        if (rank === null) invalidAnchor();
        preorderRanks.set(occurrenceId, rank);
        return rank;
      };

      const assertChapterAggregate = async (occurrence: HostedVersionDraftMoveSelectedOccurrence): Promise<bigint> => {
        const start = await requirePreorderMember(occurrence.occurrenceId);
        const startChapter = await chapterRankVersionedOutlineSequenceNode(
          indexes.preorder,
          snapshot.preorderRootId,
          occurrence.occurrenceId,
        );
        if (startChapter === null) invalidAnchor();
        const preorderRoot =
          snapshot.preorderRootId === null ? null : await indexes.preorder.readNode(snapshot.preorderRootId);
        const count = preorderRoot?.count ?? 0n;
        const end = start + occurrence.subtreeSize;
        if (end > count) throw new Error('Hosted version occurrence exceeds its selected preorder range');
        const endChapter =
          end === count
            ? (preorderRoot?.chapterCount ?? 0n)
            : await (async () => {
                const boundary = await selectVersionedOutlineSequenceNode(
                  indexes.preorder,
                  snapshot.preorderRootId,
                  end,
                );
                if (boundary === null) throw new Error('Hosted version preorder boundary is missing');
                const rank = await chapterRankVersionedOutlineSequenceNode(
                  indexes.preorder,
                  snapshot.preorderRootId,
                  boundary.id,
                );
                if (rank === null) throw new Error('Hosted version preorder boundary left its selected root');
                return rank;
              })();
        const actual = endChapter - startChapter;
        if (actual !== occurrence.value.chapterCount) {
          throw new Error('Hosted version occurrence chapter summary does not match its selected preorder');
        }
        return start;
      };

      const assertChapterProjectionRange = async (
        occurrence: HostedVersionDraftMoveSelectedOccurrence,
      ): Promise<void> => {
        if (occurrence.value.chapterCount === 0n) return;
        if (snapshot.chapterRootId === null) {
          throw new Error('Hosted version occurrence has chapters without a chapter projection');
        }
        const start = await chapterRankVersionedOutlineSequenceNode(
          indexes.preorder,
          snapshot.preorderRootId,
          occurrence.occurrenceId,
        );
        if (start === null) invalidAnchor();
        const lastRank = start + occurrence.value.chapterCount - 1n;
        const [firstInPreorder, lastInPreorder, firstInChapters, lastInChapters] = await Promise.all([
          selectVersionedOutlineSequenceChapter(indexes.preorder, snapshot.preorderRootId, start),
          selectVersionedOutlineSequenceChapter(indexes.preorder, snapshot.preorderRootId, lastRank),
          selectVersionedOutlineSequenceNode(indexes.chapters, snapshot.chapterRootId, start),
          selectVersionedOutlineSequenceNode(indexes.chapters, snapshot.chapterRootId, lastRank),
        ]);
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
      };

      const source = await readOccurrence(input.occurrenceId);
      const destinationParent = await readOccurrence(input.parentId);
      if (source.parentOccurrenceId === null && input.occurrenceId === input.parentId) invalidAnchor();
      if (destinationParent.value.kind !== 'part') invalidAnchor();
      await requirePreorderMember(source.occurrenceId);
      await requirePreorderMember(destinationParent.occurrenceId);
      await assertChapterAggregate(source);
      await assertChapterProjectionRange(source);
      await assertChapterAggregate(destinationParent);

      const before = input.beforeOccurrenceId === null ? null : await readOccurrence(input.beforeOccurrenceId);
      if (before !== null) {
        if (before.parentOccurrenceId !== input.parentId) invalidAnchor();
        await requirePreorderMember(before.occurrenceId);
        await assertChapterAggregate(before);
      }

      const sourceAncestors: HostedVersionDraftMoveAncestor[] = [];
      const destinationAncestors: HostedVersionDraftMoveAncestor[] = [];
      const assertContainedRange = async (
        child: HostedVersionDraftMoveSelectedOccurrence,
        parent: HostedVersionDraftMoveSelectedOccurrence,
      ): Promise<void> => {
        const [childStart, parentStart] = await Promise.all([
          requirePreorderMember(child.occurrenceId),
          requirePreorderMember(parent.occurrenceId),
        ]);
        if (childStart <= parentStart || childStart + child.subtreeSize > parentStart + parent.subtreeSize) {
          invalidAnchor();
        }
      };

      if (before !== null) await assertContainedRange(before, destinationParent);

      const collectAncestors = async (
        initial: HostedVersionDraftMoveSelectedOccurrence,
        path: HostedVersionDraftMoveAncestor[],
      ): Promise<void> => {
        let child = initial;
        let depth = 0;
        while (child.parentOccurrenceId !== null) {
          if (depth >= HOSTED_DEPTH_LIMIT) invalidAnchor();
          const parent = await readOccurrence(child.parentOccurrenceId);
          await assertContainedRange(child, parent);
          await assertChapterAggregate(parent);
          path.push(ancestorFact(descriptor.revisionId, parent));
          child = parent;
          depth += 1;
        }
      };

      await collectAncestors(source, sourceAncestors);
      await collectAncestors(destinationParent, destinationAncestors);

      const rootForParent = async (parentId: string | null): Promise<string | null> => {
        const root = await readHostedVersionSiblingRoot(tx, snapshot, parentId);
        if (root === null) return null;
        if (root.parentOccurrenceId !== parentId || root.sequence > snapshot.sequence) {
          throw new InvalidHostedVersionIdentityError();
        }
        return root.rootNodeId;
      };
      const sourceSiblingRootId = await rootForParent(source.parentOccurrenceId);
      const destinationSiblingRootId =
        source.parentOccurrenceId === input.parentId ? sourceSiblingRootId : await rootForParent(input.parentId);

      const selection: HostedVersionDraftMoveSelection = {
        snapshotId: descriptor.revisionId,
        headRevisionId: head.head_revision_id,
        source: occurrenceFact(descriptor.revisionId, source),
        destinationParent: {
          ...occurrenceFact(descriptor.revisionId, destinationParent),
          kind: 'part',
        },
        before: before === null ? null : occurrenceFact(descriptor.revisionId, before),
        sourceAncestors,
        destinationAncestors,
        sourceSiblingRootId,
        destinationSiblingRootId,
        preorderRootId: snapshot.preorderRootId,
        chapterRootId: snapshot.chapterRootId,
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
      stageHostedVersionOccurrence(storeWrite, source.occurrenceId, {
        parentOccurrenceId: write.plan.toParentId,
        subtreeSize: source.subtreeSize,
        value: source.value,
      });

      for (const delta of write.plan.ancestorDeltas) {
        const ancestor = context.occurrences.get(delta.occurrenceId);
        if (!ancestor) throw new InvalidHostedVersionIdentityError();
        stageHostedVersionOccurrence(storeWrite, ancestor.occurrenceId, {
          parentOccurrenceId: ancestor.parentOccurrenceId,
          subtreeSize: delta.subtreeSize,
          value: { ...ancestor.value, chapterCount: delta.chapterCount },
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
