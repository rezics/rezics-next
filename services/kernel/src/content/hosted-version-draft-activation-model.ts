import type { HostedChapterTarget } from './hosted-chapters-model.ts';
import type { HostedMigrationSourceIdentity } from './hosted-migration-input-model.ts';
import type { HostedVersionSnapshot } from './hosted-version-model.ts';

export const HOSTED_VERSION_DRAFT_ACTIVATION_PAGE_MAX = 20;

export type HostedVersionDraftActivationPhase = 'occurrences' | 'nodes' | 'roots' | 'complete';

export type HostedVersionDraftActivationStatus = 'materializing' | 'complete' | 'activated';

/** Product value copied onto the ordered draft; unavailable titles and targets stay null. */
export type HostedVersionDraftActivationValue = Readonly<{
  kind: 'part' | 'chapter';
  title: string | null;
  subtreeHeight: number;
  chapterCount: bigint;
  target: HostedChapterTarget | null;
}>;

export type HostedVersionDraftActivationCursor = Readonly<{
  phase: HostedVersionDraftActivationPhase;
  occurrenceAfterOrdinal: string;
  nodeAfterKind: string;
  nodeAfterId: string;
  rootNullDone: boolean;
  rootAfterParentId: string;
}>;

export type HostedVersionDraftActivationState = Readonly<{
  inputId: string;
  catalogueId: string;
  generationId: string;
  revisionId: string;
  source: HostedMigrationSourceIdentity;
  expectedRevisionId: string;
  placementCount: bigint;
  chapterCount: bigint;
  rootCount: bigint;
  siblingRootId: string | null;
  preorderRootId: string | null;
  chapterRootId: string | null;
  cursor: HostedVersionDraftActivationCursor;
  coverageComplete: boolean;
  status: HostedVersionDraftActivationStatus;
}>;

export type HostedVersionDraftActivationPageWork = Readonly<{
  sqlStatements: number;
  sqlRowsReturned: number;
  sqlRowsAffected: number;
  occurrencesWritten: number;
  nodesWritten: number;
  siblingRootsWritten: number;
}>;

export type HostedVersionDraftActivationPageResult = Readonly<{
  replayed: boolean;
  state: HostedVersionDraftActivationState;
  snapshot: HostedVersionSnapshot | null;
  work: HostedVersionDraftActivationPageWork;
}>;

export type HostedVersionDraftActivationCommitResult = Readonly<{
  replayed: boolean;
  revisionId: string;
  snapshot: HostedVersionSnapshot;
  state: HostedVersionDraftActivationState;
}>;

export type HostedVersionDraftActivationErrorCode =
  | 'source-mismatch'
  | 'stale-source'
  | 'incomplete-source'
  | 'unavailable-source'
  | 'empty-source'
  | 'stale-frontier'
  | 'invalid-tree'
  | 'activated';

export class HostedVersionDraftActivationError extends Error {
  constructor(
    readonly code: HostedVersionDraftActivationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostedVersionDraftActivationError';
  }
}

export const HOSTED_VERSION_DRAFT_ACTIVATION_ZERO_ID = '00000000-0000-0000-0000-000000000000';

export function hostedVersionDraftActivationStartCursor(
  expectedPlacementCount: string,
): HostedVersionDraftActivationCursor {
  return {
    phase: 'occurrences',
    occurrenceAfterOrdinal: expectedPlacementCount,
    nodeAfterKind: '',
    nodeAfterId: HOSTED_VERSION_DRAFT_ACTIVATION_ZERO_ID,
    rootNullDone: false,
    rootAfterParentId: HOSTED_VERSION_DRAFT_ACTIVATION_ZERO_ID,
  };
}

export function sameHostedVersionDraftActivationCursor(
  left: HostedVersionDraftActivationCursor,
  right: HostedVersionDraftActivationCursor,
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

export function hostedVersionDraftActivationIndexKind(
  sequenceKind: 'siblings' | 'preorder' | 'chapters',
): 'sibling' | 'preorder' | 'chapter' {
  if (sequenceKind === 'siblings') return 'sibling';
  if (sequenceKind === 'chapters') return 'chapter';
  return 'preorder';
}

export function hostedVersionDraftActivationValue(input: {
  kind: 'part' | 'chapter';
  title: string | null;
  subtreeHeight: number;
  chapterCount: bigint;
  target: HostedChapterTarget | null;
}): HostedVersionDraftActivationValue {
  if (input.kind === 'part') {
    return {
      kind: 'part',
      title: input.title,
      subtreeHeight: input.subtreeHeight,
      chapterCount: input.chapterCount,
      target: null,
    };
  }
  return {
    kind: 'chapter',
    title: input.title,
    subtreeHeight: 0,
    chapterCount: input.chapterCount,
    target: input.target,
  };
}
