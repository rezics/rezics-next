import type {
  VersionedOutlineSequenceReadWriteSet,
  VersionedOutlineSequenceWork,
} from './versioned-outline-sequence.ts';

/** A request to move one existing occurrence and its unchanged subtree. */
export type HostedVersionDraftMoveInput = Readonly<{
  expectedRevisionId: string;
  occurrenceId: string;
  parentId: string;
  beforeOccurrenceId: string | null;
}>;

export type HostedVersionDraftMoveOccurrence = Readonly<{
  snapshotId: string;
  occurrenceId: string;
  parentId: string | null;
  kind: 'part' | 'chapter';
  subtreeSize: bigint;
  subtreeHeight: number;
  chapterCount: bigint;
}>;

export type HostedVersionDraftMoveAncestor = Readonly<{
  snapshotId: string;
  occurrenceId: string;
  parentId: string | null;
  subtreeSize: bigint;
  chapterCount: bigint;
}>;

export type HostedVersionDraftMoveSelection = Readonly<{
  /** All point and ancestor facts below come from this one immutable draft snapshot. */
  snapshotId: string;
  headRevisionId: string;
  source: HostedVersionDraftMoveOccurrence;
  destinationParent: HostedVersionDraftMoveOccurrence & Readonly<{ kind: 'part' }>;
  before: HostedVersionDraftMoveOccurrence | null;
  /** Immediate parent first, ending at the root occurrence. */
  sourceAncestors: readonly HostedVersionDraftMoveAncestor[];
  destinationAncestors: readonly HostedVersionDraftMoveAncestor[];
  sourceSiblingRootId: string | null;
  destinationSiblingRootId: string | null;
  preorderRootId: string | null;
  chapterRootId: string | null;
}>;

export type HostedVersionDraftMoveIndexes = Readonly<{
  siblings: VersionedOutlineSequenceReadWriteSet<string>;
  preorder: VersionedOutlineSequenceReadWriteSet<string>;
  chapters: VersionedOutlineSequenceReadWriteSet<string>;
}>;

export type HostedVersionDraftMoveAncestorDelta = Readonly<{
  occurrenceId: string;
  subtreeSizeDelta: bigint;
  chapterCountDelta: bigint;
  subtreeSize: bigint;
  chapterCount: bigint;
}>;

export type HostedVersionDraftMovePlan = Readonly<{
  result: 'moved' | 'no-op';
  expectedRevisionId: string;
  occurrenceId: string;
  fromParentId: string | null;
  toParentId: string;
  sourceSiblingRootId: string | null;
  destinationSiblingRootId: string | null;
  preorderRootId: string | null;
  chapterRootId: string | null;
  preorderStart: bigint;
  preorderCount: bigint;
  preorderDestination: bigint;
  chapterStart: bigint;
  chapterCount: bigint;
  chapterDestination: bigint;
  ancestorDeltas: readonly HostedVersionDraftMoveAncestorDelta[];
  work: Readonly<{
    siblings: VersionedOutlineSequenceWork;
    preorder: VersionedOutlineSequenceWork;
    chapters: VersionedOutlineSequenceWork;
  }>;
}>;

export class HostedVersionDraftMoveError extends Error {
  constructor(readonly code: 'stale-head' | 'invalid-anchor') {
    super(code === 'stale-head' ? 'Hosted draft head no longer matches' : 'Invalid hosted draft move anchor');
    this.name = 'HostedVersionDraftMoveError';
  }
}
