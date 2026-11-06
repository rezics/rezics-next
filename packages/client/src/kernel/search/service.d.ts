import { type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type FacetRequest } from './facets.ts';
import { type SearchFreshness } from './search-context.ts';
export { validateSearchLimit } from './hits.ts';
import { type OpenSearch } from './opensearch.ts';
import { type SearchPlan } from './query.ts';
import { type PublicRatingSource } from './rating-source.ts';
import type { RealmSubjectSource } from '../content/realm-subject-source.ts';
import type { RealmSubjectCapabilities } from './realm-scope.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { ScopeBasis } from './scope-source.ts';
import { type SavedCatalogueMembers } from './service-saved-collection.ts';
import type { SubjectSource } from './source.ts';
import type { SubjectCanonicalNames } from '../semantic/subject-source-key-pages.ts';
import { type DefaultPublicFilterRuntime } from './public-runtime.ts';
import type { PublicFilterConsumerJob } from './public-filter-consumer-contract.ts';
import type { PublicSearchHit } from './public-figures.ts';
import type { KindValue } from './query.ts';
import type { FacetDiscoveryProvider } from './facet-discovery-native.ts';
import type { FacetDiscovery200Response } from './facet-discovery-contract.ts';
import { type RealmRatingSource, type RealmRatingQuery } from './realm-rating-order.ts';
import { type MatchEvidence } from './match-evidence.ts';
import { type SuggestionWorkContext, type SuggestionWorkContextReader } from './suggestion-context.ts';
export type SearchRequest = {
    text?: string;
    filter?: unknown;
    sort?: SearchPlan['sort'];
    spoilerThreshold?: number;
    population?: {
        realm: string;
    };
    limit?: number;
    cursor?: string;
    kindCursor?: string;
    descriptions?: boolean;
    languages?: string[];
    properties?: string[];
};
export type GroupedReleaseSearchRequest = SearchRequest & {
    work?: string;
    childCursor?: string;
};
export type PublicSearchPage = {
    subjects: (PublicSearchHit & {
        matchEvidence: MatchEvidence;
    })[];
    kinds?: {
        values: KindValue[];
        next: string | null;
    };
    next: string | null;
    as_of: string;
    freshness?: SearchFreshness;
};
export type PublicSearchReadContext = Readonly<{
    deadline: number;
    /** The verified request context used only by the service-bound native Scope. */
    scope?: LeafOptions;
    realmAuthority?: RealmRatingQuery['authority'];
    /** Internal saved Collection read: retain its admitted meaning and bind continuation to its native identity. */
    savedCollection?: Readonly<{
        id: string;
        revision: number;
        ruleRevision: number;
        sourceGeneration: string;
        reader: Readonly<{
            minimumAuthnEpoch: string;
            operator: string;
        }>;
    }>;
    complete: (page: PublicSearchPage) => Promise<void>;
}>;
type Result = {
    id: string;
    type: string;
    labels: Record<string, string>;
    workContext?: SuggestionWorkContext;
};
export declare function bindSearchScopeCursorRequest(request: unknown, basis: ScopeBasis): unknown;
/** Classify the same bounded parser trees used by execution; never infer syntax from raw text. */
export declare function requiresAdvancedSearch(request: SearchRequest): boolean;
export declare function createSearchService({ pool, client, prefix, source, ratings, realmSubjects, realmSubjectsForReader, realmRatings, realmSubjectCapabilities, cursors, clock, facetSample, facetProvider, publicFilters, preparePublic, suggestionWorkContext, release: releaseOverride, }: {
    pool: Pool;
    client: OpenSearch;
    prefix: string;
    source: SubjectSource & Partial<{
        canonicalNames: SubjectCanonicalNames;
    }>;
    ratings?: PublicRatingSource;
    realmSubjects?: RealmSubjectSource;
    realmSubjectsForReader?: (reader: LeafOptions) => RealmSubjectSource | undefined;
    realmRatings?: RealmRatingSource;
    realmSubjectCapabilities?: RealmSubjectCapabilities;
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
    /** Optional batched handoff to the qualified work-context owner. */
    suggestionWorkContext?: SuggestionWorkContextReader;
}): {
    releaseGroups: (principal: 'anonymous' | `account:${string}`, submitted: GroupedReleaseSearchRequest, now?: number, active?: {
        digest: string;
        head?: number;
        release: FilterRelease;
    } | null, readContext?: PublicSearchReadContext) => Promise<{
        status: 'ready' | 'preparing';
        children: PublicSearchHit[];
        next: string | null;
        as_of: string;
    } | {
        status: 'ready' | 'preparing';
        groups: import("./release-search-cursor.ts").ReleaseSearchGroup<PublicSearchHit, PublicSearchHit>[];
        next: string | null;
        as_of: string;
    }>;
    savedCatalogueMembers: SavedCatalogueMembers;
    search(principal: 'anonymous' | `account:${string}`, request: SearchRequest, now?: number, active?: {
        digest: string;
        head?: number;
        release: FilterRelease;
    } | null, readContext?: PublicSearchReadContext): Promise<PublicSearchPage>;
    facets(principal: 'anonymous' | `account:${string}`, request: FacetRequest, now?: number, context?: {
        deadline: number;
        scope?: LeafOptions;
    }): Promise<FacetDiscovery200Response>;
    suggest(q: string, limit?: number, languages?: string[], read?: {
        deadline: number;
        filter?: unknown;
        scope?: LeafOptions;
        suggestionWorkContext?: SuggestionWorkContextReader;
        complete(page: {
            subjects: Result[];
            as_of: string;
        }): Promise<void>;
    }): Promise<Readonly<{
        subjects: (Result & Readonly<{
            workContext: SuggestionWorkContext;
        }>)[];
        as_of: string;
    }> | {
        subjects: {
            id: string;
            type: string;
            labels: Record<string, string>;
        }[];
        as_of: string;
    }>;
};
