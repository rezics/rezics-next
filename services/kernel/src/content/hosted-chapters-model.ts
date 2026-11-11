import type { ContentReadDependencies } from './reads.ts';

export const HOSTED_PLACEMENT_LIMIT = 512;
export const HOSTED_DEPTH_LIMIT = 16;
export const HOSTED_PAGE_LIMIT = 20;
export type HostedDependencies = ContentReadDependencies;
export type HostedCommandContext = Readonly<{ idempotencyKey: string; deadline: number }>;
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
export type HostedPlacement = PlacementBase & (
  | Readonly<{ kind: 'part'; target?: never }>
  | Readonly<{ kind: 'chapter'; target: HostedChapterTarget }>
);
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
  kind: 'part' | 'chapter';
}> & (
  | Readonly<{ availability: 'unavailable' }>
  | Readonly<{ availability: 'available'; title: string; target: HostedChapterTarget | null }>
);
export class InvalidHostedStructureError extends Error {
  constructor(message = 'Invalid hosted structure') {
    super(message);
    this.name = 'InvalidHostedStructureError';
  }
}
