import type {
  HostedPublicBaselineSource,
  HostedPublicBaselineFrontier,
  HostedPublicBaselinePageResult,
} from './hosted-public-baseline-input-model.ts';
import type {
  HostedVersionBuilderSequenceApplication,
  HostedVersionBuilderSequenceState,
} from './hosted-version-builder-model.ts';

export const HOSTED_PUBLIC_BASELINE_BUILD_PAGE_MAX = 20;

export type HostedPublicBaselineBuildFrontier = HostedPublicBaselineFrontier;

export type HostedPublicBaselineBuildState = HostedVersionBuilderSequenceState &
  Readonly<{
    buildId: string;
    candidateId: string;
    source: HostedPublicBaselineSource;
    frontier: HostedPublicBaselineBuildFrontier;
    coverageComplete: boolean;
    sealed: boolean;
  }>;

export type HostedPublicBaselineBuildPage = Readonly<{
  buildId: string;
  fromFrontier: HostedPublicBaselineBuildFrontier;
  result: HostedPublicBaselinePageResult;
}>;

export type HostedPublicBaselineBuildItemAddress = Readonly<{
  publicationId: string;
  ordinal: number;
}>;

export type HostedPublicBaselineBuildApplication =
  HostedVersionBuilderSequenceApplication<HostedPublicBaselineBuildItemAddress>;

export type HostedPublicBaselineBuildPersistenceWork = Readonly<{
  sqlStatements: number;
  sqlRowsReturned: number;
  sqlRowsAffected: number;
}>;

export type HostedPublicBaselineBuildPageResult = Readonly<{
  replayed: boolean;
  state: HostedPublicBaselineBuildState;
  application: HostedPublicBaselineBuildApplication | null;
  persistenceWork: HostedPublicBaselineBuildPersistenceWork;
}>;

/** Facts needed by the point writer to bind this private candidate to its original publication. */
export type HostedPublicBaselineBuildSealFacts = Readonly<{
  buildId: string;
  candidateId: string;
  source: HostedPublicBaselineSource;
  expectedPublicationId: string;
  placementCount: bigint;
  rootCount: bigint;
  chapterCount: bigint;
  siblingRootId: string | null;
  preorderRootId: string | null;
  chapterRootId: string | null;
}>;
