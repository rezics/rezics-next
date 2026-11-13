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

/** One native transaction view of the exact expected draft and all three
 * sequence workspaces. The workspace readers stay pinned to this snapshot while
 * writes made by the planner remain local until the adapter commits them. */
export type HostedVersionDraftMoveNativeSnapshot = Readonly<{
  selection: HostedVersionDraftMoveSelection;
  indexes: HostedVersionDraftMoveIndexes;
}>;

/** Owner writes that must commit with the version-head compare-and-swap. */
export type HostedVersionDraftMoveNativeWrite = Readonly<{
  catalogueId: string;
  input: HostedVersionDraftMoveInput;
  snapshot: HostedVersionDraftMoveNativeSnapshot;
  plan: HostedVersionDraftMovePlan;
  revisionId: string;
  transactionId: string;
  recordedAt: string;
}>;

/** Storage contract for the native version adapter. Selection must resolve the
 * source, destination, optional anchor and both ancestor paths from one current
 * expected draft. Commit persists staged sibling/preorder/chapter nodes, the
 * moved occurrence and changed summaries, the revision/event facts and the
 * expected-head CAS in the caller's transaction. A false result means only that
 * the expected-head CAS lost; all other failures throw and roll back. */
export type HostedVersionDraftMoveNativeAdapter<Transaction> = Readonly<{
  selectExpectedSnapshot(
    tx: Transaction,
    catalogueId: string,
    input: HostedVersionDraftMoveInput,
  ): Promise<HostedVersionDraftMoveNativeSnapshot>;
  commitMove(tx: Transaction, write: HostedVersionDraftMoveNativeWrite): Promise<boolean>;
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
