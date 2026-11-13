import type {
  HostedMigrationFrontier,
  HostedMigrationInputCaptureResult,
  HostedMigrationInputPageResult,
  HostedMigrationSourceIdentity,
  HostedMigrationSourceAddress,
} from './hosted-migration-input-model.ts';
import type { HostedChapterTarget } from './hosted-chapters-model.ts';
import type {
  VersionedOutlineSequenceReadWriteSet,
  VersionedOutlineSequenceWork,
} from './versioned-outline-sequence.ts';

export const HOSTED_VERSION_BUILDER_PAGE_MAX = 20;

/** The migration input identity and cursor from which this isolated build starts. */
export type HostedVersionBuilderSource = Readonly<{
  inputId: string;
  identity: HostedMigrationSourceIdentity;
  frontier: HostedMigrationFrontier;
}>;

/** Adapt the retained migration-input capture without changing its snapshot identity. */
export function hostedVersionBuilderSource(capture: HostedMigrationInputCaptureResult): HostedVersionBuilderSource {
  return { inputId: capture.inputId, identity: capture.source, frontier: capture.frontier };
}

/** A page and the exact cursor requested from the retained migration input. */
export type HostedVersionBuilderPage = Readonly<{
  inputId: string;
  fromFrontier: HostedMigrationFrontier;
  result: HostedMigrationInputPageResult;
}>;

export type HostedVersionBuilderAncestor = Readonly<{
  occurrenceId: string;
  childSiblingRootId: string | null;
  nextChildPosition: number;
}>;

/** Sequence roots and the active source path shared by bounded baseline producers. */
export type HostedVersionBuilderSequenceState = Readonly<{
  rootSiblingRootId: string | null;
  preorderRootId: string | null;
  chapterRootId: string | null;
  rootNextPosition: number;
  activeAncestors: readonly HostedVersionBuilderAncestor[];
}>;

/** Small resumable state. Candidate values and sequence nodes live in indexed rows. */
export type HostedVersionBuilderState = HostedVersionBuilderSequenceState &
  Readonly<{
    inputId: string;
    identity: HostedMigrationSourceIdentity;
    frontier: HostedMigrationFrontier;
    coverageComplete: boolean;
    sealed: boolean;
  }>;

type HostedVersionBuilderSequenceEntryBase<Address> = Readonly<{
  address: Address;
  occurrenceId: string;
  parentId: string | null;
  position: number;
  ordinal: number;
}>;

/** Source-specific addresses are carried through the shared outline application untouched. */
export type HostedVersionBuilderSequenceItem<Address> = HostedVersionBuilderSequenceEntryBase<Address> &
  (
    | Readonly<{ availability: 'unavailable'; kind: 'part' }>
    | Readonly<{ availability: 'available'; kind: 'part'; title: string }>
    | Readonly<{ availability: 'unavailable'; kind: 'chapter' }>
    | Readonly<{ availability: 'available'; kind: 'chapter'; title: string; target: HostedChapterTarget }>
  );

export type HostedVersionBuilderSequencePointFact<Address> = Readonly<{
  sourceOrdinal: number;
  address: Address;
  occurrenceId: string;
  parentId: string | null;
  position: number;
  kind: 'part' | 'chapter';
  title: string | null;
  target: HostedChapterTarget | null;
}>;

export type HostedVersionBuilderSiblingRootChange = Readonly<{
  parentId: string | null;
  rootId: string;
  nextPosition: number;
}>;

export type HostedVersionBuilderIndexes = Readonly<{
  siblings: VersionedOutlineSequenceReadWriteSet<string>;
  preorder: VersionedOutlineSequenceReadWriteSet<string>;
  chapters: VersionedOutlineSequenceReadWriteSet<string>;
}>;

export type HostedVersionBuilderLogicalWork = Readonly<{
  siblings: VersionedOutlineSequenceWork;
  preorder: VersionedOutlineSequenceWork;
  chapters: VersionedOutlineSequenceWork;
  pointFactsWritten: number;
  siblingRootsChanged: number;
}>;

