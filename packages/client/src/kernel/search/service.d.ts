import { type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type FacetRequest } from './facets.ts';
export { validateSearchLimit } from './hits.ts';
import { type OpenSearch } from './opensearch.ts';
import { type SearchPlan } from './query.ts';
import { type PublicRatingSource } from './rating-source.ts';
import type { RealmSubjectSource } from './realm-scope.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { ScopeBasis } from './scope-source.ts';
import type { SubjectSource } from './source.ts';
import { type DefaultPublicFilterRuntime } from './public-runtime.ts';
import type { PublicFilterConsumerJob } from './public-filter-consumer-contract.ts';
import type { PublicSearchHit } from './public-figures.ts';
import type { KindValue } from './query.ts';
import type { FacetDiscoveryProvider } from './facet-discovery-native.ts';
import type { FacetDiscovery200Response } from './facet-discovery-contract.ts';
export type SearchRequest = {
    text?: string;
    filter?: unknown;
    sort?: SearchPlan['sort'];
    limit?: number;
    cursor?: string;
    kindCursor?: string;
    descriptions?: boolean;
    languages?: string[];
    properties?: string[];
};
export type PublicSearchPage = {
    subjects: PublicSearchHit[];
    kinds?: {
        values: KindValue[];
        next: string | null;
    };
    next: string | null;
    as_of: string;
};
export type PublicSearchReadContext = Readonly<{
    deadline: number;
    /** The verified request context used only by the service-bound native Scope. */
    scope?: LeafOptions;
    complete: (page: PublicSearchPage) => Promise<void>;
}>;
type Result = {
    id: string;
    type: string;
    labels: Record<string, string>;
};
export declare function bindSearchScopeCursorRequest(request: unknown, basis: ScopeBasis): unknown;
/** Classify the same bounded parser trees used by execution; never infer syntax from raw text. */
export declare function requiresAdvancedSearch(request: SearchRequest): boolean;
export declare function createSearchService({ pool, client, prefix, source, ratings, realmSubjects, cursors, clock, facetSample, facetProvider, publicFilters, preparePublic, release: releaseOverride, }: {
    pool: Pool;
    client: OpenSearch;
    prefix: string;
    source: SubjectSource;
    ratings?: PublicRatingSource;
    realmSubjects?: RealmSubjectSource;
    cursors: KeyRing;
    clock?: KernelClock;
    release?: () => Promise<FilterRelease | null>;
    /** Legacy preview helper tuning; never used by the public continuation path. */
    facetSample?: number;
    /** Trusted native provider; omitted only by historical isolated service fixtures. */
    publicFilters?: () => DefaultPublicFilterRuntime;
    preparePublic?: (job: PublicFilterConsumerJob) => Promise<void>;
    /** Trusted native owner composition. Missing native ports fail closed. */
    facetProvider?: () => Promise<FacetDiscoveryProvider | undefined>;
}): {
    search(principal: 'anonymous' | `account:${string}`, request: SearchRequest, now?: number, active?: {
        digest: string;
        release: FilterRelease;
    } | null, readContext?: PublicSearchReadContext): Promise<PublicSearchPage>;
    facets(principal: 'anonymous' | `account:${string}`, request: FacetRequest, now?: number, context?: {
        deadline: number;
    }): Promise<FacetDiscovery200Response>;
    suggest(q: string, limit?: number, languages?: string[], read?: {
        deadline: number;
        complete(page: {
            subjects: Result[];
            as_of: string;
        }): Promise<void>;
    }): Promise<{
        subjects: Result[];
        as_of: string;
    }>;
};
