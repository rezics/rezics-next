import type { HostedPublicBaselineBuildSealFacts } from './hosted-public-baseline-build-model.ts';
import type { HostedVersionPublicationBaseline } from './hosted-version-publication-write-model.ts';

export const HOSTED_VERSION_PUBLIC_BASELINE_PAGE_MAX = 20;
export const HOSTED_VERSION_PUBLIC_BASELINE_ZERO_ID = '00000000-0000-0000-0000-000000000000';

export type HostedVersionPublicBaselinePhase = 'occurrences' | 'nodes' | 'roots' | 'complete';
export type HostedVersionPublicBaselineStatus = 'materializing' | 'complete';

export type HostedVersionPublicBaselineCursor = Readonly<{
  phase: HostedVersionPublicBaselinePhase;
  occurrenceAfterOrdinal: string;
  nodeAfterKind: '' | 'chapters' | 'preorder' | 'siblings';
  nodeAfterId: string;
  rootNullDone: boolean;
  rootAfterParentId: string;
}>;

export type HostedVersionPublicBaselineState = Readonly<{
  buildId: string;
  catalogueId: string;
  threadId: string;
  sourcePublicationId: string;
  actorBinding: string;
  generationId: string;
  placementCount: bigint;
  rootCount: bigint;
  chapterCount: bigint;
  siblingRootId: string | null;
  preorderRootId: string | null;
  chapterRootId: string | null;
  cursor: HostedVersionPublicBaselineCursor;
  occurrencesWritten: bigint;
  nodesWritten: bigint;
  siblingRootsWritten: bigint;
  coverageComplete: boolean;
  status: HostedVersionPublicBaselineStatus;
}>;

export type HostedVersionPublicBaselinePageWork = Readonly<{
  sqlStatements: number;
  sqlRowsReturned: number;
  sqlRowsAffected: number;
  occurrencesWritten: number;
  nodesWritten: number;
  siblingRootsWritten: number;
}>;

export type HostedVersionPublicBaselinePageResult = Readonly<{
  replayed: boolean;
  state: HostedVersionPublicBaselineState;
  work: HostedVersionPublicBaselinePageWork;
}>;

export type HostedVersionPublicBaselineResult = HostedVersionPublicationBaseline;

export type HostedVersionPublicBaselineSealFacts = HostedPublicBaselineBuildSealFacts;

export type HostedVersionPublicBaselineErrorCode =
  | 'source-mismatch'
  | 'stale-source'
  | 'incomplete-source'
  | 'stale-frontier'
  | 'invalid-tree';

export class HostedVersionPublicBaselineError extends Error {
  constructor(
    readonly code: HostedVersionPublicBaselineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostedVersionPublicBaselineError';
  }
}

export function hostedVersionPublicBaselineStartCursor(placementCount: bigint): HostedVersionPublicBaselineCursor {
  return {
    phase: 'occurrences',
    occurrenceAfterOrdinal: placementCount.toString(),
    nodeAfterKind: '',
    nodeAfterId: HOSTED_VERSION_PUBLIC_BASELINE_ZERO_ID,
    rootNullDone: false,
    rootAfterParentId: HOSTED_VERSION_PUBLIC_BASELINE_ZERO_ID,
  };
}

export function sameHostedVersionPublicBaselineCursor(
  left: HostedVersionPublicBaselineCursor,
  right: HostedVersionPublicBaselineCursor,
): boolean {
  return (
    left.phase === right.phase &&
    left.occurrenceAfterOrdinal === right.occurrenceAfterOrdinal &&
    left.nodeAfterKind === right.nodeAfterKind &&
    left.nodeAfterId === right.nodeAfterId &&
    left.rootNullDone === right.rootNullDone &&
    left.rootAfterParentId === right.rootAfterParentId
  );
}
