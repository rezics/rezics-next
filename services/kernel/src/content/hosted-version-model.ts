/** Private storage model for the additive, generation-based Book outline. */
export const HOSTED_VERSION_INDEX_KINDS = ['sibling', 'preorder', 'chapter'] as const;
export type HostedVersionIndexKind = (typeof HOSTED_VERSION_INDEX_KINDS)[number];

/** Both kinds are private until a separate owner flow activates them. */
export type HostedVersionGenerationKind = 'draft' | 'candidate';

/** One immutable point in a Book-owned generation. Counts stay BigInt in TypeScript. */
export type HostedVersionSnapshot = Readonly<{
  route: number;
  catalogueId: string;
  generationId: string;
  generationKind: HostedVersionGenerationKind;
  sequence: bigint;
  preorderRootId: string | null;
  chapterRootId: string | null;
  placementCount: bigint;
  chapterCount: bigint;
}>;

/** The storage envelope keeps inverse AVL parentage separate from Book containment. */
export type HostedVersionNodeValue<Value> = Readonly<{
  nodeId: string;
  treeParentId: string | null;
  value: Value;
  sequence: bigint;
}>;

/** Occurrence state carries the product containment edge, never an AVL edge. */
export type HostedVersionOccurrenceState<Value> = Readonly<{
  parentOccurrenceId: string | null;
  subtreeSize: bigint;
  value: Value;
}>;

export type HostedVersionOccurrenceValue<Value> = HostedVersionOccurrenceState<Value> &
  Readonly<{ occurrenceId: string; sequence: bigint }>;

export type HostedVersionSiblingRoot = Readonly<{
  parentOccurrenceId: string | null;
  rootNodeId: string | null;
  sequence: bigint;
}>;

export type HostedVersionSnapshotRoots = Readonly<{
  preorderRootId: string | null;
  chapterRootId: string | null;
  placementCount: bigint;
  chapterCount: bigint;
}>;

export class InvalidHostedVersionIdentityError extends Error {
  constructor() {
    super('Hosted version identity does not match its catalogue route');
    this.name = 'InvalidHostedVersionIdentityError';
  }
}

export class HostedVersionHeadChangedError extends Error {
  constructor() {
    super('Hosted version head changed before commit');
    this.name = 'HostedVersionHeadChangedError';
  }
}
