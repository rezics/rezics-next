import type { DiscoveryFilterDocument, FilterDocument, FilterRelease, SpoilerThreshold } from '@rezics/filter';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { RealmSubjectSource } from '../content/realm-subject-source.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { SubjectCanonicalNames } from '../semantic/subject-source-key-pages.ts';
import type { SearchDisclosureApplication } from './disclosure-application.ts';
import type { FacetAccessObservationPort } from './facet-access-port.ts';
import type { FacetDiscoveryProvider } from './facet-discovery-native.ts';
import type { SearchFreshness } from './search-context.ts';
import type { RealmSubjectCapabilities } from './realm-scope.ts';
import type { SearchPlan } from './query.ts';
import type { PublicRatingSource } from './rating-source.ts';
import type { RealmRatingQuery, RealmRatingSource } from './realm-rating-order.ts';
import type { SearchLibraryScopePort } from './library-scope-port.ts';
import type { SubjectSource } from './source.ts';
import type { PublicFilterConsumerJob } from './public-filter-consumer-contract.ts';
import type { DefaultPublicFilterRuntime } from './public-runtime.ts';
import type { PublicSearchHit } from './public-figures.ts';
import type { KindValue } from './query.ts';
import type { MatchEvidence } from './match-evidence.ts';
import type { SuggestionWorkContext, SuggestionWorkContextReader } from './suggestion-context.ts';
import type { HitOptions } from './hits.ts';
import type { TextNode } from './text.ts';
import type { OpenSearch } from './opensearch.ts';
import type { AccountActor } from '../request/access.ts';
import type { FacetDiscovery200Response } from './facet-discovery-contract.ts';
import type { FacetRequest } from './facets.ts';
import type { ReleaseSearchChildrenResult, ReleaseSearchGroupsResult } from './release-search-source.ts';
export type SearchRequest = {
    text?: string;
    /** `credited_creator` matches `text` against names of Persons credited on works. */
    textField?: 'credited_creator';
    /** Same-credit released qualifiers; admitted only with `textField: 'credited_creator'`. */
    creditQualifiers?: readonly {
        property: string;
        value: string;
    }[];
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
export type SearchFilterDocument = FilterDocument | DiscoveryFilterDocument;
/** Parsed and admitted once at the Search service boundary. */
export type AdmittedSearchRequest = Readonly<{
    text?: TextNode;
    filter?: SearchFilterDocument;
    sort: SearchPlan['sort'];
    spoilerThreshold?: SpoilerThreshold;
    limit: number;
    hitOptions: HitOptions;
    /** Canonical request operands before the published identity epoch is added. */
    bindingRequest: Readonly<Record<string, unknown>>;
}>;
/** The one cursor request carried through execution after identity admission. */
export type ExecutedSearchRequest = Readonly<{
    admission: AdmittedSearchRequest;
    identityEpoch: string;
    bindingRequest: Readonly<Record<string, unknown>>;
}>;
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
export type SearchPrincipal = 'anonymous' | `account:${string}`;
/** A saved Collection page request owned by Library and executed through the installed Search service. */
export type SavedCatalogueMembersInput = Readonly<{
    actor: AccountActor;
    collection: NonNullable<PublicSearchReadContext['savedCollection']>;
    filter: FilterDocument;
    release: {
        digest: string;
        release: FilterRelease;
    };
    limit: number;
    cursor?: string | null;
    scope: NonNullable<PublicSearchReadContext['scope']>;
    revalidate: () => Promise<void>;
}>;
export type SavedCatalogueMembersPage = {
    members: {
        kind: 'dynamic';
        subjectId: string;
    }[];
    next: PublicSearchPage['next'];
};
export type SavedCatalogueMembers = (input: SavedCatalogueMembersInput) => Promise<SavedCatalogueMembersPage>;
/** Installed Search API shared by native consumers without coupling them to the factory implementation. */
export type SearchServiceContract = Readonly<{
    releaseGroups: (principal: SearchPrincipal, submitted: GroupedReleaseSearchRequest, now?: number, active?: {
        digest: string;
        head?: number;
        release: FilterRelease;
    } | null, readContext?: PublicSearchReadContext) => Promise<(ReleaseSearchChildrenResult & {
        as_of: string;
    }) | (ReleaseSearchGroupsResult & {
        as_of: string;
    })>;
    savedCatalogueMembers: SavedCatalogueMembers;
    search: (principal: SearchPrincipal, request: SearchRequest, now?: number, active?: {
        digest: string;
        head?: number;
        release: FilterRelease;
    } | null, readContext?: PublicSearchReadContext) => Promise<PublicSearchPage>;
    facets: (principal: SearchPrincipal, request: FacetRequest, now?: number, context?: {
        deadline: number;
        scope?: LeafOptions;
    }) => Promise<FacetDiscovery200Response>;
    suggest: (q: string, limit?: number, languages?: string[], read?: {
        deadline: number;
        filter?: unknown;
        scope?: LeafOptions;
        suggestionWorkContext?: SuggestionWorkContextReader;
        complete(page: {
            subjects: SearchResult[];
            as_of: string;
        }): Promise<void>;
    }) => Promise<Readonly<{
        subjects: (SearchResult & Readonly<{
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
}>;
export type SearchServiceOptions = Readonly<{
    pool: Pool;
    disclosure?: SearchDisclosureApplication;
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
    /** Composition-bound Access observation for scoped Collection/Realm facet execution. */
    facetAccess?: FacetAccessObservationPort;
    /** Constructed Library capability retained by this service's scoped applications. */
    library?: SearchLibraryScopePort;
}>;
export type SearchResult = {
    id: string;
    type: string;
    labels: Record<string, string>;
    workContext?: SuggestionWorkContext;
};
export type SearchPageParts = Omit<PublicSearchPage, 'subjects'> & {
    subjects: PublicSearchPage['subjects'];
};
