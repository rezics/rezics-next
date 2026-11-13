import type { VersionedOutlineSequenceReadWriteSet } from './versioned-outline-sequence.ts';

export type HostedVersionReadIndex<Value> = Readonly<{
  /** The exact sibling, preorder or chapter root selected by the owning snapshot. */
  rootId: string | null;
  /** Reader pinned by the owner to that same immutable snapshot and index. */
  access: VersionedOutlineSequenceReadWriteSet<Value>;
}>;

export type HostedVersionReadDirection = 'forward' | 'reverse';

export type HostedVersionReadWork = Readonly<{
  /** Calls made by this page to the selected-index read set, including cache hits. */
  logicalNodeReadCalls: number;
  /** Unique sequence node IDs touched by this page. */
  distinctLogicalNodeVisits: number;
  /** New selected-snapshot probes reported by the read set; this is not a SQL statement count. */
  snapshotProbeCount: number;
}>;

export type HostedVersionReadCandidate<Value> = Readonly<{
  nodeId: string;
  value: Value;
  /** Exact zero-based rank in the selected index. */
  rank: bigint;
}>;

export type HostedVersionReadPage<Candidate> = Readonly<{
  /** Raw candidates, including at most one continuation sentinel. */
  candidates: readonly Candidate[];
  /** Exclusive boundary for the next page; null when the raw window is exhausted. */
  nextAnchorId: string | null;
  hasMore: boolean;
  work: HostedVersionReadWork;
}>;

export type HostedVersionChildrenCandidate<Value> = HostedVersionReadCandidate<Value> & Readonly<{ position: number }>;

export type HostedVersionOutlineCandidate<Value> = HostedVersionReadCandidate<Value> & Readonly<{ ordinal: number }>;

export type HostedVersionChapterPageQuery = Readonly<{
  originNodeId: string;
  direction: 'previous' | 'next';
  /** Continuation boundary from the preceding page; the original origin stays bound. */
  afterNodeId?: string;
  limit: number;
}>;

export class HostedVersionReadAnchorError extends Error {
  constructor() {
    super('Hosted version read anchor is not a member of the selected snapshot');
    this.name = 'HostedVersionReadAnchorError';
  }
}

export class HostedVersionReadIndexCorruptionError extends Error {
  constructor() {
    super('Hosted version read index is corrupt');
    this.name = 'HostedVersionReadIndexCorruptionError';
  }
}
