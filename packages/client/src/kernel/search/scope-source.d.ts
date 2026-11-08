import { type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { CollectionSourceObservation, NativeSourceIdentity } from '../library/contract/index.ts';
import type { NativeOrdinalKey } from '../library/contract/index.ts';
import { type SearchScopeOrder, type SearchScopeOrdinalPrefix } from './service-scope-order.ts';
import type { LeafOptions, LeafProgress, LeafWork } from '../semantic/scope-leaf-evidence.ts';
import { type ScopeLeafPosition } from './scope-progress.ts';
import type { OpenSearch } from './opensearch.ts';
import type { CataloguePublicationObservation } from './catalogue-publication.ts';
import type { SearchHit } from './query.ts';
import { type PreparedRealmScope, type RealmSubjectCapabilities } from './realm-scope.ts';
import type { RealmSubjectSource } from '../content/realm-subject-source.ts';
import { type IndexedSubject, type RelationFacetMatch, type SubjectSource } from './source.ts';
import type { SearchLibraryScopePort } from './library-scope-port.ts';
import { type ScopeNameSortTuple, type ScopeNativeOrder, type ScopeOrderedPrefixRequest, type SearchScopeOrderedPrefix } from './scope-ordered.ts';
export type { ScopeNativeOrder, ScopeNameSortTuple, ScopeCollectionsSortTuple, ScopeOrderedPrefixRequest, SearchScopeOrderedPrefix, } from './scope-ordered.ts';
/** Independent native work reservation; none of these units are candidate keys. */
export type ScopeNativeBudget = Omit<LeafWork, 'keys'>;
/** One unfinished original/leaf; basis is the composite owner digest, never a native leaf basis. */
export type ScopeEvaluationProgress = Readonly<{
    subject: string;
    basis: string;
}> & Pick<NonNullable<ScopeLeafPosition>, 'leafOrdinal'> & Omit<LeafProgress, 'basis'>;
export type ScopeEvaluationReservation = Readonly<{
    /** Explicit remaining allowance in the caller's shared raw-key ledger, including alias and prefix work. */
    rawKeys: number;
    native: ScopeNativeBudget;
    progress?: ScopeEvaluationProgress | null;
    allowance?: WorkAllowance;
}>;
export type ScopeBasis = Readonly<{
    release: string;
    query: string;
    profile: string;
    canonical: string;
    publicCatalogue?: CataloguePublicationObservation;
}> & (Readonly<{
    generation: number;
    index: string;
    nativeOwner?: never;
}> | Readonly<{
    nativeOwner: Readonly<{
        source: NativeSourceIdentity;
        observation: CollectionSourceObservation;
    }>;
    generation?: never;
    index?: never;
}>);
/** Additive preparation controls; future metadata-budget fields belong on this same options object. */
export type ScopePrepareOptions = Readonly<{
    releaseDigest?: string;
    order?: SearchScopeOrder;
    /** Immutable native output definition; separate from structural Collection traversal. */
    nativeOrder?: ScopeNativeOrder;
    /** Required with nativeOrder, together with an explicit caller allowance. */
    pageSize?: number;
    /** Native caller's shared root; omitted legacy calls retain the bounded compatibility ceilings. */
    allowance?: WorkAllowance;
    /** Read an already published scope without retaining, preparing or saving reader progress. */
    readOnly?: boolean;
    /** Exact released projection type, when the source requires a selected catalogue profile. */
    type?: string;
}>;
declare const preparedScope: unique symbol;
/** Factory-local opaque state, never an Access or bearer allow claim. */
export type PreparedSearchScope = {
    readonly [preparedScope]: true;
    readonly readiness: 'ready';
    readonly basis: ScopeBasis;
};
export type SearchScopePrefix = {
    hits: readonly SearchHit[];
    basis: ScopeBasis;
    /** Last covered raw key, excluding unused lookahead; null only at the beginning. */
    coveredThrough: string | null;
    exhausted: boolean;
    usage: {
        candidates: number;
        work?: import('../library/contract/work-dimensions.ts').WorkReceipt;
    };
};
export type SearchScopeEvaluation = {
    values: readonly RelationFacetMatch[];
    basis: ScopeBasis;
    usage: {
        keys: number;
        native: ScopeNativeBudget;
    };
    /** Native evidence references for final current revalidation, never allow tokens. */
    evidence: readonly string[];
    progress: ScopeEvaluationProgress | null;
};
/** Native service runtime, immutable admission and factory-local handles. Native producers
 * own structural capture, current authorization and evidence; this module owns execution.
 */
export declare function createSearchScopeSource({ pool, client, prefix, source: _source, release, realmRelease, evidence, realmSubjects, realmSubjectCapabilities, clock, library, }: {
    pool: Pool;
    client: OpenSearch;
    prefix: string;
    source: SubjectSource;
    release?: () => Promise<FilterRelease | null>;
    realmRelease?: (digest?: string) => Promise<Readonly<{
        digest: string;
        release: FilterRelease;
    }> | null>;
    evidence?: LeafOptions;
    realmSubjects?: RealmSubjectSource;
    realmSubjectCapabilities?: RealmSubjectCapabilities;
    clock?: KernelClock;
    library?: SearchLibraryScopePort;
}): {
    realm: {
        realms(scope: PreparedRealmScope): readonly string[];
        prepare(filter: import("@rezics/filter").DiscoveryFilterDocument, allowance: WorkAllowance, expectedReleaseDigest?: string): Promise<Readonly<{
            scope: PreparedRealmScope;
            work: WorkReceipt;
        }>>;
        sourcePrefix(scope: PreparedRealmScope, realm: string, after: string | null, limit: number, allowance: WorkAllowance): Promise<{
            basis: string;
            work: WorkReceipt;
            subjects: readonly string[];
            after: string | null;
            exhausted: boolean;
        }>;
        evaluate(scope: PreparedRealmScope, subjects: readonly string[], allowance: WorkAllowance): Promise<{
            basis: string;
            values: RelationFacetMatch[];
            work: WorkReceipt;
        }>;
        refinePrefix(scope: PreparedRealmScope, frontier: import("./realm-scope.ts").RealmRefinementFrontier | null, allowance: WorkAllowance): Promise<Readonly<{
            readiness: 'refined_input';
            basis: string;
            subjects: readonly string[];
            frontier: import("./realm-scope.ts").RealmRefinementFrontier | null;
            exhausted: boolean;
            work: WorkReceipt;
        }>>;
        revalidate(scope: PreparedRealmScope, allowance: WorkAllowance): Promise<WorkReceipt>;
        searchBasis: (prepared: PreparedRealmScope, request: {
            text?: string;
            textQuery?: Record<string, unknown>;
            textBoost?: string;
            generation: number;
            indexUuid: string;
        }) => ScopeBasis;
        searchPage: (prepared: PreparedRealmScope, request: {
            basis: ScopeBasis;
            text?: string;
            textQuery?: Record<string, unknown>;
            textBoost?: string;
            generation: number;
            indexUuid: string;
            after: ScopeNameSortTuple | null;
            quota: number;
            allowance: WorkAllowance;
        }) => Promise<{
            status: 'preparing';
            basis: ScopeBasis;
            work: WorkReceipt;
            hits?: never;
            subjects?: never;
            after?: never;
            exhausted?: never;
        } | {
            status: 'ready';
            basis: ScopeBasis;
            hits: SearchHit[];
            subjects: IndexedSubject[];
            after: ScopeNameSortTuple | null;
            exhausted: boolean;
            work: WorkReceipt;
        }>;
    };
    /** Additive native caller accounting; opaque result shapes and the legacy evaluation ABI stay unchanged. */
    work(result: PreparedSearchScope | SearchScopeEvaluation): WorkReceipt;
    prepare(filter: FilterDocument, options?: ScopePrepareOptions): Promise<PreparedSearchScope>;
    orderedPrefix(prepared: PreparedSearchScope, request: ScopeOrderedPrefixRequest): Promise<SearchScopeOrderedPrefix>;
    prefix(prepared: PreparedSearchScope, request: {
        afterSubject: string | null;
        quota: number;
        budget: number;
        allowance?: WorkAllowance;
    }): Promise<SearchScopePrefix>;
    evaluate(prepared: PreparedSearchScope, subjects: readonly string[], reservation: ScopeEvaluationReservation): Promise<SearchScopeEvaluation>;
    sourcePrefix(prepared: PreparedSearchScope, request: {
        afterSubjectId: string | null;
        allowance: WorkAllowance;
        candidateLimit?: number;
    }): Promise<{
        kind: 'canonical_subject_prefix';
        candidates: readonly import("../library/collection-source.ts").CanonicalCollectionCandidate[];
        coveredThrough: string | null;
        exhausted: boolean;
        observation: CollectionSourceObservation;
        basis: ScopeBasis;
        work: WorkReceipt;
    }>;
    /** Raw native ordinal input, CURRENT canonical membership and native fact evidence are
     * consumed in order. This direct preview never truncates raw rows then post-sorts them.
     */
    ordinalPrefix(prepared: PreparedSearchScope, request: {
        after: NativeOrdinalKey | null;
        quota: number;
        allowance: WorkAllowance;
    }): Promise<SearchScopeOrdinalPrefix>;
};
