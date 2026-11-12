import type { ContentReadDependencies } from './reads.ts';

export { HOSTED_PLACEMENT_LIMIT, HOSTED_DEPTH_LIMIT, HOSTED_PAGE_LIMIT } from './hosted-chapters-limits.ts';
export type HostedDependencies = ContentReadDependencies;
export type HostedCommandContext = Readonly<{ idempotencyKey: string; deadline: number; requestId: string }>;
export type HostedChapterTarget = Readonly<{
  threadId: string;
  postId: string;
  revisionId: string;
  sha256: string;
}>;
type PlacementBase = Readonly<{
  occurrenceId: string;
  parentId: string | null;
  position: number;
  title: string;
}>;
export type HostedPlacement = PlacementBase &
  (Readonly<{ kind: 'part'; target?: never }> | Readonly<{ kind: 'chapter'; target: HostedChapterTarget }>);
export type OrderedHostedPlacement = HostedPlacement & Readonly<{ ordinal: number }>;
export type HostedStructureInput = Readonly<{ placements: readonly HostedPlacement[] }>;
export type HostedCreateInput = HostedStructureInput & Readonly<{ postId: string; threadId: string }>;
export type HostedReviseInput = HostedStructureInput & Readonly<{ expectedRevisionId: string }>;
export type HostedPublishInput = Readonly<{
  expectedRevisionId: string;
  expectedPublicationId: string | null;
  occurrenceIds: readonly string[];
}>;
export type HostedCommandValue = Readonly<{
  catalogueId: string;
  revisionId: string;
}>;
export type HostedRevisionView = Readonly<{
  catalogueId: string;
  revisionId: string;
  kind: 'structure' | 'publication';
  sourceRevisionId: string | null;
}>;
export type HostedOccurrenceView = Readonly<{
  occurrenceId: string;
  parentId: string | null;
  position: number;
}> &
  (
    | Readonly<{ availability: 'unavailable'; kind: 'part' | 'chapter' }>
    | Readonly<{ availability: 'available'; kind: 'part'; title: string; target: null }>
    | Readonly<{ availability: 'available'; kind: 'chapter'; title: string; target: HostedChapterTarget }>
  );
export type HostedReadSelection = Readonly<{ revisionId?: string; kind?: 'structure' | 'publication' }>;
/** Same-home retains its original identity; all-homes states whether the native
 * locator census and this author's outstanding source projections are complete. */
export type HostedOwnerInventoryScope = Readonly<{
  kind: 'same-home' | 'all-homes';
  route: number;
  crossHome: 'unavailable' | 'partial' | 'complete';
}>;
export type HostedOwnerInventoryInput = Readonly<{
  scope?: 'same-home' | 'all-homes';
  limit?: number;
  cursor?: string;
}>;
export type HostedOwnerInventoryEntry = Readonly<{
  catalogueId: string;
  threadId: string;
  createdAt: string;
  postRevisionId: string;
  postVisibility: 'draft' | 'published' | 'protected';
  headRevisionId: string;
  publicationId: string | null;
}>;
export type HostedOwnerInventoryView = Readonly<{
  scope: HostedOwnerInventoryScope;
  viewer: Readonly<{ accountId: string; authnEpoch: number }>;
  items: readonly HostedOwnerInventoryEntry[];
  nextCursor: string | null;
}>;
export class HostedOwnerInventoryUnavailableError extends Error {
  constructor() {
    super('Cross-home hosted catalogue inventory is unavailable');
    this.name = 'HostedOwnerInventoryUnavailableError';
  }
}
export type HostedChildrenInput = HostedReadSelection &
  Readonly<{
    parentId?: string;
    limit?: number;
    cursor?: string;
  }>;
export type HostedNavigationInput = HostedReadSelection &
  Readonly<{
    occurrenceId: string;
    direction: 'previous' | 'next';
    limit?: number;
    cursor?: string;
  }>;
export type HostedPageView = HostedRevisionView &
  Readonly<{
    items: readonly HostedOccurrenceView[];
    nextCursor: string | null;
  }>;
export type HostedResolutionView = HostedRevisionView &
  Readonly<{
    occurrence: HostedOccurrenceView;
    document: Readonly<{
      encoding: 'base64';
      canonicalBytes: string;
      sha256: string;
      authorId: string;
      licence: string;
    }> | null;
  }>;
export class InvalidHostedCursorError extends Error {
  constructor() {
    super('Invalid hosted catalogue cursor');
    this.name = 'InvalidHostedCursorError';
  }
}
export class InvalidHostedStructureError extends Error {
  constructor(message = 'Invalid hosted structure') {
    super(message);
    this.name = 'InvalidHostedStructureError';
  }
}
