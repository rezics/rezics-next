import type { HostedChapterTarget } from './hosted-chapters-model.ts';

export const HOSTED_PUBLIC_BASELINE_INPUT_PAGE_MAX = 100;

/** The exact retained publication whose manifest is being converted. The
 * builder persists this value with its own candidate progress and CAS. */
export type HostedPublicBaselineSource = Readonly<{
  catalogueId: string;
  route: number;
  threadId: string;
  publicationId: string;
  actorBinding: string;
  expectedPlacementCount: number;
}>;

export type HostedPublicBaselineFrontier = Readonly<{ afterOrdinal: number }>;

export type HostedPublicBaselineCapture = Readonly<{
  catalogueId: string;
  expectedPublicationId: string;
}>;

export type HostedPublicBaselinePage = Readonly<{
  frontier: HostedPublicBaselineFrontier;
  limit?: number;
}>;

type HostedPublicBaselineEntryBase = Readonly<{
  publicationId: string;
  occurrenceId: string;
  parentId: string | null;
  position: number;
  ordinal: number;
}>;

export type HostedPublicBaselineEntry = HostedPublicBaselineEntryBase &
  (
    | Readonly<{ availability: 'unavailable'; kind: 'part' }>
    | Readonly<{ availability: 'available'; kind: 'part'; title: string }>
    | Readonly<{ availability: 'unavailable'; kind: 'chapter' }>
    | Readonly<{ availability: 'available'; kind: 'chapter'; title: string; target: HostedChapterTarget }>
  );

export type HostedPublicBaselineCaptureResult = Readonly<{
  source: HostedPublicBaselineSource;
  frontier: HostedPublicBaselineFrontier;
}>;

export type HostedPublicBaselinePageResult = Readonly<{
  source: HostedPublicBaselineSource;
  sourceCurrent: boolean;
  frontier: HostedPublicBaselineFrontier;
  coverage: Readonly<{ visited: number; expected: number; complete: boolean }>;
  items: readonly HostedPublicBaselineEntry[];
}>;

export class InvalidHostedPublicBaselineInputError extends Error {
  constructor(message = 'Invalid hosted public baseline input') {
    super(message);
    this.name = 'InvalidHostedPublicBaselineInputError';
  }
}

export class HostedPublicBaselineInputUnavailableError extends Error {
  constructor() {
    super('Hosted public baseline source is unavailable');
    this.name = 'HostedPublicBaselineInputUnavailableError';
  }
}

export class HostedPublicBaselineInputIncompleteError extends Error {
  constructor() {
    super('Hosted public baseline source is incomplete');
    this.name = 'HostedPublicBaselineInputIncompleteError';
  }
}
