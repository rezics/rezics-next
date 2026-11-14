import type { HostedChapterTarget } from './hosted-chapters-model.ts';
import type {
  VersionedOutlineSequenceReadWriteSet,
  VersionedOutlineSequenceWork,
} from './versioned-outline-sequence.ts';

/** Insert one new stable occurrence at a parent/before anchor, or remove one occurrence and its subtree. */
export type HostedVersionDraftPointInput =
  | Readonly<{
      operation: 'insert';
      expectedRevisionId: string;
      occurrenceId: string;
      parentId: string | null;
      beforeOccurrenceId: string | null;
      title: string;
      placement: Readonly<{ kind: 'part' }> | Readonly<{ kind: 'chapter'; target: HostedChapterTarget }>;
    }>
  | Readonly<{
      operation: 'remove';
      expectedRevisionId: string;
      occurrenceId: string;
    }>;

export type HostedVersionDraftPointAncestor = Readonly<{
  snapshotId: string;
  occurrenceId: string;
  parentId: string | null;
  subtreeSize: bigint;
  chapterCount: bigint;
  subtreeHeight: number;
}>;

/** Selected placement facts include aggregate ranges; they do not contain descendant rows. */
export type HostedVersionDraftPointOccurrence = HostedVersionDraftPointAncestor &
  Readonly<{
    kind: 'part' | 'chapter';
  }>;

type HostedVersionDraftPointSelectionBase = Readonly<{
  /** All selected points, paths, and roots belong to this immutable version. */
  snapshotId: string;
  headRevisionId: string;
  siblingRootId: string | null;
  preorderRootId: string | null;
  chapterRootId: string | null;
  /** Exact sibling roots for selected parents and ancestors in this snapshot. */
  siblingRootByParent: ReadonlyMap<string | null, string | null>;
}>;

export type HostedVersionDraftPointInsertSelection = HostedVersionDraftPointSelectionBase &
  Readonly<{
    operation: 'insert';
    /** Immediate parent first, ending at the root; empty for a root insertion. */
    parentPath: readonly HostedVersionDraftPointOccurrence[];
    before: HostedVersionDraftPointOccurrence | null;
    /** Identity bindings survive removal, so an old occurrence handle can never be inserted again. */
    occurrenceIdentityExists: boolean;
  }>;

export type HostedVersionDraftPointRemoveSelection = HostedVersionDraftPointSelectionBase &
  Readonly<{
    operation: 'remove';
    source: HostedVersionDraftPointOccurrence;
    /** Immediate parent first, ending at the root; empty for a root occurrence. */
    sourceAncestors: readonly HostedVersionDraftPointAncestor[];
  }>;

export type HostedVersionDraftPointSelection =
  | HostedVersionDraftPointInsertSelection
  | HostedVersionDraftPointRemoveSelection;

export type HostedVersionDraftPointIndexes = Readonly<{
  siblings: VersionedOutlineSequenceReadWriteSet<string>;
  preorder: VersionedOutlineSequenceReadWriteSet<string>;
  chapters: VersionedOutlineSequenceReadWriteSet<string>;
  readLegacyMaximum: (
    parentId: string | null,
    excludedOccurrenceIds: readonly string[],
  ) => Promise<Readonly<{ occurrenceId: string; subtreeHeight: number }> | null>;
}>;

export type HostedVersionDraftPointAncestorDelta = Readonly<{
  occurrenceId: string;
  subtreeSizeDelta: bigint;
  chapterCountDelta: bigint;
  subtreeSize: bigint;
  chapterCount: bigint;
}>;

export type HostedVersionDraftPointPlan = Readonly<{
  result: 'inserted' | 'removed';
  operation: 'insert' | 'remove';
  expectedRevisionId: string;
  occurrenceId: string;
  parentId: string | null;
  entryKind: 'part' | 'chapter' | null;
  /** Original sibling rank and the affected sibling root for the one parent. */
  siblingStart: bigint;
  siblingRootId: string | null;
  /** Original preorder range. Insertions have length one; removals use the stored subtree size. */
  preorderStart: bigint;
  preorderCount: bigint;
  preorderRootId: string | null;
  /** Original chapter range, weighted through the preorder index. */
  chapterStart: bigint;
  chapterCount: bigint;
  chapterRootId: string | null;
  ancestorDeltas: readonly HostedVersionDraftPointAncestorDelta[];
  subtreeHeightUpdates: readonly Readonly<{ occurrenceId: string; subtreeHeight: number }>[];
  work: Readonly<{
    siblings: VersionedOutlineSequenceWork;
    preorder: VersionedOutlineSequenceWork;
    chapters: VersionedOutlineSequenceWork;
  }>;
}>;

export class HostedVersionDraftPointError extends Error {
  constructor(readonly code: 'stale-head' | 'invalid-anchor') {
    super(code === 'stale-head' ? 'Hosted draft head no longer matches' : 'Invalid hosted draft point anchor');
    this.name = 'HostedVersionDraftPointError';
  }
}
