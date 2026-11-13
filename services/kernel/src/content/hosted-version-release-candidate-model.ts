import type { HostedPublicationStagingSeal } from './hosted-publication-staging-model.ts';
import type { HostedChapterTarget } from './hosted-chapters-model.ts';
import type { HostedVersionSnapshot } from './hosted-version-model.ts';

export const HOSTED_VERSION_RELEASE_CANDIDATE_PAGE_MAX = 20;

export type HostedVersionReleaseCandidateCheckpoint = Readonly<{
  candidateId: string;
  generationId: string;
  sourceSeal: HostedPublicationStagingSeal;
  afterSourceOrder: string | null;
  placementCount: string;
  rootCount: string;
  chapterCount: string;
  coverageComplete: boolean;
  sealed: boolean;
}>;

/** Null titles are retained as neutral unavailable metadata; target revisions stay exact and body-free. */
export type HostedVersionReleaseCandidateValue = Readonly<{
  kind: 'part' | 'chapter';
  title: string | null;
  subtreeHeight: number;
  chapterCount: bigint;
  target: HostedChapterTarget | null;
}>;

export type HostedVersionReleaseCandidateProgress = Readonly<{
  replayed: boolean;
  processed: number;
  checkpoint: HostedVersionReleaseCandidateCheckpoint;
  snapshot: HostedVersionSnapshot;
}>;

export type HostedVersionReleaseCandidateCoverage = Readonly<{
  sourceCandidateCount: string;
  placementCount: string;
  rootCount: string;
  chapterCount: string;
  complete: true;
}>;

export type HostedVersionReleaseCandidateSeal = Readonly<{
  candidateId: string;
  sourceSeal: HostedPublicationStagingSeal;
  snapshot: HostedVersionSnapshot;
  coverage: HostedVersionReleaseCandidateCoverage;
}>;

export class HostedVersionReleaseCandidateError extends Error {
  constructor(
    readonly code:
      | 'source-mismatch'
      | 'stale-source'
      | 'stale-frontier'
      | 'incomplete-source'
      | 'invalid-tree'
      | 'sealed',
    message: string,
  ) {
    super(message);
    this.name = 'HostedVersionReleaseCandidateError';
  }
}

export class HostedVersionReleaseCandidateNotFoundError extends Error {
  constructor() {
    super('Hosted version release candidate is unavailable');
    this.name = 'HostedVersionReleaseCandidateNotFoundError';
  }
}