export type HostedVersionBuilderSequenceApplication<Address> = Readonly<{
  state: HostedVersionBuilderSequenceState;
  pointFacts: readonly HostedVersionBuilderSequencePointFact<Address>[];
  siblingRootChanges: readonly HostedVersionBuilderSiblingRootChange[];
  logicalWork: HostedVersionBuilderLogicalWork;
}>;

export type HostedVersionBuilderPointFact = HostedVersionBuilderSequencePointFact<HostedMigrationSourceAddress>;

export type HostedVersionBuilderApplication = Omit<
  HostedVersionBuilderSequenceApplication<HostedMigrationSourceAddress>,
  'state'
> &
  Readonly<{ state: HostedVersionBuilderState }>;

export type HostedVersionBuilderErrorCode =
  | 'source-mismatch'
  | 'stale-source'
  | 'incomplete-source'
  | 'stale-frontier'
  | 'invalid-page'
  | 'invalid-tree'
  | 'sealed';

export class HostedVersionBuilderError extends Error {
  constructor(
    readonly code: HostedVersionBuilderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostedVersionBuilderError';
  }
}

/** The source's monotonically increasing number of entries consumed at a cursor. */
export function hostedVersionBuilderFrontierCount(
  identity: HostedMigrationSourceIdentity,
  value: HostedMigrationFrontier,
): bigint {
  const baseCount = BigInt(identity.basePlacementCount);
  const expectedCount = BigInt(identity.expectedPlacementCount);
  const highWater = BigInt(identity.highWater);
  if (
    baseCount < 0n ||
    BigInt(identity.baseRootCount) < 0n ||
    BigInt(identity.baseRootCount) > baseCount ||
    highWater < -1n ||
    (identity.kind === 'snapshot' && (identity.revisionId !== identity.baseRevisionId || highWater !== -1n)) ||
    expectedCount !== baseCount + (identity.kind === 'prefix' && highWater >= 0n ? highWater + 1n : 0n)
  ) {
    throw new HostedVersionBuilderError('source-mismatch', 'Hosted version source counts do not match its identity');
  }
  if (value.segment === 'complete') return expectedCount;
  if (value.segment === 'base') {
    const after = BigInt(value.afterOrdinal);
    if (after < -1n || after >= baseCount) {
      throw new HostedVersionBuilderError('invalid-page', 'Hosted version source base frontier is outside its range');
    }
    return after + 1n;
  }
  if (identity.kind !== 'prefix') {
    throw new HostedVersionBuilderError('invalid-page', 'A snapshot source cannot have a prefix frontier');
  }
  const after = BigInt(value.afterOffset);
  if (after < -1n || after > highWater) {
    throw new HostedVersionBuilderError('invalid-page', 'Hosted version source prefix frontier is outside its range');
  }
  return baseCount + after + 1n;
}

export function sameHostedVersionBuilderFrontier(
  left: HostedMigrationFrontier,
  right: HostedMigrationFrontier,
): boolean {
  if (left.segment !== right.segment) return false;
  if (left.segment === 'complete' || right.segment === 'complete') return true;
  if (left.segment === 'base' && right.segment === 'base') return left.afterOrdinal === right.afterOrdinal;
  return left.segment === 'prefix' && right.segment === 'prefix' && left.afterOffset === right.afterOffset;
}

export function sameHostedVersionBuilderSource(
  left: HostedMigrationSourceIdentity,
  right: HostedMigrationSourceIdentity,
): boolean {
  return (
    left.catalogueId === right.catalogueId &&
    left.revisionId === right.revisionId &&
    left.kind === right.kind &&
    left.baseRevisionId === right.baseRevisionId &&
    left.basePlacementCount === right.basePlacementCount &&
    left.baseRootCount === right.baseRootCount &&
    left.highWater === right.highWater &&
    left.expectedPlacementCount === right.expectedPlacementCount
  );
}
