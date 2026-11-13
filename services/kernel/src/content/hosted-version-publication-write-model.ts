import type { HostedChapterTarget } from './hosted-chapters-model.ts';
import type { HostedPointSelection } from './hosted-publication-point-selection.ts';
import type {
  VersionedOutlineSequenceReadWriteSet,
  VersionedOutlineSequenceWork,
} from './versioned-outline-sequence.ts';

/** The public value stored for one selected occurrence; order is represented by the indexes. */
export type HostedVersionPublicationValue =
  | Readonly<{ kind: 'part'; title: string }>
  | Readonly<{ kind: 'chapter'; title: string; target: HostedChapterTarget }>;

export type HostedVersionPublicationOccurrence = Readonly<{
  parentId: string | null;
  subtreeSize: bigint;
  chapterCount: bigint;
  value: HostedVersionPublicationValue;
}>;

export type HostedVersionPublicationOccurrenceChange = HostedVersionPublicationOccurrence &
  Readonly<{ occurrenceId: string }>;

export type HostedVersionPublicationIndexRoots = Readonly<{
  preorderRootId: string | null;
  chapterRootId: string | null;
  placementCount: bigint;
  chapterCount: bigint;
}>;

/** Exact candidate publication descriptor that backs all reads in this write. */
export type HostedVersionPublicationWriteSnapshot = HostedVersionPublicationIndexRoots &
  Readonly<{
    publicationRevisionId: string;
    generationId: string;
    generationKind: 'candidate';
    sequence: bigint;
  }>;

export type HostedVersionPublicationIndexes = Readonly<{
  siblings: VersionedOutlineSequenceReadWriteSet<string>;
  preorder: VersionedOutlineSequenceReadWriteSet<string>;
  chapters: VersionedOutlineSequenceReadWriteSet<string>;
}>;

/**
 * Operation-local view of the native candidate write overlay. The Book adapter binds these operations to
 * createHostedVersionWrite and its exact snapshot readers; this interface does not own persistence or a transaction.
 */
export type HostedVersionPublicationWritePort = Readonly<{
  snapshot: HostedVersionPublicationWriteSnapshot;
  indexes: HostedVersionPublicationIndexes;
  readOccurrence(occurrenceId: string): Promise<HostedVersionPublicationOccurrence | null>;
  readSiblingRoot(parentId: string | null): Promise<string | null>;
  stageOccurrence(change: HostedVersionPublicationOccurrenceChange): void;
  stageSiblingRoot(parentId: string | null, rootId: string | null): void;
  stageSnapshotRoots(roots: HostedVersionPublicationIndexRoots): void;
}>;

export type HostedVersionPublicationInsertion = Readonly<{
  occurrenceId: string;
  parentId: string | null;
  kind: 'part' | 'chapter';
  siblingRank: bigint;
  preorderRank: bigint;
  chapterRank: bigint | null;
}>;

export type HostedVersionPublicationLogicalWork = Readonly<{
  siblings: VersionedOutlineSequenceWork;
  preorder: VersionedOutlineSequenceWork;
  chapters: VersionedOutlineSequenceWork;
  touchedIndexPathNodes: number;
  changedOccurrences: number;
  changedSiblingRoots: number;
}>;

export type HostedVersionPublicationWritePlan = Readonly<{
  kind: HostedPointSelection['kind'];
  expectedRevisionId: string;
  expectedPublicationId: string;
  expectedGenerationId: string;
  expectedSequence: bigint;
  nextSequence: bigint;
  roots: HostedVersionPublicationIndexRoots;
  insertions: readonly HostedVersionPublicationInsertion[];
  occurrenceChanges: readonly HostedVersionPublicationOccurrenceChange[];
  siblingRootChanges: readonly Readonly<{ parentId: string | null; rootId: string | null }>[];
  logicalWork: HostedVersionPublicationLogicalWork;
}>;

export class HostedVersionPublicationWriteError extends Error {
  constructor(readonly code: 'stale-publication') {
    super('Hosted Book publication changed before its exact index snapshot was opened');
    this.name = 'HostedVersionPublicationWriteError';
  }
}
