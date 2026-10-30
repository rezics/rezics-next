import { type OpenSearch } from './opensearch.ts';
import { type HitResult, type SearchPlan, type SearchResult } from './query.ts';
import type { PublicRatingEpoch } from './rating-source.ts';
export type RatingQueryPlan = Pick<SearchPlan, 'query' | 'filter' | 'boost' | 'size' | 'after' | 'overflowProperties' | 'ratingPhase' | 'generation'> & {
    rating: PublicRatingEpoch;
};
/** Native hit-only phases share the ordinary immutable template and never issue a count request. */
export declare function searchRatingSubjectHits(search: OpenSearch, prefix: string, plan: RatingQueryPlan): Promise<HitResult>;
/** Search the native scored phase followed by its exact unscored complement on one pinned generation. */
export declare function searchRatingSubjects(search: OpenSearch, prefix: string, plan: RatingQueryPlan, templateId: string): Promise<SearchResult>;
