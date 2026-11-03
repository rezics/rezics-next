import type { FilterRelease } from '@rezics/filter';
import {
  createReleaseSearchCandidateStreams,
  observeReleaseSearchCandidates,
  type ReleaseSearchCandidateContext,
  type ReleaseSearchCandidateCut,
  type ReleaseSearchCandidatePool,
} from './release-search-native-stream.ts';
import type { ReleaseGroupingBasis, ReleaseGroupingRequest, ReleaseGroupingSource } from './release-search-grouping.ts';

export type ReleaseSearchNativeContext = ReleaseSearchCandidateContext;

/** Composes retained all-pool ownership streams with the service's current card hydrators. */
export function createReleaseSearchGroupingSource<Work, Release>(input: {
  pools: readonly ReleaseSearchCandidatePool[];
  release: FilterRelease;
  cut: ReleaseSearchCandidateCut;
  context: ReleaseSearchNativeContext;
  works(request: ReleaseGroupingRequest, ids: readonly string[]): Promise<ReadonlyMap<string, Work>>;
  releases(
    request: ReleaseGroupingRequest,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { card: Release; link: import('./release-search-grouping.ts').ReleaseWorkLink }>>;
}): ReleaseGroupingSource<Work, Release> {
  const pools = [...input.pools];
  const context = input.context;
  const candidates = createReleaseSearchCandidateStreams({ pools, release: input.release, cut: input.cut, context });
  return {
    async observe(): Promise<ReleaseGroupingBasis> {
      return (await observeReleaseSearchCandidates(pools, context)).basis;
    },
    groups: candidates.groups,
    children: candidates.children,
    works: input.works,
    releases: input.releases,
  };
}
